#!/usr/bin/env node
// agent-os entropy sweep: the scanner half of /entropy-sweep (skills/entropy-sweep/SKILL.md).
//
// Walks ONE git repo and prints findings as JSON on stdout. It reasons about
// nothing, writes nothing, deletes nothing; the skill reads this JSON and
// writes the report. Every finding names the command or the git fact that
// produced it, so the report can quote evidence rather than opinion.
//
//   node skills/entropy-sweep/scan.js <repo> [--days 30] [--top 20] [--roots <dir>[,<dir>]]
//
// Checks (see the brief for the reasoning behind each):
//   1. unreferenced_markdown   tracked .md no other tracked file names; entry points exempt, and
//                              so is the repo's live session file, by the same definition the
//                              NOTES Stop hook uses (hooks/session-file.js): NOTES.md, a
//                              HANDOFF*.md at the repo root, or HANDOFF-<worker>.md anywhere when
//                              <worker> names a current worktree or branch. A HANDOFF-* whose
//                              worker is gone is a dead snapshot and still surfaces.
//   2. docs_older_than_code    a doc naming source paths whose newest commit is newer than the doc
//   3. last_verified           "Last verified: YYYY-MM-DD (machine) - checked against a, b" lines
//                              that predate the newest commit to the paths they name, plus the
//                              top-N most-loaded docs (by inbound references from CLAUDE.md, agent
//                              defs, charters, skills and queues) that carry no line at all
//   4. worktrees               git worktree entries whose dir is missing, whose branch is merged
//                              into the default branch, or with no commit in --days days
//   5. dead_agents             .claude/agents/*.md that no tracked file outside .claude/agents
//                              names. An agent some file references is never flagged. The
//                              "no worktree or branch" flag is added only when the repo has more
//                              than one worktree: in a single-worktree repo the definitions are
//                              Agent-tool subagents, not worktree workers.
//   6. divergent_duplicates    the same .md file name under two roots with different content
//                              (siblings of the repo's parent folder by default). A sibling that
//                              is a git worktree of ANY repo (.git is a file, not a folder) is
//                              skipped. Generic names (README, DESIGN, HANDOFF, DECISIONS, NOTES)
//                              pair only when the path relative to each repo root also matches
//                              AND the other folder is a plain folder or a repo sharing a root
//                              commit with this one (git rev-list --max-parents=0 HEAD).
//   7. unreachable_candidates  the cheap version only: a source file no import specifier names.
//                              Marked "candidate, not proof"; no call-graph reachability.
//                              Entry points by convention are exempt: *.config.*, and anything
//                              under a dev/, probes/ or examples/ folder (run directly by node/tsx).
//
// The three exemptions above are the false-positive classes the first live sweeps hit.
// The sweep's own reports (entropy-<date>.md) never count as a reference, a finding or a
// duplicate: a committed report names every finding and would hide it from the next sweep.
//
// Exit 0 on success, 1 on a usage error. Nothing under the repo is written.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// The one definition of a session file, shared with the NOTES Stop hook. Resolves the same
// way in the repo (skills/entropy-sweep -> hooks) and installed (~/.claude/skills/... -> ~/.claude/hooks).
let sessionFile;
try {
  sessionFile = require('../../hooks/session-file.js');
} catch (err) {
  process.stderr.write('scan.js needs hooks/session-file.js beside the skills folder (run install.ps1, or run from the claude-os checkout)\n');
  process.exit(1);
}

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
if (!argv.length || argv[0].startsWith('--')) {
  process.stderr.write('usage: node scan.js <repo> [--days 30] [--top 20] [--roots <dir>[,<dir>]]\n');
  process.exit(1);
}
const repo = path.resolve(argv[0]);
const opt = { days: 30, top: 20, roots: null };
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--days') opt.days = Number(argv[++i]);
  else if (argv[i] === '--top') opt.top = Number(argv[++i]);
  else if (argv[i] === '--roots') opt.roots = argv[++i].split(',').map((r) => path.resolve(r));
}
if (!fs.existsSync(path.join(repo, '.git'))) {
  process.stderr.write(`not a git repo (no .git): ${repo}\n`);
  process.exit(1);
}

// --- git helpers --------------------------------------------------------------
function git(args, cwd) {
  return execFileSync('git', args, { cwd: cwd || repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).replace(/\r?\n$/, '');
}
function gitOk(args, cwd) {
  try {
    execFileSync('git', args, { cwd: cwd || repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch (err) {
    return false;
  }
}

const BINARY = new Set(['.jar', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.exe', '.dll', '.class', '.woff', '.woff2']);
const ENTRY_MD = new Set(['readme.md', 'claude.md', 'notes.md', 'changelog.md', 'skill.md']);
const SOURCE_EXT = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx', '.py', '.java']);

const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
const trackedSet = new Set(tracked);
const content = new Map(); // rel -> text (text files only)
for (const rel of tracked) {
  if (BINARY.has(path.extname(rel).toLowerCase())) continue;
  try {
    const st = fs.statSync(path.join(repo, rel));
    if (st.size > 4 * 1024 * 1024) continue;
    content.set(rel, fs.readFileSync(path.join(repo, rel), 'utf8'));
  } catch (err) {
    // untracked-on-disk (deleted, worktree drift): skip
  }
}
const lower = new Map();
for (const [rel, text] of content) lower.set(rel, text.toLowerCase());

const base = (rel) => rel.split('/').pop();
const mdFiles = tracked.filter((r) => r.toLowerCase().endsWith('.md'));
const byBase = new Map();
for (const rel of tracked) {
  const b = base(rel);
  if (!byBase.has(b)) byBase.set(b, []);
  byBase.get(b).push(rel);
}

// Newest commit date per tracked path, one git log for the whole repo.
const lastCommit = new Map();
{
  const out = git(['log', '--format=@@COMMIT@@ %cI', '--name-only']);
  let date = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('@@COMMIT@@ ')) {
      date = line.slice('@@COMMIT@@ '.length).trim();
    } else if (line.trim() && date && !lastCommit.has(line.trim())) {
      lastCommit.set(line.trim(), date);
    }
  }
}
const commitDate = (rel) => lastCommit.get(rel) || null;

let defaultBranch = null;
try {
  defaultBranch = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
} catch (err) {
  defaultBranch = gitOk(['rev-parse', '--verify', '--quiet', 'refs/heads/main']) ? 'main' : 'master';
}

// Does any tracked text file OTHER than `self` mention `needle` (case-insensitive)?
// A committed sweep report names every finding of its own sweep, so it never counts as a
// reference (seen live: one repo's unreferenced count fell 21 to 1 once its report was
// committed), is never itself a finding, and is not a duplicate of another repo's report.
const SWEEP_REPORT = /(^|\/)entropy-\d{4}-\d{2}-\d{2}\.md$/i;
function referencedBy(needle, self) {
  const n = needle.toLowerCase();
  const hits = [];
  for (const [rel, text] of lower) {
    if (rel === self || SWEEP_REPORT.test(rel)) continue;
    if (text.includes(n)) hits.push(rel);
  }
  return hits;
}

// What another file must contain to count as naming `rel`: the bare file name
// when it is unique in the repo, otherwise the last two path segments
// (docs/goals/README.md is named by "goals/README.md", never by "README.md",
// which would credit every README with every other README's references).
function needleFor(rel) {
  const name = base(rel);
  const twins = (byBase.get(name) || []).length;
  if (twins <= 1) return name.toLowerCase();
  const parts = rel.split('/');
  return parts.slice(-2).join('/').toLowerCase();
}

// Worktrees and branches, read once: check 1 (live session files), check 4 and check 5 use them.
const worktrees = [];
{
  const out = git(['worktree', 'list', '--porcelain']);
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null };
      worktrees.push(cur);
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && line === 'detached') cur.branch = '(detached)';
  }
}
let branches = [];
try {
  branches = git(['branch', '--list', '--format=%(refname:short)']).split(/\r?\n/).filter(Boolean);
} catch (err) {
  branches = [];
}

// Is `rel` this repo's LIVE session file? Same name test as the NOTES Stop hook, narrowed so a
// dead HANDOFF-* snapshot still surfaces: any depth for NOTES.md (already an entry point), the
// repo root for HANDOFF*.md, and elsewhere only HANDOFF-<worker>.md whose <worker> names a
// current worktree or branch.
function liveSessionFile(rel) {
  if (!sessionFile.isSessionFile(base(rel))) return null;
  if (base(rel).toLowerCase() === 'notes.md') return 'NOTES.md';
  if (!rel.includes('/')) return 'HANDOFF*.md at the repo root';
  const worker = sessionFile.handoffSuffix(rel);
  if (!worker) return null;
  const wt = worktrees.find((w) => path.basename(w.path).toLowerCase().includes(worker) || (w.branch || '').toLowerCase().includes(worker));
  if (wt) return `worker "${worker}" has worktree ${wt.path.replace(/\\/g, '/')}`;
  const br = branches.find((b) => b.toLowerCase().includes(worker));
  return br ? `worker "${worker}" has branch ${br}` : null;
}
const sessionExempt = []; // { path, why }
for (const rel of mdFiles) {
  const why = liveSessionFile(rel);
  if (why && !ENTRY_MD.has(base(rel).toLowerCase())) sessionExempt.push({ path: rel, why });
}
const sessionExemptSet = new Set(sessionExempt.map((s) => s.path));

// --- 1. unreferenced markdown ----------------------------------------------
const unreferenced = [];
for (const rel of mdFiles) {
  const name = base(rel);
  if (ENTRY_MD.has(name.toLowerCase()) || rel.startsWith('.claude/agents/') || SWEEP_REPORT.test(rel) || sessionExemptSet.has(rel)) continue;
  const needle = needleFor(rel);
  const hits = referencedBy(needle, rel);
  if (hits.length === 0) {
    unreferenced.push({
      path: rel,
      lastCommit: commitDate(rel),
      evidence: `no tracked file other than itself contains "${needle}" (git ls-files | xargs grep -il "${needle}" returns only the file)`,
    });
  }
}

// --- 2. docs older than the code they describe ----------------------------
const PATH_TOKEN = /[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:mjs|cjs|js|ts|tsx|jsx|py|java|ps1|sh|json|sql|yml|yaml|txt|bat)\b/g;
function namedSourcePaths(rel) {
  const text = content.get(rel) || '';
  const found = new Set();
  for (const m of text.matchAll(PATH_TOKEN)) {
    const tok = m[0].replace(/^\.\//, '');
    if (tok.toLowerCase().endsWith('.md')) continue;
    if (trackedSet.has(tok) && tok !== rel) {
      found.add(tok);
      continue;
    }
    const cands = byBase.get(base(tok));
    if (cands && cands.length === 1 && cands[0] !== rel) found.add(cands[0]);
  }
  return [...found];
}
const docsOlder = [];
for (const rel of mdFiles) {
  const docDate = commitDate(rel);
  if (!docDate) continue;
  let newest = null;
  for (const p of namedSourcePaths(rel)) {
    const d = commitDate(p);
    if (d && d > docDate && (!newest || d > newest.date)) newest = { path: p, date: d };
  }
  if (newest) {
    docsOlder.push({
      doc: rel,
      docCommit: docDate,
      newerPath: newest.path,
      newerCommit: newest.date,
      evidence: `git log -1 --format=%cI -- ${rel} => ${docDate}; git log -1 --format=%cI -- ${newest.path} => ${newest.date}`,
    });
  }
}

// --- 3. last-verified lines and the top-N loaded docs ---------------------
const VERIFIED = /^Last verified:\s*(\d{4}-\d{2}-\d{2}|never)(?:\s*\(([^)]*)\))?(?:\s*-\s*checked against\s*(.+))?\s*$/im;
function verifiedLine(rel) {
  const head = (content.get(rel) || '').split(/\r?\n/).slice(0, 8).join('\n');
  const m = VERIFIED.exec(head);
  if (!m) return null;
  const against = m[3] ? m[3].split(/\s*,\s*/).map((s) => s.replace(/`/g, '').trim()).filter(Boolean) : [];
  return { date: m[1], machine: m[2] || null, against };
}
function isLoader(rel) {
  const b = base(rel).toLowerCase();
  return b === 'claude.md' || b === 'skill.md' || b === 'worker-charter.md' || b.includes('queue') || rel.startsWith('.claude/agents/');
}
const loaders = tracked.filter((r) => isLoader(r) && lower.has(r));
const inbound = [];
for (const rel of mdFiles) {
  const needle = needleFor(rel);
  const from = loaders.filter((l) => l !== rel && lower.get(l).includes(needle));
  if (from.length) inbound.push({ path: rel, inbound: from.length, needle, from });
}
inbound.sort((a, b) => b.inbound - a.inbound || a.path.localeCompare(b.path));
const topDocs = inbound.slice(0, opt.top).map((d) => ({ ...d, verified: verifiedLine(d.path) }));
const verifiedFindings = [];
for (const rel of mdFiles) {
  const v = verifiedLine(rel);
  if (!v || v.date === 'never') continue;
  let newest = null;
  for (const tok of v.against) {
    const p = trackedSet.has(tok) ? tok : ((byBase.get(base(tok)) || [])[0] || null);
    if (!p) continue;
    const d = commitDate(p);
    if (d && d.slice(0, 10) > v.date && (!newest || d > newest.date)) newest = { path: p, date: d };
  }
  if (newest) {
    verifiedFindings.push({
      kind: 'stale-by-own-admission',
      doc: rel,
      verified: v.date,
      newerPath: newest.path,
      newerCommit: newest.date,
      evidence: `"Last verified: ${v.date}" in ${rel}; git log -1 --format=%cI -- ${newest.path} => ${newest.date}`,
    });
  }
}
for (const d of topDocs) {
  if (!d.verified) {
    verifiedFindings.push({
      kind: 'top-doc-without-line',
      doc: d.path,
      inbound: d.inbound,
      evidence: `loaded by ${d.inbound} loader file(s) (${d.from.join(', ')}); no "Last verified:" line in its first 8 lines`,
    });
  }
}

// --- 4. worktrees ------------------------------------------------------------
const mainWorktree = worktrees.length ? worktrees[0].path : null;
const now = Date.now();
const worktreeAll = worktrees.map((w) => {
  const flags = [];
  const missing = !fs.existsSync(w.path);
  let last = null;
  try {
    last = git(['log', '-1', '--format=%cI', w.head]);
  } catch (err) {
    last = null;
  }
  const days = last ? Math.floor((now - Date.parse(last)) / 86400000) : null;
  const merged = w.path !== mainWorktree && w.head ? gitOk(['merge-base', '--is-ancestor', w.head, defaultBranch]) : false;
  if (missing) flags.push('directory missing');
  if (merged) flags.push(`fully merged into ${defaultBranch}`);
  if (days !== null && days > opt.days) flags.push(`no commit in ${days} days`);
  return { path: w.path, branch: w.branch, head: w.head, lastCommit: last, daysSinceCommit: days, flags,
    evidence: `git worktree list --porcelain; git log -1 --format=%cI ${w.head} => ${last}; git merge-base --is-ancestor ${w.head} ${defaultBranch} => ${merged ? 'yes' : 'no'}` };
});
const worktreeFindings = worktreeAll.filter((w) => w.flags.length);

// --- 5. dead agent definitions ------------------------------------------------
const agentDir = path.join(repo, '.claude', 'agents');
const deadAgents = [];
const agentDefs = fs.existsSync(agentDir) ? fs.readdirSync(agentDir).filter((f) => f.toLowerCase().endsWith('.md')) : [];
for (const f of agentDefs) {
  const name = f.replace(/\.md$/i, '');
  const rel = `.claude/agents/${f}`;
  const n = name.toLowerCase();
  const wt = worktrees.filter((w) => path.basename(w.path).toLowerCase().includes(n) || (w.branch || '').toLowerCase().includes(n)).map((w) => w.path);
  const br = branches.filter((b) => b.toLowerCase().includes(n));
  const refs = referencedBy(name, rel).filter((r) => !r.startsWith('.claude/agents/'));
  if (refs.length) continue; // an agent some file references is never flagged
  const flags = ['no charter, queue or doc references the name'];
  // Only a repo that runs workers in worktrees owes each agent a worktree or branch.
  if (worktrees.length > 1 && !wt.length && !br.length) flags.push('no worktree or branch carries the name');
  deadAgents.push({ agent: rel, worktrees: wt, branches: br, referencedBy: [], flags,
    evidence: `git worktree list + git branch --list filtered on "${name}"; grep -ril "${name}" over git ls-files excluding .claude/agents` });
}

// --- 6. divergent duplicates -------------------------------------------------
const sha1 = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'out', '.next', 'coverage', 'jagexcache', 'quarantine']); // quarantine: where quarantine.js puts what a sweep removed
const worktreePaths = new Set(worktrees.map((w) => path.resolve(w.path).toLowerCase()));
const roots = opt.roots || [path.dirname(repo)];
// A live session file is no duplicate either (same exemption as check 1): every repo's
// HANDOFF.md differs from every other's by design. A name is dropped only when every file
// carrying it in this repo is a live session file.
const dupNames = new Set(mdFiles.filter((r) => !sessionExemptSet.has(r)).map(base).filter((b) => !ENTRY_MD.has(b.toLowerCase()) && !SWEEP_REPORT.test(b)));
// Names every repo has one of: two unrelated repos each holding a DESIGN.md is not a duplicate.
const GENERIC_MD = new Set(['readme.md', 'design.md', 'handoff.md', 'decisions.md', 'notes.md']);
const foreign = new Map(); // basename -> [{ path, rel }], rel is relative to the copy's own repo root
const skippedWorktrees = [];
let walked = 0;
function walk(dir, depth, rootDir) {
  if (depth > 6 || walked > 40000) return;
  const abs = path.resolve(dir).toLowerCase();
  if (abs === repo.toLowerCase() || worktreePaths.has(abs)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  const dotGit = entries.find((e) => e.name === '.git');
  if (dotGit && dotGit.isFile()) {
    // A worktree of some repo (this one's are caught above): its files are that repo's, not copies.
    skippedWorktrees.push(dir);
    return;
  }
  if (dotGit || depth === 1) rootDir = dir;
  for (const e of entries) {
    walked++;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1, rootDir);
    } else if (e.isFile() && dupNames.has(e.name)) {
      if (!foreign.has(e.name)) foreign.set(e.name, []);
      foreign.get(e.name).push({ path: p, root: rootDir || dir, rel: path.relative(rootDir || dir, p).replace(/\\/g, '/').toLowerCase() });
    }
  }
}
for (const r of roots) walk(r, 0, null);
// Is the folder a copy of THIS repo? A plain folder may be (a hand-made copy); a git repo is
// only when it shares a root commit with this one. Two unrelated repos that each keep a root
// HANDOFF.md are not duplicates of each other.
const rootCommits = (cwd) => {
  try {
    return git(['rev-list', '--max-parents=0', 'HEAD'], cwd).split(/\r?\n/).filter(Boolean);
  } catch (err) {
    return [];
  }
};
const ownRoots = new Set(rootCommits(repo));
const relatedCache = new Map();
const unrelatedRepos = [];
function relatedRoot(root) {
  if (!relatedCache.has(root)) {
    const isRepo = fs.existsSync(path.join(root, '.git'));
    const related = !isRepo || rootCommits(root).some((c) => ownRoots.has(c));
    if (!related) unrelatedRepos.push(root);
    relatedCache.set(root, related);
  }
  return relatedCache.get(root);
}
const duplicates = [];
function pushIfDivergent(name, all) {
  if (all.length < 2) return;
  const hashes = all.map((p) => { try { return { path: p, sha1: sha1(p) }; } catch (err) { return null; } }).filter(Boolean);
  const distinct = new Set(hashes.map((h) => h.sha1));
  if (distinct.size > 1) {
    duplicates.push({ name, copies: hashes, evidence: `sha1sum on each copy; ${distinct.size} distinct hashes across ${hashes.length} files` });
  }
}
for (const name of dupNames) {
  const inRepo = mdFiles.filter((r) => base(r) === name);
  const others = foreign.get(name) || [];
  if (GENERIC_MD.has(name.toLowerCase())) {
    // Generic name: a copy counts only when it sits at the same relative path, in a plain
    // folder or in a repo that shares history with this one.
    for (const r of inRepo) {
      const same = others.filter((o) => o.rel === r.toLowerCase() && relatedRoot(o.root)).map((o) => o.path);
      pushIfDivergent(r, [path.join(repo, r)].concat(same));
    }
  } else {
    pushIfDivergent(name, inRepo.map((r) => path.join(repo, r)).concat(others.map((o) => o.path)));
  }
}

// --- 7. unreachable code, cheap version --------------------------------------
const SPEC = /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const specBases = new Set();
for (const [rel, text] of content) {
  if (!SOURCE_EXT.has(path.extname(rel).toLowerCase())) continue;
  for (const m of text.matchAll(SPEC)) {
    const spec = m[1];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // package imports are not files here
    specBases.add(base(spec).replace(/\.[^.]+$/, '').toLowerCase());
  }
}
const unreachable = [];
const conventionExempt = []; // entry points by convention: nothing imports them, a tool or a person runs them
for (const rel of tracked) {
  const ext = path.extname(rel).toLowerCase();
  if (!SOURCE_EXT.has(ext)) continue;
  const name = base(rel);
  const stem = name.replace(/\.[^.]+$/, '').toLowerCase();
  if (/^(index|main|app|server|cli)$/.test(stem) || /\.(test|spec)$/.test(stem)) continue;
  if (/^(hooks|scripts?|bin|tools?)\//.test(rel)) continue;
  if (/\.config$/.test(stem) || /(^|\/)(dev|probes|examples)\//.test(rel)) {
    conventionExempt.push(rel);
    continue;
  }
  if (specBases.has(stem)) continue;
  // Named by a non-source file (package.json scripts, a doc, a .ps1 or .sh runner) counts as reachable.
  const mentioned = referencedBy(name, rel).filter((r) => !SOURCE_EXT.has(path.extname(r).toLowerCase()));
  if (mentioned.length) continue;
  unreachable.push({ path: rel, lastCommit: commitDate(rel), status: 'candidate, not proof',
    evidence: `no relative import specifier in the repo resolves to "${stem}", and no non-source tracked file names "${name}"` });
}

// --- output ---------------------------------------------------------------------
const result = {
  repo,
  scannedAt: new Date().toISOString(),
  defaultBranch,
  tracked: tracked.length,
  markdown: mdFiles.length,
  options: opt,
  checks: {
    unreferenced_markdown: { command: 'git ls-files; grep -il <basename> over every other tracked file',
      note: `Exempt as this repo's live session file (hooks/session-file.js, the NOTES Stop hook's definition; HANDOFF-<worker>.md off the root only while <worker> has a worktree or branch): ${sessionExempt.length ? sessionExempt.map((s) => `${s.path} (${s.why})`).join(', ') : 'none beyond NOTES.md'}.`,
      sessionExempt, findings: unreferenced },
    docs_older_than_code: { command: 'git log --format=%cI --name-only, newest date per path; doc vs the source paths it names', findings: docsOlder },
    last_verified: { command: 'Last verified: line in the first 8 lines; inbound references from CLAUDE.md, .claude/agents, WORKER-CHARTER.md, SKILL.md, *queue*', topDocs, findings: verifiedFindings },
    worktrees: { command: `git worktree list --porcelain; git log -1; git merge-base --is-ancestor <head> ${defaultBranch}; threshold ${opt.days} days`, all: worktreeAll, findings: worktreeFindings },
    dead_agents: { command: '.claude/agents/*.md vs git worktree list, git branch --list, grep -ril over tracked files',
      note: `${agentDefs.length} definition(s) read. One that any tracked file outside .claude/agents names is never flagged; the worktree-or-branch flag applies only to repos with more than one worktree (this repo has ${worktrees.length}).`,
      findings: deadAgents },
    divergent_duplicates: { command: `same .md basename under ${roots.join(', ')} (worktrees skipped); sha1 per copy`,
      note: `Skipped as git worktrees (.git is a file): ${skippedWorktrees.length ? skippedWorktrees.map((p) => p.replace(/\\/g, '/')).join(', ') : 'none'}. Generic names (${[...GENERIC_MD].join(', ')}) pair only when the path relative to each repo root matches and the other folder is not an unrelated git repo (no shared root commit)${unrelatedRepos.length ? '; unrelated here: ' + unrelatedRepos.map((p) => p.replace(/\\/g, '/')).join(', ') : ''}.`,
      skippedWorktrees, unrelatedRepos, findings: duplicates },
    unreachable_candidates: { command: 'relative import/require specifiers vs source file stems; entry points, tests, hooks/, scripts/, *.config.*, dev/, probes/, examples/ exempt', status: 'candidate, not proof',
      note: `Exempt as entry points by convention (*.config.*, or under dev/, probes/, examples/): ${conventionExempt.length} file(s), not checked.`,
      conventionExempt, findings: unreachable },
  },
  summary: {
    unreferenced_markdown: unreferenced.length,
    docs_older_than_code: docsOlder.length,
    last_verified: verifiedFindings.length,
    worktrees: worktreeFindings.length,
    dead_agents: deadAgents.length,
    divergent_duplicates: duplicates.length,
    unreachable_candidates: unreachable.length,
  },
};
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
