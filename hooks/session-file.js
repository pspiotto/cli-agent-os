// agent-os: the one definition of "a repo's session file", shared by the
// NOTES Stop hook (hooks/notes-stop.js) and the entropy scanner
// (skills/entropy-sweep/scan.js), so the two cannot drift.
//
// A session file is the file a session appends its dated entry to (the
// Sessions rule in the global CLAUDE.md): NOTES.md, or for a project that
// keeps its own convention, a file whose NAME starts with "handoff" and ends
// ".md" (HANDOFF.md, HANDOFF-<head>.md). Matched on the file name, so a folder
// named handoff does not count, and neither does my-handoff.md.
//
// Both callers resolve this file as ../../hooks/session-file.js or
// ./session-file.js; install.ps1 copies hooks/ and skills/ side by side under
// ~/.claude, so the relative path is the same in the repo and installed.

'use strict';

const HANDOFF_NAME = /^handoff(.*)\.md$/i;

const fileName = (target) => String(target).split(/[\\/]/).pop();

// The hook's test, unchanged from notes-stop.js: any path containing
// "notes.md", or a HANDOFF*.md file name.
function isSessionFile(target) {
  if (String(target).toLowerCase().includes('notes.md')) return true;
  return HANDOFF_NAME.test(fileName(target));
}

// For a HANDOFF-<worker>.md name, the <worker> part ("" for HANDOFF.md, null
// when the name is not a handoff name). The scanner uses it to tell a live
// worker's file from a dead snapshot that merely carries the prefix.
function handoffSuffix(target) {
  const m = HANDOFF_NAME.exec(fileName(target));
  if (!m) return null;
  return m[1].replace(/^[-_. ]+/, '').toLowerCase();
}

module.exports = { isSessionFile, handoffSuffix, HANDOFF_NAME };
