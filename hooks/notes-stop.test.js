// Unit tests for hooks/notes-stop.js.
//   node hooks/notes-stop.test.js
// Builds small fake transcripts (JSONL, one message per line) in a temp
// folder, feeds each Stop payload to the hook on stdin, and checks the exit
// code: 2 = reminder, 0 = silent. Exits 1 if any case fails.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hook = path.join(__dirname, 'notes-stop.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-stop-test-'));

function toolUse(name, input) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] } });
}
function textMsg(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
}
function transcript(name, lines) {
  const p = path.join(tmp, name + '.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

const readOnly = transcript('read-only', [textMsg('hi'), toolUse('Read', { file_path: 'a.md' }), toolUse('Bash', { command: 'git status' })]);
const wroteNoNotes = transcript('wrote-no-notes', [textMsg('hi'), toolUse('Edit', { file_path: 'C:\\repo\\src\\a.ts', old_string: 'a', new_string: 'b' })]);
const wroteNotes = transcript('wrote-notes', [toolUse('Write', { file_path: 'C:\\repo\\x.py', content: '' }), toolUse('Edit', { file_path: 'C:\\repo\\NOTES.md', old_string: 'a', new_string: 'b' })]);
const wroteNotesLower = transcript('wrote-notes-lower', [toolUse('Write', { file_path: '/repo/notes.md', content: '' })]);
const notebook = transcript('notebook', [toolUse('NotebookEdit', { notebook_path: '/repo/a.ipynb', new_source: 'x' })]);
const junkLines = transcript('junk', ['not json', '', toolUse('Write', { file_path: 'a.sql', content: '' })]);
const wroteHeadHandoff = transcript('head-handoff', [toolUse('Edit', { file_path: 'C:\\git\\fleet-wt-devhead\\src\\a.java', old_string: 'a', new_string: 'b' }), toolUse('Edit', { file_path: 'C:\\git\\fleet-wt-devhead\\docs\\orchestration\\HANDOFF-devhead.md', old_string: 'a', new_string: 'b' })]);
const wroteRootHandoff = transcript('root-handoff', [toolUse('Write', { file_path: 'C:/git/fleet-wt-worker7/handoff.md', content: '' })]);
const handoffDirOnly = transcript('handoff-dir', [toolUse('Write', { file_path: 'C:\\repo\\handoff\\plan.md', content: '' })]);
const handoffInName = transcript('handoff-in-name', [toolUse('Write', { file_path: 'C:\\repo\\my-handoff.md', content: '' })]);

// [label, expected exit, payload]
const cases = [
  ['read-only session stops quietly', 0, { transcript_path: readOnly }],
  ['file work without NOTES.md gets the reminder', 2, { transcript_path: wroteNoNotes }],
  ['NOTES.md edited: quiet', 0, { transcript_path: wroteNotes }],
  ['notes.md lowercase path: quiet', 0, { transcript_path: wroteNotesLower }],
  ['NotebookEdit counts as file work', 2, { transcript_path: notebook }],
  ['junk lines are skipped, write still counts', 2, { transcript_path: junkLines }],
  ['HANDOFF-<head>.md edited: quiet', 0, { transcript_path: wroteHeadHandoff }],
  ['handoff.md lowercase at a worktree root: quiet', 0, { transcript_path: wroteRootHandoff }],
  ['a folder named handoff does not count', 2, { transcript_path: handoffDirOnly }],
  ['handoff mid-name does not count', 2, { transcript_path: handoffInName }],
  ['stop_hook_active short-circuits', 0, { transcript_path: wroteNoNotes, stop_hook_active: true }],
  ['missing transcript_path: quiet', 0, {}],
  ['transcript file does not exist: quiet', 0, { transcript_path: path.join(tmp, 'nope.jsonl') }],
];

// Codex rollouts: apply_patch as its own tool call, or inside the JS of the
// "exec" tool (the shape 0.154+ writes, seen 2026-09-29), with the patch's
// newlines escaped as \n inside a JS string.
function codexCall(type, name, input) {
  return JSON.stringify({ type: 'response_item', payload: { type, name, input } });
}
const cxReadOnly = transcript('cx-read-only', [codexCall('custom_tool_call', 'exec', 'text(await tools.exec_command({cmd:"ls"}));')]);
const cxPatch = transcript('cx-patch', [codexCall('custom_tool_call', 'apply_patch', '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch')]);
const cxPatchNotes = transcript('cx-patch-notes', [codexCall('custom_tool_call', 'apply_patch', '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Update File: NOTES.md\n@@\n+entry\n*** End Patch')]);
const cxExecPatch = transcript('cx-exec-patch', [codexCall('custom_tool_call', 'exec', 'await tools.apply_patch("*** Begin Patch\\n*** Add File: src/b.py\\n+x\\n*** End Patch");')]);
const cxExecNotes = transcript('cx-exec-notes', [codexCall('custom_tool_call', 'exec', 'await tools.apply_patch("*** Begin Patch\\n*** Add File: src/b.py\\n+x\\n*** Update File: docs/NOTES.md\\n+y\\n*** End Patch");')]);
// Antigravity (best effort until a real transcript is read).
const agyWrite = transcript('agy-write', [JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'C:\\repo\\a.ts', CodeContent: 'x' } }] })]);
const agyNotes = transcript('agy-notes', [JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'C:\\repo\\a.ts' } }, { name: 'replace_file_content', args: { TargetFile: 'C:\\repo\\NOTES.md' } }] })]);
cases.push(
  ['codex: shell-only session is quiet', 0, { transcript_path: cxReadOnly }],
  ['codex: apply_patch without NOTES.md reminds', 2, { transcript_path: cxPatch }],
  ['codex: apply_patch touching NOTES.md is quiet', 0, { transcript_path: cxPatchNotes }],
  ['codex: patch inside exec reminds', 2, { transcript_path: cxExecPatch }],
  ['codex: patch inside exec touching NOTES.md is quiet', 0, { transcript_path: cxExecNotes }],
  ['agy: write_to_file without NOTES.md reminds', 2, { transcript_path: agyWrite }],
  ['agy: replace_file_content on NOTES.md is quiet', 0, { transcript_path: agyNotes }],
);

let failed = 0;
for (const [label, expect, payload] of cases) {
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf8' });
  const ok = r.status === expect;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  exit=${r.status} expect=${expect}  ${label}`);
  if (ok && expect === 2 && !/NOTES\.md/.test(r.stderr)) {
    failed++;
    console.log(`FAIL  stderr lacks the reminder for: ${label}`);
  }
}

const bad = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8' });
const badOk = bad.status === 0;
if (!badOk) failed++;
console.log(`${badOk ? 'PASS' : 'FAIL'}  exit=${bad.status} expect=0  malformed stdin is quiet`);

// A headless runner opts out with CLAUDE_OS_SKIP_NOTES_HOOK=1; any other value keeps the reminder.
const envOn = spawnSync(process.execPath, [hook], {
  input: JSON.stringify({ transcript_path: wroteNoNotes }), encoding: 'utf8',
  env: Object.assign({}, process.env, { CLAUDE_OS_SKIP_NOTES_HOOK: '1' }),
});
const envOnOk = envOn.status === 0;
if (!envOnOk) failed++;
console.log(`${envOnOk ? 'PASS' : 'FAIL'}  exit=${envOn.status} expect=0  CLAUDE_OS_SKIP_NOTES_HOOK=1 is quiet`);
const envOff = spawnSync(process.execPath, [hook], {
  input: JSON.stringify({ transcript_path: wroteNoNotes }), encoding: 'utf8',
  env: Object.assign({}, process.env, { CLAUDE_OS_SKIP_NOTES_HOOK: '0' }),
});
const envOffOk = envOff.status === 2;
if (!envOffOk) failed++;
console.log(`${envOffOk ? 'PASS' : 'FAIL'}  exit=${envOff.status} expect=2  CLAUDE_OS_SKIP_NOTES_HOOK=0 still reminds`);

// An orchestrator opts out per project with a file .claude/skip-notes-hook in the
// session's cwd; the payload's cwd wins, the process cwd is the fallback, and a
// directory of that name does not count.
const marked = path.join(tmp, 'marked');
fs.mkdirSync(path.join(marked, '.claude'), { recursive: true });
fs.writeFileSync(path.join(marked, '.claude', 'skip-notes-hook'), '', 'utf8');
const unmarked = path.join(tmp, 'unmarked');
fs.mkdirSync(path.join(unmarked, '.claude'), { recursive: true });
const dirMarker = path.join(tmp, 'dir-marker');
fs.mkdirSync(path.join(dirMarker, '.claude', 'skip-notes-hook'), { recursive: true });
const markerCases = [
  ['marker file in payload cwd: quiet', 0, { transcript_path: wroteNoNotes, cwd: marked }, unmarked],
  ['no marker in payload cwd: still reminds', 2, { transcript_path: wroteNoNotes, cwd: unmarked }, marked],
  ['no payload cwd: marker in process cwd is quiet', 0, { transcript_path: wroteNoNotes }, marked],
  ['a directory named skip-notes-hook does not count', 2, { transcript_path: wroteNoNotes, cwd: dirMarker }, unmarked],
];
for (const [label, expect, payload, cwd] of markerCases) {
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf8', cwd });
  const ok = r.status === expect;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  exit=${r.status} expect=${expect}  ${label}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
const total = cases.length + 3 + markerCases.length;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
