#!/usr/bin/env node
// cli-agent-os: block personal data from reaching this public repo.
//
//   node tools/leak-check.js --staged   added lines and paths of the staged diff,
//                                       plus the author identity (pre-commit)
//   node tools/leak-check.js --all      every tracked file (work tree copy), plus the
//                                       author identity of every commit (pre-push)
//
// The patterns are personal, so they never live here. The denylist is a text
// file in the owner's overlay: $AGENT_OS_DENYLIST, else <overlay>/leak-denylist.txt
// with the overlay path read from ~/.claude/overlay.txt (install.ps1 -Overlay).
// One JavaScript regex per line, matched case-insensitive; blank lines and
// lines starting with # are skipped; a line starting with ! is a path (relative
// to the repo root, forward slashes) whose content is exempt, such as NOTICE,
// which names the copyright holder on purpose; a line starting with = is an
// exact author or committer identity ("Name <email>") that is allowed, such as
// the owner's GitHub noreply identity. Every other identity is scanned.
//
// No denylist found is a failure, not a pass: a check that silently skips is a
// false clean run. AGENT_OS_LEAK_CHECK=off skips it on purpose, and says so.
//
// Exit 0 clean, 1 a hit or no denylist, 2 usage.
// Unit test: node tools/leak-check.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function denylistPath() {
  if (process.env.AGENT_OS_DENYLIST) return process.env.AGENT_OS_DENYLIST;
  const home = process.env.USERPROFILE || os.homedir();
  const ovFile = path.join(home, '.claude', 'overlay.txt');
  if (!fs.existsSync(ovFile)) return '';
  const ov = fs.readFileSync(ovFile, 'utf8').trim();
  return ov ? path.join(ov, 'leak-denylist.txt') : '';
}

function loadDenylist(file) {
  const patterns = [];
  const exempt = new Set();
  const identities = new Set();
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('!')) {
      exempt.add(line.slice(1).trim().replace(/\\/g, '/'));
      return;
    }
    if (line.startsWith('=')) {
      identities.add(line.slice(1).trim().toLowerCase());
      return;
    }
    try {
      patterns.push({ id: 'denylist line ' + (i + 1), re: new RegExp(line, 'i') });
    } catch (e) {
      throw new Error('denylist line ' + (i + 1) + ' is not a valid regex: ' + e.message);
    }
  });
  return { patterns, exempt, identities };
}

function scanIdentity(ident, label, patterns, identities, hits) {
  const id = ident.trim();
  if (identities.has(id.toLowerCase())) return;
  scanText(id, () => label + ' (' + id + ')', patterns, hits);
}

function scanText(text, where, patterns, hits) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const p of patterns) {
      if (p.re.test(line)) hits.push(where(i) + ': ' + p.id);
    }
  });
}

// Added lines of the staged diff, with their file and new line number.
function stagedAdded(cwd) {
  const out = git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR'], cwd);
  const result = [];
  let file = null;
  let lineNo = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(6);
    } else if (line.startsWith('@@')) {
      const m = /\+(\d+)/.exec(line);
      lineNo = m ? parseInt(m[1], 10) : 0;
    } else if (file && line.startsWith('+')) {
      result.push({ file, line: lineNo, text: line.slice(1) });
      lineNo++;
    }
  }
  return result;
}

function main(argv) {
  const mode = argv[2];
  if (mode !== '--staged' && mode !== '--all') {
    process.stderr.write('usage: node tools/leak-check.js --staged | --all\n');
    return 2;
  }
  if (process.env.AGENT_OS_LEAK_CHECK === 'off') {
    process.stderr.write('leak-check: SKIPPED (AGENT_OS_LEAK_CHECK=off)\n');
    return 0;
  }
  const file = denylistPath();
  if (!file || !fs.existsSync(file)) {
    process.stderr.write(
      'leak-check: no denylist found (' + (file || 'no ~/.claude/overlay.txt and no AGENT_OS_DENYLIST') + ').\n' +
        'Refusing to pass unchecked. Set AGENT_OS_DENYLIST, or AGENT_OS_LEAK_CHECK=off to skip on purpose.\n'
    );
    return 1;
  }
  const { patterns, exempt, identities } = loadDenylist(file);
  const cwd = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  const hits = [];

  if (mode === '--staged') {
    const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], cwd).split('\n').filter(Boolean);
    for (const n of names) scanText(n, () => 'path ' + n, patterns, hits);
    for (const a of stagedAdded(cwd)) {
      if (exempt.has(a.file)) continue;
      scanText(a.text, () => a.file + ':' + a.line, patterns, hits);
    }
    const strip = (s) => s.replace(/\s+\d+\s+[+-]\d{4}\s*$/, '');
    scanIdentity(strip(git(['var', 'GIT_AUTHOR_IDENT'], cwd)), 'author identity', patterns, identities, hits);
    scanIdentity(strip(git(['var', 'GIT_COMMITTER_IDENT'], cwd)), 'committer identity', patterns, identities, hits);
  } else {
    const names = git(['ls-files', '-z'], cwd).split('\0').filter(Boolean);
    for (const n of names) {
      scanText(n, () => 'path ' + n, patterns, hits);
      if (exempt.has(n)) continue;
      const full = path.join(cwd, n);
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch (e) {
        continue; // deleted in the work tree, a submodule, or unreadable
      }
      if (text.includes('\0')) continue; // binary
      scanText(text, (i) => n + ':' + (i + 1), patterns, hits);
    }
    let idents = '';
    try {
      idents = git(['log', '--format=%an <%ae>%n%cn <%ce>'], cwd);
    } catch (e) {
      idents = ''; // no commits yet
    }
    for (const id of new Set(idents.split('\n').filter(Boolean))) {
      scanIdentity(id, 'commit identity', patterns, identities, hits);
    }
  }

  if (hits.length === 0) {
    process.stdout.write('leak-check: clean (' + mode.slice(2) + ', ' + patterns.length + ' patterns)\n');
    return 0;
  }
  process.stderr.write('leak-check: ' + hits.length + ' hit(s); nothing personal may enter this repo:\n');
  for (const h of hits.slice(0, 50)) process.stderr.write('  ' + h + '\n');
  if (hits.length > 50) process.stderr.write('  ... and ' + (hits.length - 50) + ' more\n');
  return 1;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (e) {
    process.stderr.write('leak-check: ' + e.message + '\n');
    process.exit(1);
  }
}

module.exports = { loadDenylist, scanText, scanIdentity };
