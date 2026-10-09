#!/usr/bin/env node
// claude-os entropy sweep: the armed removal step (docs/entropy-ledger-handoff.md, build order 3).
//
// Moves chosen tracked files OUT of a repo into a dated quarantine folder, records what moved
// from where, and stages the removal. It never deletes, never commits, never overwrites.
// Dry by default; the arming token is --confirm QUARANTINE-<today, local yyyy-mm-dd>, so a
// command copied from yesterday's transcript does nothing.
//
//   node skills/entropy-sweep/quarantine.js <repo> <paths-file> [--report <file>] [--confirm QUARANTINE-<yyyy-mm-dd>]
//
// paths-file: one repo-relative path per line, as triage wrote them. "remove: docs/x.md",
//             "- `docs/x.md`" and a bare "docs/x.md" all read the same; blank lines and
//             lines starting with # are skipped.
// --report:   the sweep report whose line named each path (default: the newest
//             docs/entropy-<date>.md in the repo). A path no report line names is allowed
//             (triage may add a snapshot cited only by later snapshots) and is marked so.
//
// Destination: <repo-parent>/quarantine/<repo>-<date>/<relative path>, outside the repo so the
// next sweep does not find it again (scan.js skips folders named quarantine). MANIFEST.md
// there gets one row per file: source, destination, sha1, the report line.
//
// Refused, and one refusal stops the whole run before anything moves:
//   a path that is absolute, escapes the repo, is not a file, is not tracked, has uncommitted
//   changes (the undo restores HEAD, so HEAD must hold what moved), is protected (CLAUDE.md,
//   README.md, NOTES.md, HANDOFF.md, any HANDOFF*.md at the repo root, CHANGELOG.md, SKILL.md,
//   anything under .claude/ or .git/), or whose
//   destination already exists.
//
// Undo, per file: git -C <repo> restore --staged --worktree -- <path>
// (the quarantined copy stays where it is, as the record). Exit 0 dry or done, 1 on usage
// or refusal, 2 when a move failed part-way (the manifest lists what did move).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
if (argv.length < 2 || argv[0].startsWith('--') || argv[1].startsWith('--')) {
  process.stderr.write('usage: node quarantine.js <repo> <paths-file> [--report <file>] [--confirm QUARANTINE-<yyyy-mm-dd>]\n');
  process.exit(1);
}
const repo = path.resolve(argv[0]);
const pathsFile = path.resolve(argv[1]);
let confirm = null;
let reportFile = null;
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--confirm') confirm = argv[++i] || '';
  else if (argv[i] === '--report') reportFile = path.resolve(argv[++i] || '');
  else {
    process.stderr.write(`unknown argument: ${argv[i]}\n`);
    process.exit(1);
  }
}
if (!fs.existsSync(path.join(repo, '.git'))) {
  process.stderr.write(`not a git repo (no .git): ${repo}\n`);
  process.exit(1);
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; // local date, never TZ
const token = `QUARANTINE-${today}`;
if (confirm !== null && confirm !== token) {
  process.stderr.write(`REFUSED: --confirm "${confirm}" is not today's token. Nothing moved.\n`);
  process.exit(1);
}
const armed = confirm === token;

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\r?\n$/, '');
}
function gitOk(args) {
  try {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}
const sha1 = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');

// --- the paths ------------------------------------------------------------------
const wanted = [];
for (const raw of fs.readFileSync(pathsFile, 'utf8').split(/\r?\n/)) {
  let line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  line = line.replace(/^[-*]\s+/, '').replace(/^remove:\s*/i, '').replace(/`/g, '').trim();
  line = line.replace(/\\/g, '/').replace(/^\.\//, '');
  if (line && !wanted.includes(line)) wanted.push(line);
}
if (!wanted.length) {
  process.stderr.write(`no paths in ${pathsFile}\n`);
  process.exit(1);
}

// --- the report that named them ---------------------------------------------------
if (!reportFile) {
  const docs = path.join(repo, 'docs');
  const found = fs.existsSync(docs) ? fs.readdirSync(docs).filter((f) => /^entropy-\d{4}-\d{2}-\d{2}\.md$/i.test(f)).sort() : [];
  if (found.length) reportFile = path.join(docs, found[found.length - 1]);
}
const reportLines = reportFile && fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8').split(/\r?\n/) : [];
function reportLineFor(rel) {
  const hit = reportLines.find((l) => l.includes('`' + rel + '`'));
  return hit ? hit.replace(/\|/g, '/').slice(0, 300) : null;
}

// --- validate everything before moving anything -------------------------------------
const PROTECTED_NAMES = new Set(['claude.md', 'readme.md', 'notes.md', 'handoff.md', 'changelog.md', 'skill.md']);
// A repo's session file is protected like NOTES.md, by the definition the NOTES Stop hook and
// scan.js share: HANDOFF.md at any depth (the set above) and any HANDOFF*.md at the repo root.
// HANDOFF-<x>.md off the root stays movable: a dead snapshot is exactly what triage removes.
let sessionFile;
try {
  sessionFile = require('../../hooks/session-file.js');
} catch (err) {
  process.stderr.write('quarantine.js needs hooks/session-file.js beside the skills folder (run install.ps1, or run from the claude-os checkout)\n');
  process.exit(1);
}
const destRoot = path.join(path.dirname(repo), 'quarantine', `${path.basename(repo)}-${today}`);
const plan = [];
let refused = 0;
for (const rel of wanted) {
  const abs = path.resolve(repo, rel);
  const inside = path.relative(repo, abs);
  let why = null;
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) why = 'absolute path';
  else if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) why = 'escapes the repo';
  else if (/^\.(claude|git)(\/|$)/i.test(rel)) why = 'protected: under .claude/ or .git/';
  else if (PROTECTED_NAMES.has(path.basename(rel).toLowerCase())) why = 'protected file name';
  else if (!/[\\/]/.test(inside) && sessionFile.isSessionFile(inside)) why = 'protected: session file at the repo root';
  else if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) why = 'not a file on disk';
  else if (!gitOk(['ls-files', '--error-unmatch', '--', rel])) why = 'not tracked by git';
  else if (git(['status', '--porcelain', '--', rel])) why = 'has uncommitted changes; commit or restore it first';
  else if (fs.existsSync(path.join(destRoot, rel))) why = 'destination already exists';
  if (why) {
    console.log(`REFUSE  ${rel}: ${why}`);
    refused++;
    continue;
  }
  plan.push({ rel, abs, dest: path.join(destRoot, rel), sha1: sha1(abs), reportLine: reportLineFor(rel) });
}
for (const p of plan) {
  console.log(`${armed && !refused ? 'MOVE   ' : 'WOULD  '} ${p.rel} -> ${p.dest.replace(/\\/g, '/')}  sha1 ${p.sha1.slice(0, 12)}${p.reportLine ? '' : '  (no report line names it)'}`);
}
console.log(`report: ${reportFile ? reportFile.replace(/\\/g, '/') : 'none found'}`);
if (refused) {
  console.log(`\n${refused} refused, ${plan.length} acceptable. Nothing moved: fix or drop the refused paths and run again.`);
  process.exit(1);
}
if (!armed) {
  console.log(`\nDRY RUN: ${plan.length} file(s) would move. Nothing moved, nothing staged. To arm, today only: --confirm ${token}`);
  process.exit(0);
}

// --- the armed half -----------------------------------------------------------------
const manifest = path.join(destRoot, 'MANIFEST.md');
fs.mkdirSync(destRoot, { recursive: true });
if (!fs.existsSync(manifest)) {
  fs.writeFileSync(manifest, [
    `# Quarantine manifest: ${path.basename(repo)}, ${today}`,
    '',
    `Moved out of \`${repo.replace(/\\/g, '/')}\` by \`skills/entropy-sweep/quarantine.js\`. Nothing was deleted and nothing was committed; each removal is staged in that repo.`,
    `Undo one file: \`git -C ${repo.replace(/\\/g, '/')} restore --staged --worktree -- <source>\`. The copy here stays as the record.`,
    '',
    '| moved at | source | destination | sha1 | report line |',
    '|---|---|---|---|---|',
    '',
  ].join('\n'), 'utf8');
}
let moved = 0;
for (const p of plan) {
  try {
    fs.mkdirSync(path.dirname(p.dest), { recursive: true });
    fs.renameSync(p.abs, p.dest); // same volume by construction; a cross-device move fails loudly rather than copy-and-delete
    const after = sha1(p.dest);
    if (after !== p.sha1) throw new Error(`sha1 changed in the move: ${p.sha1} -> ${after}`);
    git(['rm', '--cached', '-q', '--', p.rel]);
    const line = `| ${new Date().toISOString()} | \`${p.rel}\` | \`${p.dest.replace(/\\/g, '/')}\` | ${p.sha1} | ${p.reportLine || `not named in ${reportFile ? path.basename(reportFile) : 'any report'}; added by triage`} |\n`;
    fs.appendFileSync(manifest, line.replace(/[^\x00-\x7F]/g, '?'), 'utf8');
    moved++;
  } catch (err) {
    console.log(`FAILED  ${p.rel}: ${err.message}`);
    console.log(`\n${moved} of ${plan.length} moved before the failure. Manifest: ${manifest.replace(/\\/g, '/')}`);
    process.exit(2);
  }
}
console.log(`\n${moved} moved. Manifest: ${manifest.replace(/\\/g, '/')}`);
console.log('Staged in the repo (git diff --cached --name-status), not committed:');
console.log(git(['diff', '--cached', '--name-status']));
