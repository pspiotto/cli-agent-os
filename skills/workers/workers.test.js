'use strict';
// node skills/workers/workers.test.js - the pure parts only; nothing here talks to wmux.

const assert = require('assert');
const w = require('./workers.js');

const NBSP = String.fromCharCode(0xa0);
const RULE = String.fromCharCode(0x2500);
const claudeScreen = (name) =>
  `${RULE.repeat(40)} ${name} ${RULE}\n>${NBSP}\n${RULE.repeat(60)}\n  auto mode on (shift+tab to cycle)`;

let n = 0;
function check(name, fn) {
  fn();
  n++;
  console.log(`ok ${n} - ${name}`);
}

check('names: numbered only when a model repeats', () => {
  assert.deepStrictEqual(
    w.workerNames(['opus', 'opus', 'sonnet', 'fable'], 'ab').map((x) => x.name),
    ['ab-opus-worker1', 'ab-opus-worker2', 'ab-sonnet-worker', 'ab-fable-worker'],
  );
  assert.strictEqual(w.workerNames(['opus[1m]'], 'xy')[0].name, 'xy-opus1m-worker');
});

check('prefix: initials of a hyphenated folder, whole name otherwise; title is uppercase', () => {
  assert.strictEqual(w.initials('C:\\git\\web-app'), 'wa');
  assert.strictEqual(w.initials('C:\\git\\myproject'), 'myproject');
  assert.strictEqual(w.workspaceTitle('ab'), 'AB Workers');
});

check('screens: Claude, idle shell, empty, and something else', () => {
  assert.strictEqual(w.classifyPane(claudeScreen('ab-opus-worker1')), 'claude');
  assert.strictEqual(w.classifyPane('PS C:\\git\\web-app> '), 'shell');
  assert.strictEqual(w.classifyPane('user@HOST MINGW64 /c/git\n$ '), 'shell');
  assert.strictEqual(w.classifyPane(''), 'shell');
  assert.strictEqual(w.classifyPane('npm run gui\nlistening on 4777'), 'other');
});

check('session name and readiness', () => {
  assert.strictEqual(w.sessionName(claudeScreen('ab-sonnet-worker')), 'ab-sonnet-worker');
  assert.strictEqual(w.isReady(claudeScreen('x')), true);
  assert.strictEqual(w.isReady(claudeScreen('x') + '\n* Working (esc to interrupt)'), false);
  assert.strictEqual(w.isReady('Do you trust this folder?\n> 1. Yes'), false);
});

check('plan: no workspace creates one pane per worker', () => {
  const p = w.plan(w.workerNames(['opus', 'haiku'], 'ba'), null);
  assert.strictEqual(p.create, true);
  assert.deepStrictEqual(p.steps.map((s) => [s.newIndex, s.replaceTab]), [[0, true], [1, true]]);
  assert.throws(() => w.plan(w.workerNames(Array(9).fill('haiku'), 'ba'), null), /at most 8/);
});

check('plan: workers on screen are left alone, idle shells reused, other panes never touched', () => {
  const panes = [
    { paneId: 'p1', surfaces: [{ id: 's1', text: claudeScreen('ab-opus-worker1') }] },
    { paneId: 'p2', surfaces: [{ id: 's2', text: 'npm run gui\nlistening' }] },
    { paneId: 'p3', surfaces: [{ id: 's3', text: 'PS C:\\git> ' }] },
  ];
  const p = w.plan(w.workerNames(['opus', 'opus', 'sonnet'], 'ab'), panes);
  assert.deepStrictEqual(p.present, ['ab-opus-worker1']);
  assert.deepStrictEqual(
    p.steps.map((s) => [s.name, s.paneId, s.replaceTab]),
    [['ab-opus-worker2', 'p3', true], ['ab-sonnet-worker', 'p3', false]],
  );
});

check('plan: everything present means nothing to do', () => {
  const panes = [{ paneId: 'p1', surfaces: [{ id: 's1', text: claudeScreen('ab-fable-worker') }] }];
  assert.strictEqual(w.plan(w.workerNames(['fable'], 'ab'), panes).steps.length, 0);
});

check('spawn args carry model and session name; args parse', () => {
  const a = w.spawnArgs({ name: 'ab-opus-worker', model: 'opus', replaceTab: true }, 'p1', 'C:\\git\\x');
  assert.deepStrictEqual(a.slice(-2), ['--cmd', 'claude --model opus -n ab-opus-worker']);
  assert.ok(a.includes('--replace-tab'));
  assert.deepStrictEqual(w.parseArgs(['opus', 'haiku', '--prefix', 'AB', '--dry-run']), { models: ['opus', 'haiku'], prefix: 'ab', dryRun: true });
  assert.throws(() => w.parseArgs([]), /at least one model/);
  assert.throws(() => w.parseArgs(['opus; rm']), /not a model/);
});

console.log(`all ${n} checks passed`);
