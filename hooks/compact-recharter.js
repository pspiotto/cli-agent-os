// agent-os: re-orders a charter read after a context compaction.
//
// Claude Code runs this as a SessionStart hook with matcher "compact", which
// fires when a session resumes after its context was compacted. Codex runs the
// same entry: its SessionStart also reports source "compact" and adds plain
// stdout to the model's context (https://learn.chatgpt.com/docs/hooks, fetched
// 2026-09-30). Antigravity has no compaction event, so it gets nothing here. SessionStart
// is one of the few events whose plain-text stdout is added to the model's
// context, so what this prints is what the compacted session sees first.
//
// Why it exists: the global CLAUDE.md and the project CLAUDE.md are re-injected
// automatically after a compaction, but a charter that those files only POINT
// at is not. The pointer survives, the rules do not. A rule written inside such
// a charter ("re-read me after every compaction") cannot enforce itself: the
// session must already open the file to meet the rule telling it to open the
// file. This hook is the part outside the file that does the forcing.
//
// The charter list is charters.json next to this script. install.ps1 writes it
// from the "charters" array of the overlay's overlay.json; with no overlay
// there is no file and the hook stays silent. Add a charter in the overlay,
// not in ~/.claude. AGENT_OS_CHARTERS points at another file (tests use it).
//
// Unit test (from the repo root):
//   node hooks/compact-recharter.test.js

'use strict';

const fs = require('fs');
const path = require('path');

// Charters that a compacted session must re-read by hand, keyed by the
// directory the session is running in. "exact" matches that directory only.
// "under" matches that directory and everything below it. Paths use forward
// slashes; matching ignores case and slash direction, because Windows accepts
// both spellings of the same path. Each entry:
//   { "exact": [dir], "under": [dir], "files": [path], "note": "..." }
//
// Keep "under" off a directory that holds unrelated projects: an "under" rule
// on a git root that holds many repos prints the block in every one of them.
// When the charter's sessions start in such a root, use "exact" for it.
function loadCharters() {
  const file = process.env.AGENT_OS_CHARTERS || path.join(__dirname, 'charters.json');
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return []; // no file or unreadable: nothing registered
  }
}
const CHARTERS = loadCharters();

function norm(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// True when "child" is "parent" or sits below it. Compares whole segments, so
// C:/work_old does not match C:/work.
function isUnder(child, parent) {
  if (!child || !parent) return false;
  return child === parent || child.startsWith(parent + '/');
}

// True when the session cwd satisfies either list on a rule.
function ruleMatches(rule, cwdN) {
  if (!cwdN) return false;
  const exact = rule.exact || [];
  const under = rule.under || [];
  if (exact.some((dir) => cwdN === norm(dir))) return true;
  if (under.some((dir) => isUnder(cwdN, norm(dir)))) return true;
  return false;
}

let cwd = '';
let source = '';
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  cwd = (input && input.cwd) || '';
  source = (input && input.source) || '';
} catch (err) {
  // Unparseable or empty input. Say nothing rather than inject a stray block.
  process.exit(0);
}

// The matcher already narrows this to compactions. Check anyway: a settings
// file that drops the matcher would otherwise fire this on every startup.
if (source && source !== 'compact') process.exit(0);

const cwdN = norm(cwd);
const hits = [];
for (const rule of CHARTERS) {
  if (!ruleMatches(rule, cwdN)) continue;
  for (const file of rule.files) {
    if (!fs.existsSync(file)) continue; // a charter that moved is not an error
    hits.push({ file: path.normalize(file), note: rule.note });
  }
}

// Nothing registered for this directory: stay silent. The auto-injected
// CLAUDE.md files already cover a session with no separate charter, and an
// unconditional reminder would spend context in every project on the machine.
if (hits.length === 0) process.exit(0);

const lines = [
  'Context was just compacted. The summary keeps the headline rules and drops the',
  'operational detail, which is where the working commands live.',
  '',
  'Re-read these files with the Read tool now, before the next action that changes',
  'state (a wmux or pane command, a JIRA write, a commit, a database write):',
  '',
];
for (const hit of hits) {
  lines.push('  ' + hit.file);
  if (hit.note) lines.push('    ' + hit.note);
}
lines.push('');
lines.push('Do not act from the summary alone.');

process.stdout.write(lines.join('\n') + '\n');
process.exit(0);
