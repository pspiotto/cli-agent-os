// Unit test for skills/commit-tickets/group.js. Builds a throwaway git repo in the OS temp
// folder, makes every change shape the grouper must handle, runs it, and removes the repo.
// From the repo root:
//   node skills/commit-tickets/group.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { group, parsePorcelain, keysInPath, buildMatcher } = require(path.join(__dirname, 'group.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-tickets-'));
const git = (...a) => execFileSync('git', ['-C', tmp, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel, text) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

const cases = [];
const check = (label, actual, expected) => cases.push([label, actual, expected]);
const byPath = (res, p) => [...res.groups.flatMap((g) => g.files), ...res.ungrouped].find((f) => f.path === p);
const groupKeys = (res) => res.groups.map((g) => g.key);

try {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'commit-tickets test');
  git('config', 'core.autocrlf', 'false');

  // baseline commit
  write('DATA-10/a.sql', 'select 1;\n');
  write('x/y.sql', 'select 2;\n');
  write('old name.sql', 'select 3;\n');
  write('notes/PROJ-5 spec.md', '# spec\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  const statusBefore = git('status', '--porcelain=v1');

  // the change shapes
  write('DATA-10/a.sql', 'select 10;\n');                                   // key in a folder name
  write('scripts/DATA-11_load.sql', 'copy into t;\n');                       // key in a file name
  write('DATA-12/sub/DATA-13_fix.sql', 'select 12;\n');                      // two keys, folder + file
  write('DATA-14/DATA-15/x.sql', 'select 14;\n');                            // two keys, both folders
  write('plain/c.sql', 'select 1;\n');                                       // no key anywhere
  write('plain/d.sql', '-- DATA-16 backfill of the thing\nselect 16;\n');    // key in the first lines
  write('plain/e.sql', '-- see DATA-18 and DATA-19\nselect 18;\n');          // two keys in content
  git('mv', 'old name.sql', 'DATA-17 new name.sql');                         // a rename, spaces, key in new name
  git('rm', '-q', 'x/y.sql');                                                // a deleted file
  write('notes/PROJ-5 spec.md', '# spec v2\n');                              // path with spaces
  write('plain/UTF-8 notes.md', 'SHA-256 and ISO-8601 are not tickets\n');   // ignore list
  write('DATA-10/dev/deploy.sql', 'select 0;\n');                            // environment folder
  write('plain/bin.dat', Buffer.from([0x00, 0x01, 0x02, 0x44, 0x41, 0x54, 0x41, 0x2d, 0x39, 0x39])); // binary with key bytes
  write('NOTES.md', '# NOTES\n\n## 2026-01-01 - DATA-1 oldest entry\n\n## 2026-09-25 - DATA-2 newest entry\n'); // session log: head is the oldest entry
  write('docs/HANDOFF-worker.md', '# handoff\nDATA-3 in the head\n');                                       // handoff file, same rule
  write('DATA-20/NOTES.md', '# notes\nDATA-21 in the head\n');                                              // session log under a keyed folder: path wins
  write('harness/runs/AZURE_TO_SF-20261001-1738-verify.md', '# record\n');                                 // date-stamped record name: SF-20261001 is not a key
  write('harness/runs/RED-20260930-1304.md', '# record\n');                                                // same shape, bare

  const res = group(tmp);
  const statusAfter = git('status', '--porcelain=v1');

  check('grouper is read-only: git status unchanged', statusAfter, git('status', '--porcelain=v1'));
  // only the test's own git mv and git rm are staged (a rename lists its new name once)
  check('grouper is read-only: nothing staged by it', git('diff', '--cached', '--name-only').trim(), 'DATA-17 new name.sql\nx/y.sql');
  check('key in a folder name', [byPath(res, 'DATA-10/a.sql').key, byPath(res, 'DATA-10/a.sql').source], ['DATA-10', 'folder']);
  check('key in a file name', [byPath(res, 'scripts/DATA-11_load.sql').key, byPath(res, 'scripts/DATA-11_load.sql').source], ['DATA-11', 'filename']);
  check('two keys, folder wins over file name', byPath(res, 'DATA-12/sub/DATA-13_fix.sql').key, 'DATA-12');
  check('two keys, the JSON says so', byPath(res, 'DATA-12/sub/DATA-13_fix.sql').alsoMatches, ['DATA-13']);
  check('two keys, note names the rule', /first folder-level key wins/.test(byPath(res, 'DATA-12/sub/DATA-13_fix.sql').note), true);
  check('two folder keys, first folder wins', [byPath(res, 'DATA-14/DATA-15/x.sql').key, byPath(res, 'DATA-14/DATA-15/x.sql').alsoMatches], ['DATA-14', ['DATA-15']]);
  check('no key goes to ungrouped', byPath(res, 'plain/c.sql').key, 'ungrouped');
  check('ungrouped is its own list, not a group', groupKeys(res).includes('ungrouped'), false);
  check('key in the first lines', [byPath(res, 'plain/d.sql').key, byPath(res, 'plain/d.sql').source], ['DATA-16', 'content']);
  check('two content keys, first wins and the rest are listed', [byPath(res, 'plain/e.sql').key, byPath(res, 'plain/e.sql').alsoMatches], ['DATA-18', ['DATA-19']]);
  check('a rename carries from and status', [byPath(res, 'DATA-17 new name.sql').status, byPath(res, 'DATA-17 new name.sql').from], ['renamed', 'old name.sql']);
  check('a rename is keyed on the new name', byPath(res, 'DATA-17 new name.sql').key, 'DATA-17');
  check('a deleted file is listed and not read', [byPath(res, 'x/y.sql').status, byPath(res, 'x/y.sql').key], ['deleted', 'ungrouped']);
  check('a path with spaces survives', [byPath(res, 'notes/PROJ-5 spec.md').key, byPath(res, 'notes/PROJ-5 spec.md').status], ['PROJ-5', 'modified']);
  check('ignore list: UTF-8, SHA-256, ISO-8601 are not keys', byPath(res, 'plain/UTF-8 notes.md').key, 'ungrouped');
  check('binary content is not scanned', byPath(res, 'plain/bin.dat').key, 'ungrouped');
  check('environment folder named in the group', res.groups.find((g) => g.key === 'DATA-10').environments, ['dev']);
  check('a session log is never keyed from its content', [byPath(res, 'NOTES.md').key, byPath(res, 'NOTES.md').source], ['ungrouped', 'session-file']);
  check('a handoff file is a session log too', [byPath(res, 'docs/HANDOFF-worker.md').key, byPath(res, 'docs/HANDOFF-worker.md').source], ['ungrouped', 'session-file']);
  check('a session log under a keyed folder takes the folder key', [byPath(res, 'DATA-20/NOTES.md').key, byPath(res, 'DATA-20/NOTES.md').source], ['DATA-20', 'folder']);
  check('groups sorted by key, numerically', groupKeys(res), ['DATA-10', 'DATA-11', 'DATA-12', 'DATA-14', 'DATA-16', 'DATA-17', 'DATA-18', 'DATA-20', 'PROJ-5']);
  check('every changed path is accounted for', res.changed, res.groups.reduce((n, g) => n + g.count, 0) + res.ungrouped.length);
  check('proposed subject is KEY and a colon', res.groups[0].proposedSubject, 'DATA-10: ');
  check('nothing was written into the repo', fs.existsSync(path.join(tmp, '.commit-tickets.json')), false);

  // repo override: pattern and flags
  write('.commit-tickets.json', JSON.stringify({ pattern: 'DATA-[0-9]+', flags: 'i' }));
  write('plain/lower.sql', '-- data-99 lower-case key\nselect 99;\n');
  const res2 = group(tmp);
  check('override: case-insensitive content key is upper-cased', byPath(res2, 'plain/lower.sql').key, 'DATA-99');
  check('override: a key outside the pattern is ungrouped', byPath(res2, 'notes/PROJ-5 spec.md').key, 'ungrouped');
  check('override: pattern reported', res2.pattern, 'DATA-[0-9]+');
  const res3 = group(tmp, { pattern: 'PROJ-[0-9]+' });
  check('command-line pattern beats the config file', [byPath(res3, 'notes/PROJ-5 spec.md').key, byPath(res3, 'DATA-10/a.sql').key], ['PROJ-5', 'ungrouped']);

  // pure functions
  const m = buildMatcher({});
  check('parsePorcelain: rename record consumes the next NUL field', parsePorcelain('R  new.sql\0old.sql\0?? other.sql\0'), [{ status: 'R ', path: 'new.sql', from: 'old.sql' }, { status: '??', path: 'other.sql' }]);
  check('keysInPath: folder keys before file keys', keysInPath('AB-1/BC-2/CD-3 DE-4.sql', m), { folderKeys: ['AB-1', 'BC-2'], fileKeys: ['CD-3', 'DE-4'] });
  check('default pattern is case-sensitive', m.keysIn('data-1 DATA-2'), ['DATA-2']);
  check('underscore after the key does not hide it', m.keysIn('DATA-11_load.sql'), ['DATA-11']);
  check('a glued prefix joins the key and digits are greedy, so DATA-11 is not found inside DATA-119', m.keysIn('XDATA-11 DATA-119 vs DATA-11'), ['XDATA-11', 'DATA-119', 'DATA-11']);
  check('one-letter prefix is not a key under the default pattern', m.keysIn('A-1'), []);
  check('a date-stamped record name is not keyed', [byPath(res, 'harness/runs/AZURE_TO_SF-20261001-1738-verify.md').key, byPath(res, 'harness/runs/RED-20260930-1304.md').key], ['ungrouped', 'ungrouped']);
  check('keysIn: yyyymmdd tails are dropped, other long numbers kept', m.keysIn('SF-20261001 RED-20260930 DATA-20261 DATA-99991231 XY-20261301'), ['DATA-20261', 'DATA-99991231', 'XY-20261301']);

  void statusBefore;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

let failed = 0;
for (const [label, actual, expected] of cases) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(actual)} expect=${JSON.stringify(expected)}`}`);
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
