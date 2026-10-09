// Unit tests for hooks/hook-result.js: the per-agent block form.
//   node hooks/hook-result.test.js
// Runs each blocking hook with a Codex-shaped input (turn_id present) and
// checks for exit 0 plus the JSON decision on stdout; then the same input
// without turn_id must still give stderr and exit 2 (Claude Code, agy).
// Exits 1 if any case fails.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-result-test-'));
const EM = '\u2014';

// A Codex rollout with one apply_patch write and no NOTES.md (notes-stop reminds).
const rollout = path.join(tmp, 'rollout.jsonl');
fs.writeFileSync(
  rollout,
  JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** End Patch' } }) + '\n',
  'utf8'
);

const codex = { session_id: 's', turn_id: 't1', cwd: tmp, model: 'm', permission_mode: 'default' };

// [label, hook file, payload, expected stdout JSON check]
const cases = [
  [
    'no-shell-edits: Codex Set-Content gets a JSON deny',
    'no-shell-edits.js',
    { ...codex, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'Set-Content C:\\GIT\\x.md x' } },
    (o) => o.hookSpecificOutput && o.hookSpecificOutput.hookEventName === 'PreToolUse' && o.hookSpecificOutput.permissionDecision === 'deny' && /Blocked by agent-os/.test(o.hookSpecificOutput.permissionDecisionReason),
  ],
  [
    'no-em-dash: Codex apply_patch gets a JSON block',
    'no-em-dash.js',
    { ...codex, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: C:/GIT/a.md\n+alpha' + EM + 'beta\n*** End Patch' } },
    (o) => o.decision === 'block' && /non-ASCII punctuation written to C:\/GIT\/a\.md/.test(o.reason),
  ],
  [
    'notes-stop: Codex Stop gets a JSON block',
    'notes-stop.js',
    { ...codex, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: rollout, last_assistant_message: 'ok' },
    (o) => o.decision === 'block' && /NOTES\.md/.test(o.reason),
  ],
  [
    'claims-stop: Codex Stop gets a JSON block',
    'claims-stop.js',
    { ...codex, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: null, last_assistant_message: 'The fix is deployed.' },
    (o) => o.decision === 'block' && /CLAIM WITHOUT PROOF/.test(o.reason),
  ],
];

let failed = 0;
let total = 0;
function report(ok, label, detail) {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  ' + detail}`);
}

for (const [label, file, payload, check] of cases) {
  const env = { ...process.env };
  delete env.CLAUDE_OS_SKIP_NOTES_HOOK;
  delete env.AGENT_OS_SKIP_NOTES_HOOK;
  delete env.CLAUDE_OS_SKIP_CLAIMS_HOOK;
  delete env.AGENT_OS_SKIP_CLAIMS_HOOK;
  const hook = path.join(__dirname, file);

  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf8', env });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (e) { /* reported below */ }
  report(r.status === 0 && parsed && check(parsed) && !r.stderr, label, `exit=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);

  // Same input without turn_id: the Claude Code path, unchanged.
  const claude = { ...payload };
  delete claude.turn_id;
  const c = spawnSync(process.execPath, [hook], { input: JSON.stringify(claude), encoding: 'utf8', env });
  report(c.status === 2 && c.stderr.length > 0 && c.stdout === '', `${file}: without turn_id stays stderr + exit 2`, `exit=${c.status} stdout=${JSON.stringify(c.stdout)}`);
}

// An allowed Codex command prints nothing and exits 0 (no stray JSON).
const allow = spawnSync(process.execPath, [path.join(__dirname, 'no-shell-edits.js')], {
  input: JSON.stringify({ ...codex, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'Get-Date' } }),
  encoding: 'utf8',
});
report(allow.status === 0 && allow.stdout === '' && allow.stderr === '', 'no-shell-edits: Codex Get-Date is silent', `exit=${allow.status} stdout=${JSON.stringify(allow.stdout)}`);

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
