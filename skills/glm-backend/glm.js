// Turns the Z.ai GLM backend on or off for one project by editing that project's
// .claude/settings.local.json. Every key it sets is recorded, with the value it replaced, in
// .claude/glm-backend.state.json, so "off" puts back exactly what was there before.
// The API key is never written into the project: settings point apiKeyHelper at zai-key.js,
// which reads ZAI_API_KEY or ~/.claude/secrets/zai-api-key.txt at request time.
//
//   node glm.js status [projectDir]
//   node glm.js on     [projectDir]
//   node glm.js off    [projectDir]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Values from Z.ai's Claude Code guide (docs.z.ai/devpack/tool/claude, read 2026-09-30).
// ANTHROPIC_MODEL is ours: it outranks a "model" pinned in ~/.claude/settings.json (for example
// "opus[1m]"), so the session starts on GLM without relying on alias mapping alone.
const ENV = {
  ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
  ANTHROPIC_MODEL: 'GLM-5.3',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'GLM-5.3',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'GLM-5.3',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'GLM-5.3-Flash',
  API_TIMEOUT_MS: '3000000',
};

// Bundle mode ("on --bundle"): the Coding Plan endpoint above only ever draws plan quota, never
// a pay-as-you-go usage bundle (docs.z.ai/devpack/faq). This points at the local LiteLLM proxy
// (proxy/litellm.yaml), which uses Coding Plan quota (api/coding/paas/v4) first and falls back to
// api/paas/v4, which does, on a 429. Every tier is glm-5.3 because the bundle covers glm-5.3 only.
const ENV_BUNDLE = {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
  ANTHROPIC_MODEL: 'glm-5.3',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3',
  API_TIMEOUT_MS: '3000000',
};

const STATE_FILE = 'glm-backend.state.json';

function keyFile(home) {
  return path.join(home, '.claude', 'secrets', 'zai-api-key.txt');
}

function keyAvailable(home, env) {
  if (env.ZAI_API_KEY && env.ZAI_API_KEY.trim()) return 'ZAI_API_KEY';
  const f = keyFile(home);
  if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim()) return f;
  return null;
}

function helperCommand() {
  const script = path.join(__dirname, 'zai-key.js').split(path.sep).join('/');
  return `node "${script}"`;
}

function paths(projectDir) {
  const dir = path.join(projectDir, '.claude');
  return {
    dir,
    settings: path.join(dir, 'settings.local.json'),
    state: path.join(dir, STATE_FILE),
  };
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} does not parse (${e.message}); fix it by hand, nothing was changed`);
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function gitIgnored(projectDir, file) {
  try {
    execFileSync('git', ['-C', projectDir, 'check-ignore', '-q', file], { stdio: 'ignore' });
    return 'ignored';
  } catch (e) {
    if (e.status === 1) return 'not-ignored';
    return 'not-a-repo';
  }
}

function status(projectDir, opts = {}) {
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const p = paths(projectDir);
  const state = readJson(p.state);
  const settings = readJson(p.settings) || {};
  return {
    project: projectDir,
    on: state !== null,
    enabledAt: state ? state.enabledAt : null,
    key: keyAvailable(home, env),
    baseUrl: (settings.env || {}).ANTHROPIC_BASE_URL || null,
    model: (settings.env || {}).ANTHROPIC_MODEL || null,
  };
}

function on(projectDir, opts = {}) {
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const helper = opts.helper || helperCommand();
  const values = opts.bundle ? ENV_BUNDLE : ENV;
  const p = paths(projectDir);

  if (fs.existsSync(p.state)) return { changed: false, notes: ['already on; nothing changed'] };

  if (!keyAvailable(home, env)) {
    throw new Error(
      `no Z.ai key: set ZAI_API_KEY or put the key alone in ${keyFile(home)}; nothing was changed`
    );
  }

  const existed = fs.existsSync(p.settings);
  const settings = readJson(p.settings) || {};
  const prior = {
    apiKeyHelper: Object.prototype.hasOwnProperty.call(settings, 'apiKeyHelper') ? settings.apiKeyHelper : null,
    env: {},
  };
  settings.env = settings.env || {};
  for (const [k, v] of Object.entries(values)) {
    prior.env[k] = Object.prototype.hasOwnProperty.call(settings.env, k) ? settings.env[k] : null;
    settings.env[k] = v;
  }
  settings.apiKeyHelper = helper;

  fs.mkdirSync(p.dir, { recursive: true });
  writeJson(p.settings, settings);
  writeJson(p.state, {
    enabledAt: new Date().toISOString(),
    createdSettingsFile: !existed,
    set: { apiKeyHelper: helper, env: values },
    prior,
  });

  const notes = [];
  if (opts.bundle) notes.push('bundle mode: the LiteLLM proxy must be listening on 127.0.0.1:4000 (proxy/start-proxy.ps1)');
  for (const [k, v] of Object.entries(prior.env)) {
    if (v !== null && v !== values[k]) notes.push(`replaced env.${k} (was "${v}"); off restores it`);
  }
  if (prior.apiKeyHelper !== null) notes.push(`replaced apiKeyHelper (was "${prior.apiKeyHelper}"); off restores it`);
  if (gitIgnored(projectDir, '.claude/settings.local.json') === 'not-ignored') {
    notes.push('.claude/settings.local.json is not gitignored; it holds no key, but add it before committing');
  }
  return { changed: true, notes };
}

function off(projectDir) {
  const p = paths(projectDir);
  const state = readJson(p.state);
  if (state === null) return { changed: false, notes: ['already off; nothing changed'] };

  const settings = readJson(p.settings) || {};
  const notes = [];
  const envObj = settings.env || {};

  for (const [k, setValue] of Object.entries(state.set.env)) {
    if (envObj[k] !== setValue) {
      notes.push(`env.${k} was changed by hand while on ("${envObj[k]}"); left as is`);
      continue;
    }
    const before = state.prior.env[k];
    if (before === null) delete envObj[k];
    else envObj[k] = before;
  }
  if (Object.keys(envObj).length === 0) delete settings.env;
  else settings.env = envObj;

  if (settings.apiKeyHelper !== state.set.apiKeyHelper) {
    notes.push(`apiKeyHelper was changed by hand while on ("${settings.apiKeyHelper}"); left as is`);
  } else if (state.prior.apiKeyHelper === null) {
    delete settings.apiKeyHelper;
  } else {
    settings.apiKeyHelper = state.prior.apiKeyHelper;
  }

  if (state.createdSettingsFile && Object.keys(settings).length === 0) {
    fs.unlinkSync(p.settings);
    notes.push('removed .claude/settings.local.json (on had created it and it is empty again)');
  } else {
    writeJson(p.settings, settings);
  }
  fs.unlinkSync(p.state);
  return { changed: true, notes };
}

module.exports = { ENV, ENV_BUNDLE, STATE_FILE, keyFile, status, on, off };

if (require.main === module) {
  const args = process.argv.slice(2);
  const bundle = args.includes('--bundle');
  const [verb = 'status', dirArg] = args.filter((a) => a !== '--bundle');
  const projectDir = path.resolve(dirArg || process.cwd());
  try {
    if (verb === 'on' || verb === 'off') {
      const r = verb === 'on' ? on(projectDir, { bundle }) : off(projectDir);
      console.log(`glm-backend ${verb}: ${r.changed ? 'changed' : 'unchanged'} (${projectDir})`);
      for (const n of r.notes) console.log(`  note: ${n}`);
    } else if (verb !== 'status') {
      console.error(`unknown verb "${verb}"; use status, on or off`);
      process.exit(2);
    }
    const s = status(projectDir);
    console.log(`glm-backend status: ${s.on ? 'ON since ' + s.enabledAt : 'off'}`);
    console.log(`  key source: ${s.key || 'MISSING (set ZAI_API_KEY or write ' + keyFile(os.homedir()) + ')'}`);
    if (s.on) console.log(`  base URL: ${s.baseUrl}; model: ${s.model}`);
  } catch (e) {
    console.error(`glm-backend ${verb}: ${e.message}`);
    process.exit(1);
  }
}
