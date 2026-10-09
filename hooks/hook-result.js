// agent-os: how a hook delivers a block (PreToolUse), feedback (PostToolUse)
// or a continue (Stop), per agent. Shared by no-shell-edits.js, no-em-dash.js,
// notes-stop.js and claims-stop.js.
//
// Claude Code, and agy through hooks/agy-hook.js: reason on stderr, exit 2.
//
// Codex: a JSON decision on stdout, exit 0. Codex 0.158.0-alpha.2.1 treats
// exit 2 as a hook failure ("hook: PreToolUse Failed") and runs the command
// anyway, although its docs say exit 2 blocks; the JSON deny gave
// "hook: PreToolUse Blocked" (docs/agent-os-spike.md section 10, H1, tested
// 2026-09-30). Forms from https://learn.chatgpt.com/docs/hooks (fetched
// 2026-09-30):
//   PreToolUse:             hookSpecificOutput.permissionDecision "deny"
//   PostToolUse and Stop:   { decision: "block", reason }
//
// Codex is recognised by turn_id, which its PreToolUse, PostToolUse and Stop
// inputs carry and neither Claude Code's input nor agy-hook.js's mapped
// payload does.

'use strict';

function isCodex(input) {
  return !!input && typeof input.turn_id === 'string' && input.turn_id !== '';
}

// Ends the process. event is the hook event this script handles.
function block(input, event, reason) {
  if (isCodex(input)) {
    const out =
      event === 'PreToolUse'
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
        : { decision: 'block', reason };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }
  process.stderr.write(reason);
  process.exit(2);
}

module.exports = { isCodex, block };
