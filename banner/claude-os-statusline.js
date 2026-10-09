// claude-os: status line.
// Claude Code runs this as the statusLine command and pipes session JSON on
// stdin. Whatever it prints is shown in the bar at the bottom of the TUI.
//
// The first segment is the canary: it reads ~/.claude/CLAUDE.md and checks
// whether the block between <!-- claude-os:start --> and
// <!-- claude-os:end --> holds any rules. Green "agent-os on" when it does,
// red "agent-os OFF" when the block is empty or the markers are gone.
// uninstall.ps1 empties the block and keeps the markers, so the markers alone
// prove nothing. This tests the installed state, not whether a script ran, so
// it flips when /disable-global-rules or /enable-global-rules is used. The
// canary is never configurable: a status line that can hide whether the layer
// is loaded is worth nothing.
//
// Everything after it is a segment: the checkout's version (commit count and
// date, red when origin/main is ahead; see version() below), then from the
// session JSON the model and version, context use, token counts,
// cost, both rate limits with reset countdowns, and (off by default) worktree,
// directory, agent, session name, vim mode and output style.
//
// This used to be a canary only, with the rich segments living in
// statusline-command.sh, a jq shell pipeline chained underneath. That pipeline
// spawns about 28 subprocesses: 1.3s per render on the home server and 6 to 9s
// on the DBA machine, which blew through the 5-second chain cap and left that
// machine with a canary and nothing else. Doing the same work here costs one
// process and no jq, so every machine can carry the full line. Measured on the
// home server: 0.074s for this script against 1.299s for the pipeline.
//
// Which segments print is read from ~/.claude/banner/statusline.json, written
// by the /statusline skill. A missing or unreadable config means the defaults
// below, so the line degrades to "everything on", never to nothing.
//
// Chaining. A machine may already have a status line of its own.
// install-banner.ps1 records that command in ~/.claude/banner/chain.txt and
// points settings.json here instead; this script then runs it with the same
// stdin JSON and prints its output on the lines below. When a chain is present
// this line drops its own segments, since the chained line carries them.
// uninstall-banner.ps1 puts the recorded command back. With no chain.txt
// nothing is spawned.
//
// Manual test (from the repo root):
//   node banner/claude-os-statusline.js < banner/sample-session.json

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const home = process.env.USERPROFILE || process.env.HOME || '';
const START = '<!-- claude-os:start -->';
const END = '<!-- claude-os:end -->';
// install-banner.ps1 rewrites this path to the real checkout. The env override
// is for tests, which point the script at a throwaway clone and banner dir.
const REPO = process.env.AGENT_OS_STATUSLINE_REPO || 'C:/GIT/cli-agent-os';
const BANNER_DIR = process.env.AGENT_OS_STATUSLINE_DIR || path.join(home, '.claude', 'banner');
const CHAIN = path.join(BANNER_DIR, 'chain.txt');
const CONFIG = path.join(BANNER_DIR, 'statusline.json');

// The shipped default: model, context, tokens, cost and both rate limits, plus
// the checkout version (key "sha", kept from when it showed the SHA so existing
// statusline.json files still apply). The rest are real segments that most sessions do not need
// on screen; /statusline turns any of them on. Keep this in step with the
// table in skills/statusline/SKILL.md and with $defaultSegments in
// install-banner.ps1.
const DEFAULTS = {
  sha: true,
  vim: false,
  agent: false,
  session: false,
  model: true,
  glm: true,
  style: false,
  worktree: false,
  dir: false,
  context: true,
  tokens: true,
  cost: true,
  limits: true,
};

// Columns to wrap at when the terminal will not say. stdout is a pipe here, so
// there is usually no width to read and no way to ask for one without spawning
// a process, which is the whole cost this script exists to avoid. 80 is the
// safe guess: too narrow only costs an extra line, while too wide gets the
// tail of the line clipped with an ellipsis by Claude Code.
const FALLBACK_COLUMNS = 80;
const MARGIN = 2;

const ESC = '\u001b[';
const paint = (code, s) => `${ESC}${code}m${s}${ESC}0m`;
const dim = (s) => paint(2, s);
const green = (s) => paint(32, s);
const yellow = (s) => paint(33, s);
const red = (s) => paint(31, s);
const cyan = (s) => paint(36, s);
const blue = (s) => paint(34, s);
const magenta = (s) => paint(35, s);
const alert = (s) => `${ESC}31;1m${s}${ESC}0m`;
const boldYellow = (s) => `${ESC}1m${ESC}33m${s}${ESC}0m`;
const boldGreen = (s) => `${ESC}1m${ESC}32m${s}${ESC}0m`;

const SEP = dim(' | ');

// On means the rules are actually in the file, not that the markers are.
// uninstall.ps1 keeps the marker pair and empties what is between them, so a
// presence test reads "on" for a machine that was just disabled. Test the
// block's contents. A start marker with no end marker is a broken install,
// not a loaded layer: say OFF and let the red segment prompt a reinstall.
// The agent-os pair is the marker name a later release switches to; it is
// accepted now so that switch cannot turn this canary red on any machine.
function loaded() {
  let text;
  try {
    text = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  } catch (err) {
    return false;
  }
  for (const [start, end] of [[START, END], ['<!-- agent-os:start -->', '<!-- agent-os:end -->']]) {
    const open = text.indexOf(start);
    if (open === -1) continue;
    const close = text.indexOf(end, open + start.length);
    if (close === -1) continue;
    if (text.slice(open + start.length, close).trim().length > 0) return true;
  }
  return false;
}

// A missing, empty or malformed config is not an error: fall back to the
// defaults so a bad edit costs a segment choice, never the status line.
function readConfig() {
  const cfg = Object.assign({}, DEFAULTS, { width: 0 });
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (err) {
    return cfg;
  }
  if (!parsed || typeof parsed !== 'object') return cfg;
  if (parsed.segments && typeof parsed.segments === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof parsed.segments[key] === 'boolean') cfg[key] = parsed.segments[key];
    }
  }
  if (typeof parsed.width === 'number' && parsed.width > 0) cfg.width = parsed.width;
  return cfg;
}

// Full SHA a ref points at, read from .git without spawning git: the loose ref
// file first, then packed-refs. '' when it cannot be read.
function refSha(ref) {
  try {
    return fs.readFileSync(path.join(REPO, '.git', ref), 'utf8').trim();
  } catch (err) {
    try {
      const packed = fs.readFileSync(path.join(REPO, '.git', 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(' ' + ref));
      return line ? line.slice(0, 40) : '';
    } catch (err2) {
      return '';
    }
  }
}

function repoSha() {
  try {
    const head = fs.readFileSync(path.join(REPO, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head;
    return refSha(head.slice(4).trim());
  } catch (err) {
    return '';
  }
}

// --- version: commit count and date, and whether origin/main is ahead -------
//
// The checkout is shown as "r<commit count> <commit date>" (r115 Sep 30): the
// count only grows, is the same on every machine for the same pushed commit,
// and the gap between two machines is how many commits one is behind. Green
// when this checkout is level with origin/main, red when origin/main is ahead
// (a pull is waiting). Like the SHA it replaced, it describes the checkout,
// not what install.ps1 last installed.
//
// Cost: counting commits needs git, so the answer is cached in
// ~/.claude/banner/version-cache.json keyed by the HEAD and origin/main SHAs,
// and git only runs when either moves. A render otherwise reads two ref files.
// origin/main only moves on a fetch, so a background "git fetch" starts at most
// once per FETCH_EVERY_MS, through conhost --headless so no window flashes
// (global rules, Windows shell), and is never waited on.

const VERSION_CACHE = path.join(BANNER_DIR, 'version-cache.json');
const FETCH_STAMP = path.join(BANNER_DIR, 'last-fetch.txt');
const FETCH_EVERY_MS = 30 * 60 * 1000;

function git(args) {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}

function version() {
  const head = repoSha();
  if (!head) return null;
  const origin = refSha('refs/remotes/origin/main');
  try {
    const c = JSON.parse(fs.readFileSync(VERSION_CACHE, 'utf8'));
    if (c && c.head === head && c.origin === origin) return c;
  } catch (err) {
    // No cache yet, or a bad one: recompute below.
  }
  const count = git(['rev-list', '--count', 'HEAD']);
  if (count === null) return null;
  const date = git(['log', '-1', '--format=%cd', '--date=format:%b %d']) || '';
  let behind = 0;
  if (origin && origin !== head) behind = Number(git(['rev-list', '--count', 'HEAD..' + origin]) || 0);
  const v = { head, origin, count: Number(count), date, behind };
  try {
    fs.writeFileSync(VERSION_CACHE, JSON.stringify(v), 'utf8');
  } catch (err) {
    // Cache is an optimisation; the segment still prints.
  }
  return v;
}

function maybeFetch() {
  try {
    const last = Number(fs.readFileSync(FETCH_STAMP, 'utf8').trim());
    if (Date.now() - last < FETCH_EVERY_MS) return;
  } catch (err) {
    // No stamp: fetch now.
  }
  try {
    // Stamp first, so a slow or failing fetch is not retried on every render.
    fs.writeFileSync(FETCH_STAMP, String(Date.now()), 'utf8');
    const conhost = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
    const [exe, args] = fs.existsSync(conhost)
      ? [conhost, ['--headless', 'git', '-C', REPO, 'fetch', '-q', 'origin', 'main']]
      : ['git', ['-C', REPO, 'fetch', '-q', 'origin', 'main']];
    const child = require('child_process').spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch (err) {
    // A failed fetch only means the colour may be stale.
  }
}

// Run the status line this machine had before the banner took the key over,
// feeding it the same stdin. Anything that goes wrong prints nothing: the
// canary must survive a broken chain.
function chained(stdin) {
  let cmd;
  try {
    cmd = fs.readFileSync(CHAIN, 'utf8').trim();
  } catch (err) {
    return '';
  }
  if (!cmd) return '';
  // The recorded command was written for whichever shell Claude Code spawns
  // status lines with, so it may name the home directory as a variable. Expand
  // those by hand; on Windows the shell underneath us can be cmd.exe, which
  // would leave $HOME standing.
  const h = home.replace(/\\/g, '/');
  cmd = cmd
    .replace(/\$\{HOME\}|\$HOME\b/g, h)
    .replace(/\$\{USERPROFILE\}|\$USERPROFILE\b/g, h)
    .replace(/%USERPROFILE%/gi, h);
  try {
    const r = spawnSync(cmd, {
      shell: true,
      input: stdin,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    if (r.error) return '';
    return (r.stdout || '').replace(/\s+$/, '');
  } catch (err) {
    return '';
  }
}

// --- value helpers ---------------------------------------------------------

function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  return null;
}

function str(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

function get(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

// 1000 and over gets a k suffix: 15300 -> 15.3k.
function fmtK(v) {
  const n = num(v);
  if (n === null) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

// Traffic light, matching the shell version it replaces: green under 70,
// yellow from 70, red from 90.
function pctColor(v) {
  const n = num(v);
  if (n === null) return green;
  if (n >= 90) return red;
  if (n >= 70) return yellow;
  return green;
}

function pct(v) {
  const n = num(v);
  return (n === null ? 0 : Math.round(n)) + '%';
}

// A unix epoch (seconds or milliseconds, number or numeric string) or an
// ISO-8601 string. Date.parse handles the offset forms that the jq version had
// to take apart by hand.
function toEpoch(v) {
  const n = num(v);
  if (n !== null) return n > 1e11 ? Math.round(n / 1000) : Math.round(n);
  if (typeof v === 'string' && v.trim() !== '') {
    const ms = Date.parse(v);
    if (!isNaN(ms)) return Math.round(ms / 1000);
  }
  return null;
}

// Time until a reset, as 45m, 2h15m, or 1d10h once past a day. \u21ba is the
// reset arrow, written by code point so no console encoding can eat it out of
// this file.
function countdown(v) {
  const epoch = toEpoch(v);
  if (epoch === null) return '';
  let diff = epoch - Math.floor(Date.now() / 1000);
  if (diff < 0) diff = 0;
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days >= 1) return '\u21ba ' + days + 'd' + hours + 'h';
  if (hours >= 1) return '\u21ba ' + hours + 'h' + mins + 'm';
  return '\u21ba ' + mins + 'm';
}

// --- glm: Z.ai Coding Plan peak window -------------------------------------
//
// From docs.z.ai/devpack/notice/usage-revision (read 2026-10-07): peak is
// Monday to Friday 14:00-18:00 Singapore time (UTC+8), everything else
// including weekends is off-peak. GLM-5.3 draws 3x plan quota at peak, 1x off
// it. Singapore has no daylight saving, so the window is computed on a fixed
// +8 clock and the countdown needs no time zone at all. The local clock time
// of the next change is shown too, formatted by the machine's own zone.

const SGT_MS = 8 * 3600 * 1000;
const PEAK_START_H = 14;
const PEAK_END_H = 18;

function glmWindow(nowMs) {
  const sgt = new Date(nowMs + SGT_MS);
  const day = sgt.getUTCDay();
  const midnight = Date.UTC(sgt.getUTCFullYear(), sgt.getUTCMonth(), sgt.getUTCDate()) - SGT_MS;
  const at = (d, h) => midnight + d * 86400000 + h * 3600000;
  const weekday = (d) => ((day + d) % 7 + 7) % 7 >= 1 && ((day + d) % 7 + 7) % 7 <= 5;
  if (weekday(0) && nowMs >= at(0, PEAK_START_H) && nowMs < at(0, PEAK_END_H)) {
    return { peak: true, until: at(0, PEAK_END_H) };
  }
  for (let d = 0; d <= 7; d++) {
    if (weekday(d) && at(d, PEAK_START_H) > nowMs) return { peak: false, until: at(d, PEAK_START_H) };
  }
  return { peak: false, until: null };
}

function span(ms) {
  const mins = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d >= 1) return d + 'd' + h + 'h';
  if (h >= 1) return h + 'h' + m + 'm';
  return m + 'm';
}

function localClock(ms) {
  try {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  } catch (err) {
    return '';
  }
}

function glmPeak(nowMs) {
  const w = glmWindow(nowMs);
  if (w.until === null) return green('GLM off-peak 1x');
  const when = localClock(w.until);
  const tail = ' ' + span(w.until - nowMs) + (when ? ' (' + when + ')' : '');
  if (w.peak) return alert('GLM PEAK 3x') + dim(' ends' + tail);
  return green('GLM off-peak 1x') + dim(' peak in' + tail);
}

// --- width-aware wrap ------------------------------------------------------

const ANSI = /\u001b\[[0-9;]*m/g;
const visibleLen = (s) => s.replace(ANSI, '').length;

function wrapSegments(segments, width) {
  const lines = [];
  let cur = '';
  let curLen = 0;
  const sepLen = visibleLen(SEP);
  for (const seg of segments) {
    const segLen = visibleLen(seg);
    if (cur === '') {
      cur = seg;
      curLen = segLen;
      continue;
    }
    if (curLen + sepLen + segLen <= width) {
      cur += SEP + seg;
      curLen += sepLen + segLen;
    } else {
      lines.push(cur);
      cur = seg;
      curLen = segLen;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

// --- main ------------------------------------------------------------------

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
  // Windows PowerShell 5.1 puts a UTF-8 BOM in front of anything it pipes to a
  // native command, and JSON.parse throws on it, which silently costs every
  // segment below. Strip it before parsing or chaining.
  // 0xfeff by code, not a literal BOM in this file: an invisible character in
  // the source is one bad copy-paste away from vanishing.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
} catch (err) {
  // No stdin: still print the canary, that is the point.
}

let input = {};
try {
  input = JSON.parse(raw);
} catch (err) {
  // Bad JSON: same.
}

const cfg = readConfig();
const tail = chained(raw);

const segs = [];
segs.push(loaded() ? green('[#] agent-os on') : alert('[!] agent-os OFF'));

if (cfg.sha) {
  const v = version();
  if (v) segs.push((v.behind > 0 ? red : green)('r' + v.count + (v.date ? ' ' + v.date : '')));
  maybeFetch();
}

// A chained status line already carries the session numbers, so ours stay off
// to keep the two from printing the same thing twice.
if (!tail) {
  const vim = str(get(input, ['vim', 'mode']));
  if (cfg.vim && vim === 'NORMAL') segs.push(boldYellow('[NORMAL]'));
  if (cfg.vim && vim === 'INSERT') segs.push(boldGreen('[INSERT]'));

  if (cfg.agent) {
    const name = str(get(input, ['agent', 'name']));
    const type = str(get(input, ['agent', 'type']));
    if (name) segs.push(magenta('agent:' + name + (type ? '(' + type + ')' : '')));
  }

  if (cfg.session) {
    const name = str(input.session_name);
    if (name) segs.push(cyan(name));
  }

  if (cfg.model) {
    const name = str(get(input, ['model', 'display_name'])) || str(get(input, ['model', 'id']));
    const version = str(input.version);
    if (name) segs.push(blue(name) + (version ? ' ' + dim(version) : ''));
  }

  if (cfg.glm) {
    const id = str(get(input, ['model', 'id'])) || str(get(input, ['model', 'display_name']));
    if (/glm/i.test(id)) segs.push(glmPeak(Date.now()));
  }

  if (cfg.style) {
    const name = str(get(input, ['output_style', 'name']));
    if (name && name !== 'default') segs.push(magenta('style:' + name));
  }

  if (cfg.worktree) {
    const name = str(get(input, ['worktree', 'name']));
    const branch = str(get(input, ['worktree', 'branch']));
    const orig = str(get(input, ['worktree', 'original_branch']));
    if (name) {
      let text = 'worktree:' + name;
      if (branch && orig) text += ' (' + branch + '<-' + orig + ')';
      else if (branch) text += ' (' + branch + ')';
      segs.push(green(text));
    }
  }

  if (cfg.dir) {
    const cwd = str(get(input, ['workspace', 'current_dir'])) || str(input.cwd);
    if (cwd) segs.push(path.basename(cwd.replace(/[\\/]+$/, '')));
  }

  if (cfg.context) {
    const used = get(input, ['context_window', 'used_percentage']);
    if (num(used) !== null) {
      const color = pctColor(used);
      const left = get(input, ['context_window', 'remaining_percentage']);
      const size = get(input, ['context_window', 'context_window_size']);
      segs.push(
        dim('ctx:') + color(pct(used)) + dim(' used ') + color(pct(left)) +
        dim(' left/' + fmtK(size))
      );
    }
  }

  if (cfg.tokens) {
    const tin = get(input, ['context_window', 'total_input_tokens']);
    const tout = get(input, ['context_window', 'total_output_tokens']);
    if (num(tin) !== null || num(tout) !== null) {
      segs.push(
        dim('tokens: in:') + cyan(fmtK(tin)) + ' ' + dim('out:') + magenta(fmtK(tout))
      );
    }
  }

  if (cfg.cost) {
    const usd = num(get(input, ['cost', 'total_cost_usd']));
    if (usd !== null) segs.push(green('$' + usd.toFixed(2)));
  }

  if (cfg.limits) {
    for (const [key, label] of [['five_hour', '5h:'], ['seven_day', '7d:']]) {
      const used = get(input, ['rate_limits', key, 'used_percentage']);
      if (num(used) === null) continue;
      const color = pctColor(used);
      const cd = countdown(get(input, ['rate_limits', key, 'resets_at']));
      segs.push(dim(label) + color(pct(used)) + (cd ? ' ' + dim(cd) : ''));
    }
  }
}

let width = cfg.width || process.stdout.columns || num(process.env.COLUMNS) || FALLBACK_COLUMNS;
width -= MARGIN;
if (width < 20) width = 20;

const lines = wrapSegments(segs, width);
if (tail) lines.push(tail);
process.stdout.write(lines.join('\n') + '\n');
