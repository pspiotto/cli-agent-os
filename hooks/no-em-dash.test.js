// Unit tests for hooks/no-em-dash.js.
//   node hooks/no-em-dash.test.js
// Feeds each Write/Edit call to the hook the way Claude Code does (JSON on
// stdin) and checks the exit code: 2 = flagged, 0 = silent. Exits 1 if any
// case fails.

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const hook = path.join(__dirname, 'no-em-dash.js');
const EM = '\u2014';
const EN = '\u2013';
const LSQ = '\u2018';
const RSQ = '\u2019';
const LDQ = '\u201C';
const RDQ = '\u201D';

// [label, expected exit, tool_name, tool_input]
const cases = [
  // Flagged: em dash in prose written by Write or Edit.
  ['Write .md with em dash', 2, 'Write', { file_path: 'C:\\x\\README.md', content: `a ${EM} b` }],
  ['Edit .md new_string with em dash', 2, 'Edit', { file_path: '/x/notes.md', old_string: 'a', new_string: `b ${EM} c` }],
  ['Write .txt with HTML entity', 2, 'Write', { file_path: 'copy.txt', content: 'a &mdash; b' }],
  ['Write .html with literal \\u2014 escape', 2, 'Write', { file_path: 'page.html', content: 'a \\u2014 b' }],
  ['Write .rst', 2, 'Write', { file_path: 'doc.rst', content: `x ${EM} y` }],
  ['Write .mdx', 2, 'Write', { file_path: 'post.mdx', content: `x ${EM} y` }],
  ['extension check is case-insensitive', 2, 'Write', { file_path: 'NOTES.MD', content: `x ${EM} y` }],

  // Flagged: the rest of the non-ASCII punctuation set, in prose.
  ['Write .md with en dash', 2, 'Write', { file_path: 'a.md', content: `May 11${EN}18` }],
  ['Write .md with curly double quotes', 2, 'Write', { file_path: 'a.md', content: `${LDQ}quoted${RDQ}` }],
  ['Write .md with curly apostrophe', 2, 'Write', { file_path: 'a.md', content: `owner${RSQ}s` }],
  ['Write .md with curly single quotes', 2, 'Write', { file_path: 'a.md', content: `${LSQ}x${RSQ}` }],
  ['Write .txt with &ndash; entity', 2, 'Write', { file_path: 'a.txt', content: 'a &ndash; b' }],
  ['Write .md with literal \\u2019 escape', 2, 'Write', { file_path: 'a.md', content: 'it\\u2019s' }],

  // Flagged: the literal characters in code and scripts too (paste errors;
  // PowerShell 5.1 mishandles curly quotes in script text).
  ['Write .ps1 with curly quotes', 2, 'Write', { file_path: 'run.ps1', content: `Write-Host ${LDQ}hi${RDQ}` }],
  ['Write .sql with em dash in comment', 2, 'Write', { file_path: 'step1.sql', content: `-- a ${EM} b` }],
  ['Write .ts with em dash in comment', 2, 'Write', { file_path: 'a.ts', content: `// a ${EM} b` }],
  ['Write .json with en dash', 2, 'Write', { file_path: 'a.json', content: `{"a":"${EN}"}` }],

  // Silent: escaped forms in code are a legitimate way to name the character.
  ['Write .js with \\u2014 escape in source', 0, 'Write', { file_path: 'hook.js', content: 'const EM = /\\u2014/;' }],
  ['Write .py with &mdash; string', 0, 'Write', { file_path: 'x.py', content: 's = "&mdash;"' }],
  ['Write .json with \\u201c escape', 0, 'Write', { file_path: 'a.json', content: '{"q":"\\u201c"}' }],

  // Silent: the character is only in what was already there, not in the new text.
  ['Edit old_string has em dash, new_string clean', 0, 'Edit', { file_path: 'a.md', old_string: `a ${EM} b`, new_string: 'a, b' }],
  ['Edit old_string has curly quote, new_string clean', 0, 'Edit', { file_path: 'a.ps1', old_string: `${LDQ}x${RDQ}`, new_string: '"x"' }],

  // Silent: clean text, including ASCII look-alikes.
  ['Write .md with hyphen and double hyphen', 0, 'Write', { file_path: 'a.md', content: 'a - b -- c' }],
  ['Write .md with straight quotes', 0, 'Write', { file_path: 'a.md', content: `"x" and 'y'` }],
  ['Write .md clean', 0, 'Write', { file_path: 'a.md', content: 'hello' }],
  ['Write .md empty', 0, 'Write', { file_path: 'a.md', content: '' }],
  ['Write .ps1 with backtick and straight quotes', 0, 'Write', { file_path: 'run.ps1', content: 'Write-Host "a`nb"' }],
  ['no file_path', 0, 'Write', { content: `a ${EM} b` }],

  // Codex apply_patch: the patch text arrives in tool_input.command.
  ['codex patch adds em dash to .md', 2, 'apply_patch', { command: `*** Begin Patch\n*** Update File: docs/a.md\n@@\n-old\n+new ${EM} line\n*** End Patch` }],
  ['codex patch new file .ts with curly quote', 2, 'apply_patch', { command: `*** Begin Patch\n*** Add File: src/x.ts\n+const s = ${LDQ}x${RDQ};\n*** End Patch` }],
  ['codex patch escape in .ts is fine', 0, 'apply_patch', { command: '*** Begin Patch\n*** Add File: src/x.ts\n+const s = "\\u2014";\n*** End Patch' }],
  ['codex patch em dash only in a REMOVED line', 0, 'apply_patch', { command: `*** Begin Patch\n*** Update File: a.md\n@@\n-old ${EM} line\n+old - line\n*** End Patch` }],
  ['codex patch em dash in a context line', 0, 'apply_patch', { command: `*** Begin Patch\n*** Update File: a.md\n@@\n keep ${EM} this\n-x\n+y\n*** End Patch` }],
  ['codex patch second file flagged', 2, 'apply_patch', { command: `*** Begin Patch\n*** Update File: a.md\n@@\n+clean\n*** Update File: b.md\n@@\n+bad ${EM} one\n*** End Patch` }],
  ['codex patch delete file', 0, 'apply_patch', { command: '*** Begin Patch\n*** Delete File: a.md\n*** End Patch' }],
];

let failed = 0;
for (const [label, expect, tool_name, tool_input] of cases) {
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name, tool_input }),
    encoding: 'utf8',
  });
  const ok = r.status === expect;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  exit=${r.status} expect=${expect}  ${label}`);
  if (ok && expect === 2 && !/non-ASCII punctuation written to/.test(r.stderr)) {
    failed++;
    console.log(`FAIL  stderr lacks the feedback message for: ${label}`);
  }
}

// Malformed stdin must stay silent.
const bad = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8' });
const badOk = bad.status === 0;
if (!badOk) failed++;
console.log(`${badOk ? 'PASS' : 'FAIL'}  exit=${bad.status} expect=0  malformed stdin is silent`);

console.log(`\n${cases.length + 1 - failed}/${cases.length + 1} passed`);
process.exit(failed ? 1 : 0);
