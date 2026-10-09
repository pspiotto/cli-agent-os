#!/usr/bin/env node
// commit-tickets/group.js: assign every changed or untracked path in a git repo to a ticket key.
//
//   node group.js [repo] [--pattern <regex>] [--flags <regex flags>] [--lines <n>]
//
// Reads `git status --porcelain=v1 -z`, prints JSON, and that is all: it writes nothing and
// stages nothing. A path belongs to the key found in its path (the first folder-level key wins,
// then the file name); failing that, to a key found in the file's first lines; failing that, to
// `ungrouped`. The key pattern defaults to the generic Jira shape and a repo can override it
// with `.commit-tickets.json` at its root: { "pattern": "...", "flags": "", "lines": 30,
// "ignore": ["UTF-8"] }.
//
// No dependencies beyond Node and git on PATH.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_PATTERN = '[A-Z][A-Z0-9]+-[0-9]+';
const DEFAULT_LINES = 30;
// Shapes the generic pattern matches that are never ticket keys.
const DEFAULT_IGNORE = [
  'UTF-8', 'UTF-16', 'UTF-32', 'SHA-1', 'SHA-256', 'SHA-512', 'MD-5', 'ISO-8601', 'ISO-27001',
  'SOC-1', 'SOC-2', 'SOC-3', 'HTTP-2', 'HTTP-3', 'RFC-3339', 'RFC-2822', 'X-1', 'X-2',
  'PKCS-8', 'PKCS-12', 'AES-128', 'AES-256', 'RSA-2048', 'RSA-4096', 'COVID-19', 'ENV-1',
];
// yyyymmdd: a key whose number is a plausible date (1900 to 2099, month 01-12, day 01-31).
const DATE_TAIL = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;
// A session log (NOTES.md, HANDOFF*.md) is appended to, so its first lines are its oldest entry
// and say nothing about the current change. Never key one from content. The definition is the
// shared one in hooks/session-file.js (same relative path in the repo and under ~/.claude); if
// that file is missing, fall back to the same two name tests inline.
let isSessionFile;
try {
  ({ isSessionFile } = require(path.join(__dirname, '..', '..', 'hooks', 'session-file.js')));
} catch {
  isSessionFile = (p) => /^(notes\.md|handoff.*\.md)$/i.test(path.basename(String(p).replace(/\\/g, '/')));
}

const STATUS_WORDS = {
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'unmerged', '?': 'untracked', '!': 'ignored', T: 'type changed',
};

function readConfig(repo) {
  const file = path.join(repo, '.commit-tickets.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`.commit-tickets.json is not valid JSON: ${e.message}`);
  }
}

function buildMatcher(opts) {
  const pattern = opts.pattern || DEFAULT_PATTERN;
  const flags = (opts.flags || '').replace(/g/g, '');
  const ignore = new Set([...DEFAULT_IGNORE, ...(opts.ignore || [])].map((k) => k.toUpperCase()));
  // Not \b: an underscore is a word character, so \b would miss DATA-11_load.sql. A key may not
  // be preceded by a letter or digit, nor followed by a digit; anything else around it is fine.
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${pattern})(?![0-9])`, flags + 'g');
  return {
    pattern,
    flags,
    // every key in a string, in order of appearance, deduplicated, ignore list applied
    keysIn(text) {
      const out = [];
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const key = m[0].toUpperCase();
        if (ignore.has(key) || out.includes(key)) continue;
        // A date after the hyphen is a stamp, not a ticket: harness run records are named
        // <KEY>-<yyyymmdd>-<HHmm>.md and grouped as SF-20260930 on 2026-09-30 and 2026-10-02.
        if (DATE_TAIL.test(key.slice(key.lastIndexOf('-') + 1))) continue;
        out.push(key);
      }
      return out;
    },
  };
}

// `git status --porcelain=v1 -z` -> [{ status, path, from }]
function parsePorcelain(buf) {
  const parts = buf.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    const entry = { status: xy, path: p };
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      // in -z mode the original path follows as its own NUL-terminated record
      entry.from = parts[++i];
    }
    entries.push(entry);
  }
  return entries;
}

function statusWord(xy) {
  const x = xy[0], y = xy[1];
  if (xy === '??') return 'untracked';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'A') return y === 'M' ? 'added, modified' : 'added';
  return STATUS_WORDS[y !== ' ' ? y : x] || xy.trim();
}

// keys in the path: folder segments first (root outward), then the file name
function keysInPath(p, matcher) {
  const segs = p.split('/');
  const file = segs.pop();
  const folderKeys = [];
  for (const seg of segs) for (const k of matcher.keysIn(seg)) if (!folderKeys.includes(k)) folderKeys.push(k);
  const fileKeys = matcher.keysIn(file).filter((k) => !folderKeys.includes(k));
  return { folderKeys, fileKeys };
}

function keysInHead(repo, p, matcher, lines) {
  const abs = path.join(repo, p);
  let st;
  try { st = fs.statSync(abs); } catch { return []; }
  if (!st.isFile() || st.size === 0 || st.size > 1024 * 1024) return [];
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(Math.min(st.size, 64 * 1024));
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const head = buf.subarray(0, n);
  if (head.includes(0)) return []; // binary
  const text = head.toString('utf8').split(/\r?\n/).slice(0, lines).join('\n');
  return matcher.keysIn(text);
}

function assign(entry, repo, matcher, lines) {
  const p = entry.path;
  const { folderKeys, fileKeys } = keysInPath(p, matcher);
  const all = [...folderKeys, ...fileKeys];
  const rec = { path: p, status: statusWord(entry.status), xy: entry.status };
  if (entry.from) rec.from = entry.from;
  if (folderKeys.length) {
    rec.key = folderKeys[0];
    rec.source = 'folder';
  } else if (fileKeys.length) {
    rec.key = fileKeys[0];
    rec.source = 'filename';
  } else if (isSessionFile(p)) {
    rec.key = 'ungrouped';
    rec.source = 'session-file';
    rec.note = 'a session log is never keyed from its content; its first lines are its oldest entry';
  } else if (!/D/.test(entry.status)) {
    const headKeys = keysInHead(repo, p, matcher, lines);
    if (headKeys.length) {
      rec.key = headKeys[0];
      rec.source = 'content';
      if (headKeys.length > 1) rec.alsoMatches = headKeys.slice(1);
    }
  }
  if (!rec.key) {
    rec.key = 'ungrouped';
    rec.source = 'none';
  }
  if (rec.source === 'folder' || rec.source === 'filename') {
    const others = all.filter((k) => k !== rec.key);
    if (others.length) {
      rec.alsoMatches = others;
      rec.note = rec.source === 'folder'
        ? 'two or more keys in this path; the first folder-level key wins'
        : 'two or more keys in this file name; the first wins';
    }
  }
  return rec;
}

// folders that look like deployment environments, for the message body
function envFolders(paths) {
  const envs = new Set();
  const tops = new Set();
  for (const p of paths) {
    const segs = p.split('/');
    if (segs.length > 1) tops.add(segs[0]);
    for (const s of segs.slice(0, -1)) if (/^(dev|stg|stage|staging|qa|uat|prod|production)$/i.test(s)) envs.add(s.toLowerCase());
  }
  return { environments: [...envs].sort(), topFolders: [...tops].sort() };
}

function group(repo, overrides = {}) {
  repo = path.resolve(repo || process.cwd());
  const cfg = { ...readConfig(repo), ...overrides };
  const matcher = buildMatcher(cfg);
  const lines = Number(cfg.lines) > 0 ? Number(cfg.lines) : DEFAULT_LINES;
  const raw = execFileSync('git', ['-C', repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const entries = parsePorcelain(raw);
  const records = entries.map((e) => assign(e, repo, matcher, lines));
  const byKey = new Map();
  for (const r of records) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const groups = [];
  for (const [key, files] of byKey) {
    if (key === 'ungrouped') continue;
    const paths = files.map((f) => f.path);
    const { environments, topFolders } = envFolders(paths);
    groups.push({
      key,
      count: files.length,
      environments,
      topFolders,
      proposedSubject: `${key}: `,
      proposedBody: `${files.length} file(s)` + (environments.length ? `, environments: ${environments.join(', ')}` : '') + (topFolders.length ? `, folders: ${topFolders.join(', ')}` : ''),
      files,
    });
  }
  groups.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  const ungrouped = byKey.get('ungrouped') || [];
  return {
    repo,
    pattern: matcher.pattern,
    flags: matcher.flags,
    headLines: lines,
    changed: records.length,
    groups,
    ungrouped,
    note: 'group.js reads git status only. It stages nothing and writes nothing. ungrouped is never committed without a key assigned by hand.',
  };
}

function main(argv) {
  const args = argv.slice(2);
  const overrides = {};
  let repo;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pattern') overrides.pattern = args[++i];
    else if (a === '--flags') overrides.flags = args[++i];
    else if (a === '--lines') overrides.lines = args[++i];
    else if (a === '-h' || a === '--help') {
      console.log('usage: node group.js [repo] [--pattern <regex>] [--flags <flags>] [--lines <n>]');
      return 0;
    } else repo = a;
  }
  const result = group(repo, overrides);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

module.exports = { parsePorcelain, keysInPath, assign, group, buildMatcher, envFolders, statusWord, DEFAULT_PATTERN, DEFAULT_IGNORE };

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (e) {
    console.error(`group.js: ${e.message}`);
    process.exit(1);
  }
}
