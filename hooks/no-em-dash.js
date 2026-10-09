// agent-os: flags non-ASCII punctuation in text an agent has just written.
// Claude Code runs this as a PostToolUse hook (matcher: Write|Edit); Codex
// runs the same entry, matching its apply_patch tool through the Edit|Write
// alias. The tool call arrives as JSON on stdin after the file has already
// been written; exit code 2 sends stderr back to the model as feedback, exit 0
// stays silent (Codex gets the feedback as a JSON block, hook-result.js). Antigravity reaches it through hooks/agy-hook.js before the
// write instead, since its PostToolUse payload carries no tool arguments.
//
// The file keeps its original name (it started as an em-dash-only check) so
// the settings.json hook entry is stable across machines.
//
// Only the text Claude wrote in this call is scanned (Write: content, Edit:
// new_string), never the whole file, so an existing file that already holds
// the characters elsewhere (the wmux block, older docs) does not fire on every
// edit.
//
// Two tiers:
//   - The literal characters (em dash, en dash, curly single and double
//     quotes) are flagged in every file type. In prose they are the style
//     rule; in code and scripts they are almost always a paste error, and
//     Windows PowerShell 5.1 mishandles curly quotes in script text.
//   - The escaped forms (&mdash;, a backslash-u2014 sequence written as text)
//     are flagged only in prose and copy files, because in code an escape
//     sequence is a legitimate way to refer to the character (this hook's own
//     source, its tests).
//
// Unit test (from the repo root):  node hooks/no-em-dash.test.js

'use strict';

// File types that hold prose or user-facing copy.
const PROSE_EXT = /\.(md|mdx|markdown|txt|rst|html|htm)$/i;

// U+2014 em dash, U+2013 en dash, U+2018/U+2019 curly single quotes,
// U+201C/U+201D curly double quotes.
// Built from a string so this source file holds no literal non-ASCII
// punctuation itself (it would trip the hook on every edit).
const LITERAL = new RegExp('[\\u2014\\u2013\\u2018\\u2019\\u201C\\u201D]');
// The escaped forms the 2026-09-08 insights report found written into prose.
const ESCAPED = /&mdash;|&ndash;|&[lr]squo;|&[lr]dquo;|\\u201[34]|\\u201[89CDcd]/;

// Codex reports its apply_patch edits with the patch text in
// tool_input.command (https://learn.chatgpt.com/docs/hooks, fetched
// 2026-09-30). Returns [{ filePath, text }] with the ADDED lines of each file
// in the patch, so only what the agent wrote in this call is scanned.
function patchFiles(patch) {
  const out = [];
  let cur = null;
  for (const line of String(patch).split(/\r?\n/)) {
    const head = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
    if (head) {
      cur = { filePath: head[1].trim(), text: '' };
      out.push(cur);
      continue;
    }
    if (/^\*\*\* /.test(line)) {
      // Delete File, Move to, End Patch: nothing written under these.
      if (!/^\*\*\* Move to: /.test(line)) cur = null;
      continue;
    }
    if (cur && line.startsWith('+')) cur.text += line.slice(1) + '\n';
  }
  return out;
}

const { block } = require('./hook-result.js');

let targets = [];
let input = null;
try {
  const raw = require('fs').readFileSync(0, 'utf8');
  input = JSON.parse(raw);
  const ti = (input && input.tool_input) || {};
  if (typeof ti.command === 'string' && ti.command.includes('*** Begin Patch')) {
    targets = patchFiles(ti.command);
  } else {
    let text = '';
    if (typeof ti.content === 'string') text = ti.content;
    else if (typeof ti.new_string === 'string') text = ti.new_string;
    targets = [{ filePath: String(ti.file_path || ''), text }];
  }
} catch (err) {
  // Unparseable input: stay silent rather than nag on every write.
  process.exit(0);
}

let filePath = '';
const hits = [];
for (const t of targets) {
  if (!t.filePath) continue;
  const isProse = PROSE_EXT.test(t.filePath);
  const pattern = isProse ? new RegExp(LITERAL.source + '|' + ESCAPED.source) : LITERAL;
  if (!pattern.test(t.text)) continue;
  if (!filePath) filePath = t.filePath;
  const lines = t.text.split(/\r?\n/);
  for (let i = 0; i < lines.length && hits.length < 3; i++) {
    if (pattern.test(lines[i])) hits.push(lines[i].trim().slice(0, 80));
  }
}

if (!filePath) process.exit(0);

block(
  input,
  'PostToolUse',
  'agent-os: non-ASCII punctuation written to ' + filePath + ' (em dash, en dash or curly ' +
  'quote). The global writing rule is ASCII punctuation only: rewrite an em dash with a ' +
  'comma, colon or a new sentence, an en dash with a hyphen or "to", and curly quotes with ' +
  'straight ones, unless this file\'s own convention requires them (a log whose line format ' +
  'uses one as a separator, for example). Lines: ' + hits.map((h) => JSON.stringify(h)).join(' ')
);
