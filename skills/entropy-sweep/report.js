#!/usr/bin/env node
// claude-os entropy sweep: renders scan.js JSON as the markdown report.
//
//   node skills/entropy-sweep/report.js <scan.json> [--out <file>]
//
// Without --out the report goes to stdout. With --out it is written only if
// the file does not exist yet; if it does, a "## Re-run <time>" section is
// appended, never an overwrite. This is the only file the sweep creates.
// ASCII only. Nothing else is touched.

'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (!argv.length) {
  process.stderr.write('usage: node report.js <scan.json> [--out <file>]\n');
  process.exit(1);
}
const scan = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
let out = null;
for (let i = 1; i < argv.length; i++) if (argv[i] === '--out') out = argv[++i];

const c = scan.checks;
const day = scan.scannedAt.slice(0, 10);
const clock = scan.scannedAt.slice(11, 16) + ' UTC';
const rel = (p) => p.replace(/\\/g, '/');
const d10 = (s) => (s ? String(s).slice(0, 10) : 'n/a');
const none = (arr) => (arr.length ? null : 'none');
const L = [];

function section(title, arr, render, note) {
  L.push(`## ${title}`, '');
  if (note) L.push(note, ''); // what the scanner exempted or skipped; absent in scans from before 2026-09-17
  if (!arr.length) {
    L.push('none', '');
    return;
  }
  for (const f of arr) L.push(render(f));
  L.push('');
}

L.push(`# Entropy sweep: ${path.basename(rel(scan.repo))}, ${day}`, '');
L.push(`Scanned ${scan.tracked} tracked files, ${scan.markdown} markdown, default branch \`${scan.defaultBranch}\`, at ${clock}. Scanner: \`skills/entropy-sweep/scan.js\` in claude-os. Read-only: this file is the only thing the sweep wrote. Findings are not acted on here; removal is a separate armed step that moves files to quarantine, never \`rm\`.`, '');

L.push('## Summary', '', '| check | findings |', '|---|---|');
for (const [k, v] of Object.entries(scan.summary)) L.push(`| ${k.replace(/_/g, ' ')} | ${v} |`);
L.push('');

section('1. Unreferenced markdown', c.unreferenced_markdown.findings,
  (f) => `- \`${f.path}\` (last commit ${d10(f.lastCommit)}) - ${f.evidence}`,
  c.unreferenced_markdown.note);

section('2. Docs older than the code they describe', c.docs_older_than_code.findings,
  (f) => `- \`${f.doc}\` committed ${d10(f.docCommit)}, names \`${f.newerPath}\` committed ${d10(f.newerCommit)} - ${f.evidence}`);

L.push('## 3. Last verified', '', `### Top ${c.last_verified.topDocs.length} loaded docs (by inbound references from ${c.last_verified.command.split('from ')[1] || 'loader files'})`, '');
if (c.last_verified.topDocs.length) {
  L.push('| # | path | inbound | from | Last verified |', '|---|---|---|---|---|');
  c.last_verified.topDocs.forEach((d, i) => {
    const v = d.verified ? `${d.verified.date}${d.verified.machine ? ' (' + d.verified.machine + ')' : ''}` : 'none';
    L.push(`| ${i + 1} | \`${d.path}\` | ${d.inbound} | ${d.from.map((x) => '`' + x + '`').join(', ')} | ${v} |`);
  });
} else {
  L.push('none');
}
L.push('', '### Findings', '');
if (!c.last_verified.findings.length) L.push('none');
for (const f of c.last_verified.findings) {
  if (f.kind === 'stale-by-own-admission') L.push(`- stale by own admission: \`${f.doc}\` says ${f.verified}, but \`${f.newerPath}\` was committed ${d10(f.newerCommit)} - ${f.evidence}`);
  else L.push(`- no line: \`${f.doc}\` (inbound ${f.inbound}) - ${f.evidence}`);
}
L.push('');

L.push('## 4. Worktrees', '', `Threshold ${scan.options.days} days. Every worktree listed, flagged or not.`, '');
L.push('| path | branch | last commit | days | flags |', '|---|---|---|---|---|');
for (const w of c.worktrees.all) L.push(`| \`${rel(w.path)}\` | \`${w.branch}\` | ${d10(w.lastCommit)} | ${w.daysSinceCommit === null ? 'n/a' : w.daysSinceCommit} | ${w.flags.join('; ') || '-'} |`);
L.push('', `Evidence per row: ${c.worktrees.command}.`, '');

section('5. Dead agent definitions', c.dead_agents.findings,
  (f) => `- \`${f.agent}\`: ${f.flags.join('; ')} (worktrees: ${f.worktrees.length ? f.worktrees.map(rel).join(', ') : 'none'}; branches: ${f.branches.join(', ') || 'none'}; referenced by: ${f.referencedBy.join(', ') || 'nothing'}) - ${f.evidence}`,
  c.dead_agents.note);

section('6. Divergent duplicates', c.divergent_duplicates.findings,
  (f) => `- \`${f.name}\`: ${f.copies.map((x) => '`' + rel(x.path) + '` ' + x.sha1.slice(0, 12)).join(' vs ')} - ${f.evidence}`,
  c.divergent_duplicates.note);

section('7. Unreachable code (candidate, not proof)', c.unreachable_candidates.findings,
  (f) => `- \`${f.path}\` (last commit ${d10(f.lastCommit)}) - ${f.status}: ${f.evidence}`,
  c.unreachable_candidates.note);

const body = L.join('\n').replace(/[^\x00-\x7F]/g, '?') + '\n';

if (!out) {
  process.stdout.write(body);
} else if (fs.existsSync(out)) {
  fs.appendFileSync(out, `\n## Re-run ${scan.scannedAt}\n\n` + body.replace(/^# .*\n\n/, ''), 'utf8');
  process.stderr.write(`appended re-run section to ${out}\n`);
} else {
  fs.writeFileSync(out, body, 'utf8');
  process.stderr.write(`wrote ${out}\n`);
}
