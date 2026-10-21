#!/usr/bin/env node
// workers: stand up standing Claude Code worker panes in wmux from one line.
//
//   node workers.js <model> [<model> ...] [--prefix ab] [--dry-run]
//
// One worker per model listed, started with `claude --model <m> -n <name>` in the current folder.
// Names follow `<prefix>-<model>-worker`, numbered (`worker1`, `worker2`) when a model repeats.
// The workspace is `<PREFIX> Workers`. A worker whose name is already on screen is left alone; an
// idle shell pane in that workspace is reused; anything else running there is never touched.
// wmux is driven through its Node client with an argument array, never a shell, so Git Bash path
// conversion cannot mangle anything. Every worker is confirmed by reading its screen back.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;
const MAX_NEW_PANES = 8; // `wmux new-workspace --panes` accepts 1-8
const NBSP = String.fromCharCode(0xa0);
const PROMPT_LINE = new RegExp('^[ ' + NBSP + ']*[>' + String.fromCharCode(0x276f) + ']([ ' + NBSP + '].*)?$');
const RULE = String.fromCharCode(0x2500);
// Claude Code prints the session name inside the top rule of its input box: "----- ab-opus-worker1 -".
const BOX_NAME = new RegExp(RULE + '{3,} ([A-Za-z0-9._-]+) ' + RULE);
const TRIES = 30;
const INTERVAL_MS = 2000;

// ---------------------------------------------------------------- pure parts

function modelToken(model) {
  return String(model).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function workerNames(models, prefix) {
  const total = {};
  for (const m of models) total[modelToken(m)] = (total[modelToken(m)] || 0) + 1;
  const seen = {};
  return models.map((m) => {
    const t = modelToken(m);
    seen[t] = (seen[t] || 0) + 1;
    return { model: m, name: `${prefix}-${t}-worker${total[t] > 1 ? seen[t] : ''}` };
  });
}

function initials(folder) {
  const parts = path.basename(folder).toLowerCase().split(/[-_ .]+/).filter(Boolean);
  return parts.length > 1 ? parts.map((p) => p[0]).join('') : parts[0] || 'w';
}

function workspaceTitle(prefix) {
  return `${prefix.toUpperCase()} Workers`;
}

// What a pane shows: 'claude' (a Claude Code session, any state), 'shell' (an idle shell prompt or
// nothing at all) or 'other' (something else running; never touched).
function classifyPane(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return 'shell';
  const t = lines.join('\n');
  if (BOX_NAME.test(t) || /esc to interrupt|auto mode|shift\+tab to cycle|Claude Code v[0-9]/.test(t)) return 'claude';
  if (/trust this folder|Quick safety check/i.test(t)) return 'claude';
  if (/^(PS [^>]*>|.*[$#]) ?$/.test(lines[lines.length - 1])) return 'shell';
  return 'other';
}

function sessionName(text) {
  const m = String(text || '').match(BOX_NAME);
  return m ? m[1] : null;
}

// Ready = Claude's input prompt is on screen and nothing is running or asking.
function isReady(text) {
  const t = String(text || '');
  if (/esc to interrupt|trust this folder|Quick safety check|Do you want to/i.test(t)) return false;
  return t.split(/\r?\n/).some((l) => PROMPT_LINE.test(l)) && t.includes(RULE.repeat(8));
}

// panes: [{ paneId, surfaces: [{ id, title, text }] }] of the existing workspace, or null if none.
// Returns { create, steps: [{ name, model, paneId|newIndex, replaceTab }], present: [names] }.
function plan(wanted, panes) {
  if (!panes) {
    if (wanted.length > MAX_NEW_PANES) throw new Error(`at most ${MAX_NEW_PANES} workers in a new workspace`);
    return { create: true, present: [], steps: wanted.map((w, i) => ({ ...w, newIndex: i, replaceTab: true })) };
  }
  const onScreen = new Set();
  const free = [];
  for (const p of panes) {
    for (const s of p.surfaces) {
      const n = sessionName(s.text) || s.title;
      if (n) onScreen.add(n);
    }
    if (p.surfaces.length === 1 && classifyPane(p.surfaces[0].text) === 'shell') free.push(p.paneId);
  }
  const present = wanted.filter((w) => onScreen.has(w.name)).map((w) => w.name);
  const missing = wanted.filter((w) => !onScreen.has(w.name));
  const host = panes.length ? panes[panes.length - 1].paneId : null;
  const steps = missing.map((w) => {
    const p = free.shift();
    if (p) return { ...w, paneId: p, replaceTab: true };
    return { ...w, paneId: host, replaceTab: false }; // no idle pane left: add a tab
  });
  return { create: false, present, steps };
}

function spawnArgs(step, paneId, cwd) {
  const a = ['agent', 'spawn', '--pane', paneId];
  if (step.replaceTab) a.push('--replace-tab');
  a.push('--cwd', cwd, '--label', step.name, '--cmd', `claude --model ${step.model} -n ${step.name}`);
  return a;
}

function parseArgs(argv) {
  const o = { models: [], prefix: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--prefix') o.prefix = String(argv[++i] || '').toLowerCase();
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else if (MODEL_RE.test(a)) o.models.push(a);
    else throw new Error(`not a model name: ${a}`);
  }
  if (o.models.length === 0) throw new Error('name at least one model, e.g. opus opus sonnet haiku');
  if (o.prefix !== null && !/^[a-z0-9]{1,12}$/.test(o.prefix)) throw new Error('--prefix must be 1-12 letters or digits');
  return o;
}

// ---------------------------------------------------------------- wmux

function makeRunner() {
  const cli = [process.env.WMUX_CLI, 'C:\\Program Files\\wmux\\resources\\cli\\wmux.js'].filter(Boolean).find((c) => fs.existsSync(c));
  if (!cli) return null;
  return (args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const out = (r.stdout || '').trim();
    if (r.status !== 0) throw new Error(`wmux ${args.join(' ')} failed (exit ${r.status}): ${(r.stderr || out).trim()}`);
    if (!out.startsWith('{')) return out;
    const j = JSON.parse(out);
    if (j && j.error) throw new Error(`wmux ${args.join(' ')}: ${JSON.stringify(j.error)}`);
    return j;
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function leaves(run, wsId) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'leaf') {
      out.push({ paneId: n.paneId, surfaces: (n.surfaces || []).map((s) => ({ id: s.id, title: s.customTitle || null, cwd: s.currentCwd || s.cwd || '' })) });
    } else (n.children || []).forEach(walk);
  };
  walk(run(['tree', '--workspace', wsId]).tree);
  return out;
}

function screen(run, surfaceId) {
  const r = run(['read-screen', '--surface', surfaceId, '--lines', '40']);
  return typeof r === 'object' ? r.text || '' : String(r);
}

function lastLines(text, n) {
  return String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '').slice(-n);
}

// Prefix from an existing "<X> Workers" workspace whose panes sit in this folder, else the folder's initials.
function derivePrefix(run, workspaces, cwd) {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  for (const w of workspaces) {
    const m = /^([A-Za-z0-9]{1,12}) Workers$/.exec(w.title);
    if (!m) continue;
    if (leaves(run, w.id).some((l) => l.surfaces.some((s) => s.cwd && same(s.cwd, cwd)))) return m[1].toLowerCase();
  }
  return initials(cwd);
}

function isTrusted(cwd) {
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).projects || {};
    let p = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    while (p.lastIndexOf('/') > 2) {
      if (projects[p] && projects[p].hasTrustDialogAccepted) return true;
      p = p.slice(0, p.lastIndexOf('/'));
    }
    return Boolean(projects[p] && projects[p].hasTrustDialogAccepted);
  } catch (_) {
    return null; // unknown
  }
}

function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 2;
  }
  const run = makeRunner();
  let alive = false;
  try {
    alive = Boolean(run) && run(['ping']) === 'pong';
  } catch (_) {
    /* not running */
  }
  if (!alive) {
    console.error('error: wmux does not answer ping; nothing was changed');
    return 1;
  }
  const cwd = process.cwd();
  const workspaces = (run(['list-workspaces']).workspaces || []).map((w) => ({ id: w.id, title: w.title }));
  const prefix = o.prefix || derivePrefix(run, workspaces, cwd);
  const title = workspaceTitle(prefix);
  const matches = workspaces.filter((w) => w.title === title);
  if (matches.length > 1) {
    console.error(`error: ${matches.length} workspaces are titled "${title}"; rename one`);
    return 1;
  }
  let wsId = matches.length ? matches[0].id : null;
  let panes = null;
  if (wsId) {
    panes = leaves(run, wsId);
    for (const p of panes) for (const s of p.surfaces) s.text = screen(run, s.id);
  }
  const wanted = workerNames(o.models, prefix);
  let p;
  try {
    p = plan(wanted, panes);
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 2;
  }
  console.log(`workspace: ${title} ${wsId || '(new)'}  cwd: ${cwd}`);
  if (isTrusted(cwd) === false) console.log(`warning  : ${cwd} is not trusted under this exact casing; workers will stop at the trust dialog`);
  for (const n of p.present) console.log(`present  : ${n} (left alone)`);
  if (p.steps.length === 0) {
    console.log('nothing to start; every worker is already up');
    return 0;
  }
  if (o.dryRun) {
    if (p.create) console.log(`dry run  : wmux new-workspace --title "${title}" --cwd ${cwd} --panes ${p.steps.length} --layout grid`);
    for (const s of p.steps) console.log(`dry run  : wmux ${spawnArgs(s, s.paneId || `<new pane ${s.newIndex + 1}>`, cwd).join(' ')}`);
    return 0;
  }
  let newPanes = [];
  if (p.create) {
    const r = run(['new-workspace', '--title', title, '--cwd', cwd, '--panes', String(p.steps.length), '--layout', 'grid']);
    wsId = r.workspaceId;
    if (!wsId) throw new Error(`new-workspace returned no workspaceId: ${JSON.stringify(r)}`);
    newPanes = leaves(run, wsId).map((l) => l.paneId);
    console.log(`created  : ${title} ${wsId} with ${newPanes.length} panes`);
  }
  let failed = 0;
  for (const s of p.steps) {
    const paneId = s.paneId || newPanes[s.newIndex];
    let text = '';
    let ok = false;
    let why = '';
    try {
      if (!paneId) throw new Error('no pane to start it in');
      const sp = run(spawnArgs(s, paneId, cwd));
      if (!sp.surfaceId) throw new Error(`agent spawn returned no surfaceId: ${JSON.stringify(sp)}`);
      run(['rename-surface', sp.surfaceId, s.name]);
      for (let i = 0; i < TRIES && !ok; i++) {
        if (i) sleep(INTERVAL_MS);
        text = screen(run, sp.surfaceId);
        ok = isReady(text) && sessionName(text) === s.name;
        if (/trust this folder|Quick safety check/i.test(text)) break;
      }
      if (!ok) why = /trust this folder|Quick safety check/i.test(text) ? 'stopped at the folder trust dialog' : `no ready prompt named ${s.name} after ${TRIES} reads`;
    } catch (e) {
      why = e.message;
    }
    if (!ok) failed++;
    console.log(`${ok ? 'ready   ' : 'FAILED  '} : ${s.name} (${s.model})${why ? ' - ' + why : ''}`);
    for (const l of lastLines(text, 3)) console.log(`           | ${l}`);
  }
  return failed ? 1 : 0;
}

module.exports = { modelToken, workerNames, initials, workspaceTitle, classifyPane, sessionName, isReady, plan, spawnArgs, parseArgs };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
