// agent-os: blocks a session from ending on a bare claim. The Claims rule in
// the global rules (RULES.md) says never write done, fixed, verified, confirmed,
// deployed, merged, released or root-caused unless the claim is observed or
// tested, and to quote the single line that proves it. This hook makes that
// cost something at the moment the session tries to stop: if the LAST
// assistant text in the transcript asserts one of those claims and carries no
// proof token, the stop is blocked (exit 2) and the reason goes back to the
// model on stderr so it can add the proving line or downgrade the claim.
//
// Design decision: the trigger tests for PROOF, not for an "Evidence:"
// heading, because the rules no longer put that heading in anything written
// for the owner (the claim plus its one proving line is the format).
//
// Same shape as notes-stop.js: JSON payload on stdin with transcript_path and
// stop_hook_active (Codex adds last_assistant_message, used first when
// present); exit 2 blocks, exit 0 lets the session end.
//   - env CLAUDE_OS_SKIP_CLAIMS_HOOK=1 or AGENT_OS_SKIP_CLAIMS_HOOK=1: exit 0
//     (headless runners; the old name stays because scheduled tasks on the
//     DBA and data-eng machines set it)
//   - stop_hook_active true: exit 0 (already prompted once this stop)
//   - no transcript, unreadable transcript, no assistant text: exit 0
//   - last assistant text has a claim verb and no proof token: stderr, exit 2
//     (Codex: JSON block, hook-result.js)
//   - otherwise: exit 0
//
// Claim verbs (exactly the list the rule names, so the two cannot drift):
//   done, fixed, verified, confirmed, deployed, merged, released, root-caused,
//   plus the phrases "all tests pass" and "working now".
// Proof tokens, any one of which clears the whole message:
//   - a fenced code block
//   - an inline code span that holds output rather than a name: it contains a
//     space, a number of two or more digits, or ": N" (`passed: 31`, `exit 0`,
//     `skills : 4 file(s) copied`), where a bare `install.ps1` does not count
//   - a path with a line number (hooks/x.js:42)
//   - a git sha of 7 or more hex chars containing both a letter and a digit
//   - a pass count (passed: 31, 31 passed, 16/16 passed, failed: 0)
//   - an explicit downgrade: unverified, not verified, not run, hypothesis,
//     inferred
// Never fires on: a negated form (not / never / nothing / isn't ... before the
// verb), a question, a claim word inside double or single quotes, inside a
// code span, in a blockquote, in a path or branch or file name, or a
// conditional / future / obligation form (once X is done, when merged, will be
// fixed, needs to be verified). Those cases are named in claims-stop.test.js.
//
// Unit test (from the repo root):  node hooks/claims-stop.test.js

'use strict';

const fs = require('fs');
// Claude Code and Codex transcript formats, parsed in one place.
const { lastAssistantText } = require('./transcript.js');
const { block } = require('./hook-result.js');

const CLAIM = /\b(done|fixed|verified|confirmed|deployed|merged|released|root-caused|all tests pass|working now)\b/i;

const PROOF = [
  /```[\s\S]*?```/,                                   // fenced block
  /`[^`\n]*(?:\s|\d{2,}|:\s*\d)[^`\n]*`/,             // code span holding a space, a 2+ digit number or ": N"
  /[\w.\\/-]+\.\w+:\d+\b/,                            // path:line
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i, // sha
  /\bpassed\s*:?\s*\d+/i,                             // passed: 31
  /\b\d+(?:\s*\/\s*\d+)?\s+passed\b/i,                // 31 passed, 16/16 passed
  /\bfailed\s*:\s*\d+/i,                              // failed: 0
  /\b(?:unverified|not verified|not run|hypothesis|inferred)\b/i, // explicit downgrade
];

// Words that, appearing shortly before the claim verb, make it a non-claim.
const GUARD = /\b(?:not|never|no|nothing|none|nor|neither|without|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|can't|cannot|couldn't|won't|wouldn't|don't|doesn't|didn't|once|when|until|after|before|if|unless|will be|would be|should be|could be|to be|to get|to mark|mark this as|as|yet to be|still to be)\b/i;

function hasProof(text) {
  return PROOF.some((re) => re.test(text));
}

// Strip everything a claim word may legitimately sit inside, leaving prose.
function proseOf(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')                     // fenced blocks
    .replace(/`[^`\n]*`/g, ' ')                         // inline code
    .replace(/^[ \t]*>.*$/gm, ' ')                      // blockquote lines
    .replace(/"[^"\n]*"/g, ' ')                         // double-quoted
    .replace(/(^|\s)'[^'\n]+'(?=[\s.,;:!?)]|$)/g, '$1 ') // single-quoted words or phrases
    .replace(/\S*[\\/]\S*/g, ' ')                       // paths, URLs, branch names
    .replace(/\b[\w-]+\.[a-z0-9]{1,5}\b/gi, ' ');       // file names (done.md)
}

// Returns { verb, sentence } for the first bare claim, or null.
function findBareClaim(text) {
  const sentences = proseOf(text).split(/(?<=[.!?])\s+|\n+/);
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence || sentence.endsWith('?')) continue;
    const m = CLAIM.exec(sentence);
    if (!m) continue;
    // Up to four words before the verb decide whether it is asserted.
    const before = sentence.slice(0, m.index).trim().split(/\s+/).slice(-4).join(' ');
    if (GUARD.test(before)) continue;
    return { verb: m[1], sentence };
  }
  return null;
}

function reason(claim) {
  return (
    'CLAIM WITHOUT PROOF: the final message asserts "' + claim.verb + '" (' +
    JSON.stringify(claim.sentence.slice(0, 160)) + ') but quotes nothing that proves it. ' +
    'The Claims rule in the global rules: never write done, fixed, verified, confirmed, deployed, merged, ' +
    'released or root-caused unless the claim is observed or tested, and quote the single line that proves it. ' +
    'Either add that line (command output in backticks or a fenced block, a path:line, a commit sha, a pass count) ' +
    'or downgrade the claim ("unverified", "not run", "inferred", "hypothesis") and name the gap. Then end the session.'
  );
}

if (process.env.CLAUDE_OS_SKIP_CLAIMS_HOOK === '1' || process.env.AGENT_OS_SKIP_CLAIMS_HOOK === '1') process.exit(0);

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (err) {
  process.exit(0);
}

if (!payload || payload.stop_hook_active) process.exit(0);

// Codex hands the final message over directly (last_assistant_message) and
// may send transcript_path as null; Claude Code sends only the transcript.
let text = null;
if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) {
  text = payload.last_assistant_message;
} else if (payload.transcript_path) {
  text = lastAssistantText(String(payload.transcript_path));
}
if (!text) process.exit(0);
if (hasProof(text)) process.exit(0);

const claim = findBareClaim(text);
if (!claim) process.exit(0);

block(payload, 'Stop', reason(claim));
