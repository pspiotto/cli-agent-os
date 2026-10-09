// agent-os: reminds the model to write NOTES.md before a session ends, but
// only when the session did file work and never touched a NOTES.md (or a
// HANDOFF*.md, for a project that keeps its session file under that name).
// Claude Code runs this as a Stop hook. The payload arrives as JSON on stdin
// with transcript_path and stop_hook_active; exit code 2 blocks the stop and
// sends stderr back to the model, exit 0 lets the session end.
//
// Port of the Python hook that ran on the DBA machine from 2026-04-28
// (~/.claude/hooks/notes_stop_hook.py). Node so it shares a runtime with the
// other agent-os hooks. Reads Claude Code, Codex and Antigravity transcripts
// through transcript.js. Behaviour:
//   - env CLAUDE_OS_SKIP_NOTES_HOOK=1 or AGENT_OS_SKIP_NOTES_HOOK=1: exit 0
//     (the old name stays: scheduled tasks on two machines set it; a
//     headless runner such as a
//     scheduled poll sets it; the reminder would only cost the run an extra
//     model turn, since the runner is told not to write NOTES.md)
//   - a file .claude/skip-notes-hook in the session's cwd (the payload's cwd,
//     else the process cwd): exit 0 for as long as the file exists. An
//     orchestrator whose turns end to wait on background work, and the worker
//     panes it spawns (their briefs forbid NOTES.md edits), create it at the
//     start of the run and remove it at the end; added after a long-running
//     orchestrator got the reminder on every idle turn
//   - stop_hook_active true: exit 0 (the hook already prompted once this stop)
//   - no transcript, unreadable transcript: exit 0
//   - no Edit/Write/NotebookEdit tool_use in the transcript: exit 0
//     (read-only sessions end quietly)
//   - a write whose target path contains "notes.md": exit 0
//   - a write to a file whose name starts with "handoff" and ends ".md": exit 0
//     (fleet-style sessions write docs/orchestration/HANDOFF-<head>.md
//     and, for per-worker sessions, HANDOFF.md)
//   - otherwise: reminder on stderr, exit 2 (Codex: JSON block, hook-result.js)
// Known gap, unchanged from the Python version: file changes made through
// Bash are not seen. The shell-edit guard makes those rare.
//
// Unit test (from the repo root):  node hooks/notes-stop.test.js

'use strict';

const fs = require('fs');
const path = require('path');
// The one definition of a session file, shared with skills/entropy-sweep/scan.js.
const { isSessionFile } = require('./session-file.js');
// Claude Code, Codex and (best effort) Antigravity transcripts.
const { writeTargets } = require('./transcript.js');
const { block } = require('./hook-result.js');

// Project-local opt-out, relative to the session's cwd. Present = quiet.
const SKIP_MARKER = path.join('.claude', 'skip-notes-hook');

const REMINDER =
  'REMINDER: append a dated entry to the project-local NOTES.md before ending the session ' +
  '(the Sessions rule in the global rules): project or ticket id, files modified, last ' +
  'command run and its result, validation status, and one exact next step. A project that ' +
  'keeps its own HANDOFF*.md session file instead writes there. If this session had no ' +
  'meaningful work (read-only Q&A, exploration), say so briefly and stop.';

function needsReminder(transcriptPath) {
  const w = writeTargets(transcriptPath);
  if (!w || !w.hasWrites) return false;
  return !w.targets.some((t) => isSessionFile(t));
}

function skipMarkerPresent(cwd) {
  try {
    return fs.statSync(path.join(cwd, SKIP_MARKER)).isFile();
  } catch (err) {
    return false;
  }
}

if (process.env.CLAUDE_OS_SKIP_NOTES_HOOK === '1' || process.env.AGENT_OS_SKIP_NOTES_HOOK === '1') process.exit(0);

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (err) {
  process.exit(0);
}

if (!payload || payload.stop_hook_active) process.exit(0);
if (skipMarkerPresent(payload.cwd ? String(payload.cwd) : process.cwd())) process.exit(0);
if (!payload.transcript_path) process.exit(0);
if (!needsReminder(String(payload.transcript_path))) process.exit(0);

block(payload, 'Stop', REMINDER);
