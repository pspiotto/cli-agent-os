// Unit tests for hooks/agy-hook.js.
//   node hooks/agy-hook.test.js
// Feeds agy-shaped payloads (the shapes a live agy 1.2.14 run sent on
// 2026-09-30) to the adapter and checks the JSON decision it prints. Exits 1
// if any case fails.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hook = path.join(__dirname, 'agy-hook.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hook-test-'));
const EM = '\u2014';

const common = {
  conversationId: 'b41ff90f-6b7b-4f87-9153-6a8bfee67372',
  modelName: 'gemini-3.8-flash-high',
  workspacePaths: [tmp.replace(/\\/g, '/')],
};
function pre(name, args) {
  return Object.assign({ stepIdx: 2, toolCall: { name, args } }, common);
}
function transcript(name, records) {
  const p = path.join(tmp, name + '.jsonl');
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}
function planner(content, toolCalls) {
  const r = { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE' };
  if (content) r.content = content;
  if (toolCalls) r.tool_calls = toolCalls;
  return r;
}
function stop(transcriptPath, executionNum) {
  return Object.assign({ executionNum: executionNum || 0, fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '', transcriptPath }, common);
}

const wrote = transcript('wrote', [planner(null, [{ name: 'write_to_file', args: { TargetFile: 'C:\\r\\a.ts', CodeContent: 'x' } }]), planner('Updated a.ts: `exit 0`.')]);
const wroteNotes = transcript('wrote-notes', [planner(null, [{ name: 'write_to_file', args: { TargetFile: 'C:\\r\\a.ts' } }, { name: 'replace_file_content', args: { TargetFile: 'C:\\r\\NOTES.md' } }]), planner('Fixed.')]);
const readOnlyClaim = transcript('read-only-claim', [planner(null, [{ name: 'view_file', args: { AbsolutePath: 'C:\\r\\a.ts' } }]), planner('Verified.')]);
const readOnlyProved = transcript('read-only-proved', [planner('Verified: `16/16 passed`.')]);

// [label, event, payload, expected decision (undefined = no decision key)]
const cases = [
  ['run_command, ordinary: ask', 'PreToolUse', pre('run_command', { CommandLine: 'git status', Cwd: tmp }), 'ask'],
  ['run_command, sed -i: deny', 'PreToolUse', pre('run_command', { CommandLine: 'sed -i s/a/b/ x.ts' }), 'deny'],
  ['run_command, Set-Content: deny', 'PreToolUse', pre('run_command', { CommandLine: "Set-Content a.txt 'x'" }), 'deny'],
  ['write_to_file clean: ask', 'PreToolUse', pre('write_to_file', { TargetFile: 'C:\\r\\a.md', CodeContent: 'hello\n', Overwrite: true }), 'ask'],
  ['write_to_file em dash in .md: deny', 'PreToolUse', pre('write_to_file', { TargetFile: 'C:\\r\\a.md', CodeContent: `a ${EM} b` }), 'deny'],
  ['replace_file_content em dash: deny', 'PreToolUse', pre('replace_file_content', { TargetFile: 'C:\\r\\a.md', TargetContent: 'hello', ReplacementContent: `a ${EM} b`, StartLine: 1, EndLine: 1 }), 'deny'],
  ['replace_file_content removing an em dash: ask', 'PreToolUse', pre('replace_file_content', { TargetFile: 'C:\\r\\a.md', TargetContent: `a ${EM} b`, ReplacementContent: 'a - b' }), 'ask'],
  ['multi_replace chunk with em dash: deny', 'PreToolUse', pre('multi_replace_file_content', { TargetFile: 'C:\\r\\a.md', ReplacementChunks: [{ ReplacementContent: 'ok' }, { ReplacementContent: `x ${EM} y` }] }), 'deny'],
  ['view_file: ask', 'PreToolUse', pre('view_file', { AbsolutePath: 'C:\\r\\a.md' }), 'ask'],
  ['malformed PreToolUse still decides: ask', 'PreToolUse', 'not json', 'ask'],
  ['stop after writes without NOTES.md: continue', 'Stop', stop(wrote), 'continue'],
  ['stop after NOTES.md, bare claim: continue (claims)', 'Stop', stop(wroteNotes), 'continue'],
  ['stop, read-only, bare claim: continue (claims)', 'Stop', stop(readOnlyClaim), 'continue'],
  ['stop, read-only, proved claim: no decision', 'Stop', stop(readOnlyProved), undefined],
  ['stop already continued once (executionNum 1): no decision', 'Stop', stop(wrote, 1), undefined],
  ['stop without transcript: no decision', 'Stop', stop(null), undefined],
  ['unknown event: no decision', 'PreInvocation', { invocationNum: 1 }, undefined],
];

let failed = 0;
for (const [label, event, payload, expect] of cases) {
  const r = spawnSync(process.execPath, [hook, event], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_OS_SKIP_NOTES_HOOK: '', CLAUDE_OS_SKIP_CLAIMS_HOOK: '' }),
  });
  let got;
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
    got = parsed.decision;
  } catch (err) {
    got = '<unparseable: ' + JSON.stringify(r.stdout) + '>';
  }
  let ok = r.status === 0 && got === expect;
  if (ok && (expect === 'deny' || expect === 'continue') && !(parsed.reason && parsed.reason.length > 20)) ok = false;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  decision=${got} expect=${expect}  ${label}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
