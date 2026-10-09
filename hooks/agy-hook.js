// agent-os: adapter that runs the Claude-protocol hooks in this folder under
// Google's Antigravity CLI (agy). Installed with the rest of hooks/ into the
// agent-os plugin (~/.gemini/config/plugins/agent-os/hooks/) and wired by that
// plugin's hooks.json:
//   node hooks/agy-hook.js PreToolUse    (matcher "*")
//   node hooks/agy-hook.js Stop
//
// agy's contract differs from Claude Code's (agy's bundled
// agy-customizations/docs/hooks.md, plus a live agy 1.2.14 probe on
// 2026-09-30): camelCase JSON on stdin, the tool call as toolCall.name and
// toolCall.args, and a JSON decision on stdout instead of an exit code. What
// the probe showed that the doc does not say:
//   - A PreToolUse hook MUST print a decision. An empty {} denied every call
//     ("tool call denied by pre-tool hook: "). "ask" hands the call to agy's
//     own permission policy (the probe's echo was then auto-denied in
//     headless mode for lack of a command() allow rule, while accept-edits
//     let the file writes through), so "ask" is this adapter's "no opinion".
//     "allow" would override that policy and is never sent.
//   - PostToolUse does receive toolCall, but its output has no feedback
//     channel, so the ASCII-punctuation check runs here at PreToolUse and
//     denies the write with the reason; the agent rewrites and retries.
//   - Stop sends executionNum (0 on the first stop) and no stop_hook_active.
//     executionNum > 0 is taken to mean the loop was already continued once
//     by a stop hook, the same guard Claude's stop_hook_active gives.
//
// Mapping onto the Claude shape the hooks read:
//   run_command            -> Bash  { command: CommandLine }     no-shell-edits.js
//   write_to_file          -> Write { file_path: TargetFile, content: CodeContent }
//   replace_file_content   -> Edit  { file_path, new_string: ReplacementContent }
//   multi_replace_file_content -> Edit, every ReplacementChunks[].ReplacementContent
//                                                                no-em-dash.js
//   Stop                   -> { transcript_path, stop_hook_active, cwd }
//                                                 notes-stop.js, then claims-stop.js
//
// Unit test (from the repo root):  node hooks/agy-hook.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;

function run(hookFile, payload) {
  const r = spawnSync(process.execPath, [path.join(HERE, hookFile)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
  });
  return { blocked: r.status === 2, reason: String(r.stderr || '').trim() };
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

const event = process.argv[2] || '';
let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8')) || {};
} catch (err) {
  // Unreadable input: no opinion. PreToolUse still owes agy a decision.
  if (event === 'PreToolUse') out({ decision: 'ask' });
  out({});
}

if (event === 'PreToolUse') {
  const call = input.toolCall || {};
  const name = String(call.name || '');
  const args = call.args || {};
  let res = { blocked: false };
  if (name === 'run_command') {
    res = run('no-shell-edits.js', { tool_name: 'Bash', tool_input: { command: String(args.CommandLine || '') } });
  } else if (name === 'write_to_file') {
    res = run('no-em-dash.js', {
      tool_name: 'Write',
      tool_input: { file_path: String(args.TargetFile || ''), content: String(args.CodeContent || '') },
    });
  } else if (name === 'replace_file_content' || name === 'multi_replace_file_content') {
    const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [args];
    const text = chunks.map((c) => String((c && c.ReplacementContent) || '')).join('\n');
    res = run('no-em-dash.js', {
      tool_name: 'Edit',
      tool_input: { file_path: String(args.TargetFile || ''), new_string: text },
    });
  }
  if (res.blocked) out({ decision: 'deny', reason: res.reason });
  out({ decision: 'ask' });
}

if (event === 'Stop') {
  const ws = Array.isArray(input.workspacePaths) && input.workspacePaths.length ? String(input.workspacePaths[0]) : '';
  const payload = {
    transcript_path: input.transcriptPath || null,
    stop_hook_active: Number(input.executionNum || 0) > 0,
    cwd: ws,
  };
  for (const hookFile of ['notes-stop.js', 'claims-stop.js']) {
    const res = run(hookFile, payload);
    if (res.blocked) out({ decision: 'continue', reason: res.reason });
  }
  out({});
}

// Any other event: nothing to say.
out({});
