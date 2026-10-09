// Unit tests for hooks/compact-recharter.js.
//   node hooks/compact-recharter.test.js
// Feeds each SessionStart payload to the hook on stdin and checks whether it
// printed the re-read block. Exits 1 if any case fails.
//
// The test builds its own charter list and charter file in a temp folder and
// points the hook at them through AGENT_OS_CHARTERS, so every case runs on any
// machine. The registered root stands for a git root holding many repos: the
// root itself matches exactly, only the charter project matches as a subtree.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hook = path.join(__dirname, 'compact-recharter.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recharter-test-'));
const root = path.join(tmp, 'gitroot');
const project = path.join(root, 'Steward');
fs.mkdirSync(project, { recursive: true });
const charter = path.join(project, 'CLAUDE.md');
fs.writeFileSync(charter, '# Steward charter\n');
const fwd = (p) => p.replace(/\\/g, '/');
const listFile = path.join(tmp, 'charters.json');
fs.writeFileSync(
  listFile,
  JSON.stringify([
    { exact: [fwd(root)], under: [fwd(project)], files: [fwd(charter)], note: 'Steward, the test charter.' },
    { exact: [fwd(path.join(tmp, 'moved'))], files: [fwd(path.join(tmp, 'moved', 'GONE.md'))], note: 'missing file' },
  ])
);

function run(payload, env) {
  const res = spawnSync(process.execPath, [hook], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: Object.assign({}, process.env, env || { AGENT_OS_CHARTERS: listFile }),
  });
  return { out: res.stdout || '', code: res.status };
}

// [label, payload, expectOutput]
const cases = [
  ['compact in the charter root names the charter', { source: 'compact', cwd: root }, true],
  ['the charter subtree matches too', { source: 'compact', cwd: path.join(project, 'log') }, true],
  ['upper case and forward slashes match', { source: 'compact', cwd: fwd(root).toUpperCase() }, true],
  ['a trailing slash still matches', { source: 'compact', cwd: root + '\\' }, true],
  ['startup is not a compaction: silent', { source: 'startup', cwd: root }, false],
  ['resume is not a compaction: silent', { source: 'resume', cwd: root }, false],
  ['clear is not a compaction: silent', { source: 'clear', cwd: root }, false],
  ['another repo in the root stays silent', { source: 'compact', cwd: path.join(root, 'other-repo') }, false],
  ['a sibling with the same prefix does not match', { source: 'compact', cwd: root + '_old' }, false],
  ['a charter whose file moved is silent', { source: 'compact', cwd: path.join(tmp, 'moved') }, false],
  ['an unrelated directory is silent', { source: 'compact', cwd: os.homedir() }, false],
  ['no cwd at all is silent', { source: 'compact' }, false],
  ['malformed JSON is silent', 'not json', false],
  ['empty stdin is silent', '', false],
];

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log('ok   ' + label);
    pass++;
  } else {
    console.log('FAIL ' + label + (detail ? ' (' + detail + ')' : ''));
    fail++;
  }
}

for (const [label, payload, expectOutput] of cases) {
  const { out, code } = run(payload);
  const printed = out.includes('Context was just compacted');
  check(label, code === 0 && printed === expectOutput, 'exit=' + code + ', printed=' + printed + ', expected=' + expectOutput);
}

// The block must name the charter path and its note, not only announce the compaction.
{
  const { out } = run({ source: 'compact', cwd: root });
  check('the block names the charter file and note', out.includes(path.normalize(charter)) && out.includes('Steward, the test charter.'));
}

// No charters.json at all (no overlay installed): silent.
{
  const { out, code } = run({ source: 'compact', cwd: root }, { AGENT_OS_CHARTERS: path.join(tmp, 'absent.json') });
  check('no charter list is silent', code === 0 && out === '');
}

// A list that is not an array is ignored, not a crash.
{
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{"exact": "x"}');
  const { out, code } = run({ source: 'compact', cwd: root }, { AGENT_OS_CHARTERS: bad });
  check('a malformed charter list is silent', code === 0 && out === '');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
