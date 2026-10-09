// Unit test for hooks/session-file.js, the definition shared by notes-stop.js
// and skills/entropy-sweep/scan.js. From the repo root:
//   node hooks/session-file.test.js

'use strict';

const path = require('path');
const { isSessionFile, handoffSuffix } = require(path.join(__dirname, 'session-file.js'));

const cases = [
  // [label, actual, expected]
  ['NOTES.md is a session file', isSessionFile('C:\\repo\\NOTES.md'), true],
  ['HANDOFF.md is a session file', isSessionFile('C:/repo/HANDOFF.md'), true],
  ['handoff.md lowercase counts', isSessionFile('handoff.md'), true],
  ['HANDOFF-<head>.md counts', isSessionFile('docs/orchestration/HANDOFF-devhead.md'), true],
  ['a folder named handoff does not count', isSessionFile('C:\\repo\\handoff\\plan.md'), false],
  ['handoff mid-name does not count', isSessionFile('C:\\repo\\my-handoff.md'), false],
  ['an ordinary doc does not count', isSessionFile('docs/architecture.md'), false],
  ['suffix of HANDOFF.md is empty', handoffSuffix('HANDOFF.md'), ''],
  ['suffix of HANDOFF-devhead.md', handoffSuffix('docs/orchestration/HANDOFF-devhead.md'), 'devhead'],
  ['suffix keeps inner dashes, lowercased', handoffSuffix('HANDOFF-DB-ERA.md'), 'db-era'],
  ['suffix of a non-handoff name is null', handoffSuffix('NOTES.md'), null],
];

let failed = 0;
for (const [label, actual, expected] of cases) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(actual)} expect=${JSON.stringify(expected)}`}`);
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
