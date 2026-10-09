#!/usr/bin/env node
// verify-docs step 6: write (or replace) the "Last verified:" block under each
// doc's H1, from a JSON spec. Dry by default; --write is the arming token.
//   node stamp.js <repo> <spec.json> [--write]
// spec: [{ "path": "docs/x.md",
//          "date": "2026-09-16" | "never",
//          "machine": "main-desktop",
//          "checked": ["src/a.ts", "docs/b.md"],       (repo paths; the scanner resolves them)
//          "scope": "optional: what was and was not checked",
//          "note": "optional: what is wrong now, one line" }]
// Block written, always ASCII, directly after the H1 and one blank line:
//   Last verified: <date> (<machine>) - checked against <paths>
//   Verified scope: <scope>          (only when given)
//   Wrong now: <note>                (only when given)
// An existing block (a Last verified line plus any Verified scope / Wrong now
// lines right after it) is replaced, so re-verification is one run. A doc
// whose first line is not an H1 is skipped and reported. Nothing else in the
// file is touched; the file's own line endings are kept.
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (argv.length < 2) {
  process.stderr.write('usage: node stamp.js <repo> <spec.json> [--write]\n');
  process.exit(1);
}
const repo = path.resolve(argv[0]);
const spec = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
const write = argv.includes('--write');

const STAMP = /^Last verified:/;
const TRAIL = /^(Verified scope|Wrong now):/;
let done = 0;
let skipped = 0;
for (const s of spec) {
  const abs = path.join(repo, s.path);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    console.log(`SKIP    ${s.path}: cannot read (${err.code})`);
    skipped++;
    continue;
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  if (!/^# /.test(lines[0])) {
    console.log(`SKIP    ${s.path}: first line is not an H1`);
    skipped++;
    continue;
  }
  let stamp = `Last verified: ${s.date}`;
  if (s.machine) stamp += ` (${s.machine})`;
  if (s.checked && s.checked.length) stamp += ` - checked against ${s.checked.join(', ')}`;
  const block = [stamp];
  if (s.scope) block.push(`Verified scope: ${s.scope}`);
  if (s.note) block.push(`Wrong now: ${s.note}`);
  if (/[^\x00-\x7F]/.test(block.join(''))) {
    console.log(`SKIP    ${s.path}: non-ASCII in the stamp`);
    skipped++;
    continue;
  }
  // Find an existing block in the first 12 lines: the stamp line and its trailers.
  let start = -1;
  let end = -1;
  for (let i = 1; i < Math.min(lines.length, 12); i++) {
    if (STAMP.test(lines[i])) {
      start = i;
      end = i + 1;
      while (end < lines.length && TRAIL.test(lines[end])) end++;
      break;
    }
  }
  let out;
  let verb;
  if (start >= 0) {
    out = [...lines.slice(0, start), ...block, ...lines.slice(end)];
    verb = 'REPLACE';
  } else {
    out = [lines[0], '', ...block, ...lines.slice(1)];
    verb = 'INSERT ';
  }
  if (write) fs.writeFileSync(abs, out.join(eol), 'utf8');
  done++;
  console.log(`${write ? verb : 'DRY ' + verb.trim()} ${s.path}`);
  for (const b of block) console.log(`        ${b}`);
}
console.log(`\n${done} ${write ? 'written' : 'would be written'}, ${skipped} skipped${write ? '' : ' (dry run; add --write to apply)'}`);
process.exit(skipped ? 1 : 0);
