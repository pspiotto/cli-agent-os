// Unit test for skills/glm-backend/glm.js and zai-key.js. Uses a throwaway home and project in
// the OS temp folder; never touches the real ~/.claude or any real project.
// From the repo root:
//   node skills/glm-backend/glm.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ENV, ENV_BUNDLE, STATE_FILE, keyFile, status, on, off } = require(path.join(__dirname, 'glm.js'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-backend-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
let n = 0;
const project = (name) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  return dir;
};
const settingsOf = (dir) => path.join(dir, '.claude', 'settings.local.json');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const opts = { home, env: {}, helper: 'node "/x/zai-key.js"' };
const check = (name, fn) => {
  fn();
  n++;
  console.log(`ok ${n} - ${name}`);
};

try {
  check('on without a key refuses and writes nothing', () => {
    const p = project('nokey');
    assert.throws(() => on(p, opts), /no Z.ai key/);
    assert.ok(!fs.existsSync(path.join(p, '.claude')));
  });

  fs.mkdirSync(path.dirname(keyFile(home)), { recursive: true });
  fs.writeFileSync(keyFile(home), 'test-key-123\n');

  check('on creates settings with every env value and the helper', () => {
    const p = project('fresh');
    const r = on(p, opts);
    assert.strictEqual(r.changed, true);
    const s = read(settingsOf(p));
    assert.deepStrictEqual(s.env, ENV);
    assert.strictEqual(s.apiKeyHelper, opts.helper);
    assert.ok(!JSON.stringify(s).includes('test-key-123'), 'key must never land in the project');
    assert.strictEqual(status(p, opts).on, true);
  });

  check('on twice is a no-op', () => {
    const p = path.join(root, 'fresh');
    const before = fs.readFileSync(settingsOf(p), 'utf8');
    assert.strictEqual(on(p, opts).changed, false);
    assert.strictEqual(fs.readFileSync(settingsOf(p), 'utf8'), before);
  });

  check('off removes a settings file that on created', () => {
    const p = path.join(root, 'fresh');
    off(p);
    assert.ok(!fs.existsSync(settingsOf(p)));
    assert.ok(!fs.existsSync(path.join(p, '.claude', STATE_FILE)));
    assert.strictEqual(status(p, opts).on, false);
    assert.strictEqual(off(p).changed, false);
  });

  check('round trip restores an existing file exactly, including replaced values', () => {
    const p = project('existing');
    fs.mkdirSync(path.join(p, '.claude'));
    const original = {
      permissions: { allow: ['Bash(npm test)'] },
      env: { FOO: 'bar', API_TIMEOUT_MS: '60000' },
      apiKeyHelper: 'old-helper',
    };
    fs.writeFileSync(settingsOf(p), JSON.stringify(original));
    const r = on(p, opts);
    assert.ok(r.notes.some((x) => x.includes('API_TIMEOUT_MS')));
    assert.ok(r.notes.some((x) => x.includes('apiKeyHelper')));
    const mid = read(settingsOf(p));
    assert.deepStrictEqual(mid.permissions, original.permissions);
    assert.strictEqual(mid.env.FOO, 'bar');
    off(p);
    assert.deepStrictEqual(read(settingsOf(p)), original);
  });

  check('off leaves a value that was edited by hand while on', () => {
    const p = project('drift');
    on(p, opts);
    const s = read(settingsOf(p));
    s.env.ANTHROPIC_MODEL = 'GLM-5.3-Flash';
    fs.writeFileSync(settingsOf(p), JSON.stringify(s));
    const r = off(p);
    assert.ok(r.notes.some((x) => x.includes('ANTHROPIC_MODEL')));
    const after = read(settingsOf(p));
    assert.deepStrictEqual(after.env, { ANTHROPIC_MODEL: 'GLM-5.3-Flash' });
    assert.strictEqual(after.apiKeyHelper, undefined);
  });

  check('on --bundle points every tier at glm-5.3 via the local proxy, and off undoes it', () => {
    const p = project('bundle');
    const r = on(p, { ...opts, bundle: true });
    assert.ok(r.notes.some((x) => x.includes('127.0.0.1:4000')));
    assert.deepStrictEqual(read(settingsOf(p)).env, ENV_BUNDLE);
    assert.strictEqual(status(p, opts).baseUrl, 'http://127.0.0.1:4000');
    off(p);
    assert.ok(!fs.existsSync(settingsOf(p)));
  });

  check('a settings file that does not parse is refused and left untouched', () => {
    const p = project('broken');
    fs.mkdirSync(path.join(p, '.claude'));
    fs.writeFileSync(settingsOf(p), '{ not json');
    assert.throws(() => on(p, opts), /does not parse/);
    assert.strictEqual(fs.readFileSync(settingsOf(p), 'utf8'), '{ not json');
    assert.ok(!fs.existsSync(path.join(p, '.claude', STATE_FILE)));
  });

  check('ZAI_API_KEY counts as a key source without the file', () => {
    const bare = path.join(root, 'barehome');
    fs.mkdirSync(bare);
    assert.strictEqual(status(project('envkey'), { home: bare, env: { ZAI_API_KEY: 'k' } }).key, 'ZAI_API_KEY');
  });

  check('on warns when settings.local.json is not gitignored', () => {
    const p = project('repo');
    execFileSync('git', ['-C', p, 'init', '-q']);
    // Claude Code adds settings.local.json to the machine's global ignore; point this repo at an
    // empty excludes file so the check sees only the repo itself.
    const empty = path.join(root, 'empty-excludes');
    fs.writeFileSync(empty, '');
    execFileSync('git', ['-C', p, 'config', 'core.excludesFile', empty]);
    const r = on(p, opts);
    assert.ok(r.notes.some((x) => x.includes('not gitignored')));
    off(p);
  });

  const helper = path.join(__dirname, 'zai-key.js');
  const runHelper = (env) =>
    spawnSync(process.execPath, [helper], { encoding: 'utf8', env: { ...process.env, ...env } });

  check('zai-key prints the file key with nothing else', () => {
    const r = runHelper({ USERPROFILE: home, HOME: home, ZAI_API_KEY: '' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, 'test-key-123');
  });

  check('zai-key prefers ZAI_API_KEY', () => {
    const r = runHelper({ USERPROFILE: home, HOME: home, ZAI_API_KEY: ' env-key ' });
    assert.strictEqual(r.stdout, 'env-key');
  });

  check('zai-key fails loudly with no key and prints nothing on stdout', () => {
    const bare = path.join(root, 'barehome');
    const r = runHelper({ USERPROFILE: bare, HOME: bare, ZAI_API_KEY: '' });
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stdout, '');
    assert.ok(r.stderr.includes('no key'));
  });

  console.log(`all ${n} checks passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
