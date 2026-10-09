// Unit tests for hooks/claims-stop.js.
//   node hooks/claims-stop.test.js
// Builds small fake transcripts (JSONL, one message per line) in a temp
// folder, feeds each Stop payload to the hook on stdin, and checks the exit
// code: 2 = blocked (a bare claim), 0 = the session may end. Exits 1 if any
// case fails. The false-positive cases (negated, quoted, interrogative,
// inside a path or branch name, conditional) are the ones that decide whether
// the hook survives; each is named.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hook = path.join(__dirname, 'claims-stop.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-stop-test-'));

function assistantText(text) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}
function assistantTool(name, input) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] } });
}
function userText(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
}
// Claude Code appends bookkeeping lines after the last assistant message.
const trailer = [JSON.stringify({ type: 'last-prompt' }), JSON.stringify({ type: 'mode' })];

let n = 0;
function transcript(lines) {
  const p = path.join(tmp, 'case-' + (++n) + '.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}
// A session whose final assistant text is `text`.
function endingWith(text) {
  return transcript([userText('go'), assistantTool('Read', { file_path: 'a.md' }), assistantText(text)].concat(trailer));
}

// [label, expected exit, final assistant text]
const textCases = [
  // --- bare claims: blocked ---
  ['bare "Fixed."', 2, 'Fixed.'],
  ['"Done." plus a deployed claim', 2, 'Done. The hook is deployed on all four machines.'],
  ['"Verified" with no output quoted', 2, 'Verified the install works as expected.'],
  ['"All tests pass" bare', 2, 'All tests pass.'],
  ['"working now" bare', 2, 'The status line is working now.'],
  ['"Merged" with no sha', 2, 'Merged to main and pushed.'],
  ['"Root-caused" bare', 2, 'Root-caused: the config was wrong.'],
  ['"Confirmed." alone', 2, 'Confirmed.'],
  ['"Released" bare', 2, 'Released 0.4.4 to the marketplace.'],
  ['a backticked name is not proof', 2, 'Fixed `install.ps1`.'],
  ['a markdown heading is still a claim', 2, '## Done\n\nEverything is in place.'],

  // --- proved claims: pass ---
  ['pass count clears it', 0, 'Fixed: `passed: 31  failed: 0`.'],
  ['N passed clears it', 0, 'Verified. `16/16 passed`.'],
  ['path with line number clears it', 0, 'Fixed in `hooks/notes-stop.js:42`.'],
  ['bare path with line number clears it', 0, 'Fixed in hooks/notes-stop.js:42.'],
  ['7-char sha clears it', 0, 'Merged as `23494b4`.'],
  ['40-char sha clears it', 0, 'Deployed at 5846f43a9c0d1e2f3b4a5c6d7e8f9a0b1c2d3e4f.'],
  ['fenced block clears it', 0, 'Done.\n\n```\n$ git push\n0feaf49..61a23da  main -> main\n```'],
  ['quoted output line with spaces clears it', 0, 'Confirmed: `skills : 4 file(s) copied`.'],
  ['"unverified" downgrade clears it', 0, 'Fixed, unverified: no run since the change.'],
  ['"not run" downgrade clears it', 0, 'Done. The live check was not run.'],
  ['"hypothesis" downgrade clears it', 0, 'Root-caused, hypothesis: the AutoRun key; test with reg query.'],
  ['"inferred" downgrade clears it', 0, 'Deployed (inferred from the timestamp).'],

  // --- false-positive guards: pass ---
  ['negated: "not verified"', 0, 'Not verified yet.'],
  ['negated: "is not done"', 0, 'This is not done.'],
  ['negated: "nothing is fixed"', 0, 'Nothing is fixed yet.'],
  ['negated: contraction "isn\'t fixed"', 0, 'It isn\'t fixed.'],
  ['negated: "never merged"', 0, 'That branch was never merged.'],
  ['interrogative: "is it fixed?"', 0, 'Is it fixed?'],
  ['interrogative with a claim word mid-sentence', 0, 'Should I mark this as done?'],
  ['quoted rule text (double quotes)', 0, 'The rule says "never write done, fixed, verified" without proof.'],
  ['quoted single word (single quotes)', 0, 'The word \'verified\' is on the list.'],
  ['claim word in a branch name', 0, 'Branch fix/verified-paths is checked out.'],
  ['claim word in a file name', 0, 'Edited done.md and merged.txt.'],
  ['claim word in a Windows path', 0, 'See C:\\repo\\fixed\\notes.txt for the log.'],
  ['claim word inside an inline code span', 0, 'The script prints `done` at the end.'],
  ['claim word only inside a fenced block', 0, 'Output so far:\n\n```\nfixed 3 files\n```'],
  ['claim word in a blockquote', 0, '> verified\n\nThat is the line the reviewer wrote.'],
  ['conditional: "once ... is done"', 0, 'Run the tests once the build is done.'],
  ['conditional: "when merged"', 0, 'When merged, the hook goes live.'],
  ['future: "will be fixed"', 0, 'The hook will be fixed in W2-1.'],
  ['obligation: "needs to be verified"', 0, 'The banner needs to be verified in a fresh TUI.'],
  ['no claim word at all', 0, 'Reading the file now.'],
  ['empty final text', 0, '   '],
];

// [label, expected exit, payload]
const cases = textCases.map(([label, expect, text]) => [label, expect, { transcript_path: endingWith(text) }]);

// Only the LAST assistant text is judged.
const bareThenSafe = transcript([assistantText('Fixed.'), assistantTool('Bash', { command: 'ls' }), assistantText('Reading the file now.')]);
const safeThenBare = transcript([assistantText('Reading the file now.'), assistantTool('Bash', { command: 'ls' }), assistantText('Fixed.')]);
const bareThenTrailer = transcript([assistantText('Fixed.')].concat(trailer));
const noAssistant = transcript([userText('hi'), JSON.stringify({ type: 'mode' })]);
const junk = transcript(['not json', '', assistantText('Fixed.')]);
cases.push(
  ['earlier bare claim, later safe text: quiet', 0, { transcript_path: bareThenSafe }],
  ['earlier safe text, later bare claim: blocked', 2, { transcript_path: safeThenBare }],
  ['bookkeeping lines after the claim do not hide it', 2, { transcript_path: bareThenTrailer }],
  ['no assistant text at all: quiet', 0, { transcript_path: noAssistant }],
  ['junk lines are skipped, claim still seen', 2, { transcript_path: junk }],
  ['stop_hook_active short-circuits', 0, { transcript_path: endingWith('Fixed.'), stop_hook_active: true }],
  ['missing transcript_path: quiet', 0, {}],
  ['transcript file does not exist: quiet', 0, { transcript_path: path.join(tmp, 'nope.jsonl') }],
);

// Codex: last_assistant_message in the payload, transcript_path possibly null,
// and its rollout JSONL when the message is absent.
function codexAssistant(text) {
  return JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
}
const codexRollout = transcript([
  JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }),
  codexAssistant('Reading the file now.'),
  JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'text(1)' } }),
  codexAssistant('Merged to main.'),
  JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Merged to main.' } }),
]);
cases.push(
  ['codex: bare claim in last_assistant_message, null transcript', 2, { last_assistant_message: 'Fixed.', transcript_path: null }],
  ['codex: proved claim in last_assistant_message', 0, { last_assistant_message: 'Fixed: `passed: 12`.', transcript_path: null }],
  ['codex: last_assistant_message wins over the transcript', 0, { last_assistant_message: 'Reading now.', transcript_path: endingWith('Fixed.') }],
  ['codex: rollout transcript when the message is absent', 2, { transcript_path: codexRollout }],
  ['codex: stop_hook_active still short-circuits', 0, { last_assistant_message: 'Fixed.', stop_hook_active: true }],
);

let failed = 0;
for (const [label, expect, payload] of cases) {
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf8' });
  const ok = r.status === expect;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  exit=${r.status} expect=${expect}  ${label}`);
  if (ok && expect === 2 && !/CLAIM WITHOUT PROOF/.test(r.stderr)) {
    failed++;
    console.log(`FAIL  stderr lacks the block reason for: ${label}`);
  }
}

const bad = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8' });
const badOk = bad.status === 0;
if (!badOk) failed++;
console.log(`${badOk ? 'PASS' : 'FAIL'}  exit=${bad.status} expect=0  malformed stdin is quiet`);

// A headless runner opts out with CLAUDE_OS_SKIP_CLAIMS_HOOK=1; any other value keeps the check.
const bare = { transcript_path: endingWith('Fixed.') };
const envOn = spawnSync(process.execPath, [hook], {
  input: JSON.stringify(bare), encoding: 'utf8',
  env: Object.assign({}, process.env, { CLAUDE_OS_SKIP_CLAIMS_HOOK: '1' }),
});
const envOnOk = envOn.status === 0;
if (!envOnOk) failed++;
console.log(`${envOnOk ? 'PASS' : 'FAIL'}  exit=${envOn.status} expect=0  CLAUDE_OS_SKIP_CLAIMS_HOOK=1 is quiet`);
const envOff = spawnSync(process.execPath, [hook], {
  input: JSON.stringify(bare), encoding: 'utf8',
  env: Object.assign({}, process.env, { CLAUDE_OS_SKIP_CLAIMS_HOOK: '0' }),
});
const envOffOk = envOff.status === 2;
if (!envOffOk) failed++;
console.log(`${envOffOk ? 'PASS' : 'FAIL'}  exit=${envOff.status} expect=2  CLAUDE_OS_SKIP_CLAIMS_HOOK=0 still blocks`);

fs.rmSync(tmp, { recursive: true, force: true });
const total = cases.length + 3;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
