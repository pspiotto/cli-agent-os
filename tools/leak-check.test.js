// Unit tests for tools/leak-check.js.
//   node tools/leak-check.test.js
// Builds a throwaway git repo and denylist in a temp folder and runs the
// checker against them. Exits 1 if any case fails.

'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const checker = path.join(__dirname, 'leak-check.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-check-test-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const deny = path.join(tmp, 'denylist.txt');
fs.writeFileSync(deny, '# test denylist\n\nzorbleplex\n\\bTK-\\d+\n!NOTICE\n=Sam Zorbleplex <1+zorbleplex@users.noreply.github.com>\n');

const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
g('init', '-q');
g('config', 'user.name', 'Test Author');
g('config', 'user.email', 'author@example.invalid');
g('config', 'commit.gpgsign', 'false');

function run(mode, env) {
  const res = spawnSync(process.execPath, [checker, mode], {
    cwd: repo,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { AGENT_OS_DENYLIST: deny, AGENT_OS_LEAK_CHECK: '' }, env || {}),
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

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
function write(rel, text) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}

// Clean staged content passes.
write('a.md', 'nothing to see\n');
g('add', 'a.md');
let r = run('--staged');
check('clean staged diff passes', r.code === 0 && r.out.includes('clean'), r.out);

// A denied word on an added line blocks, case-insensitive, and names file:line.
write('a.md', 'nothing to see\nhello ZorblePlex\n');
g('add', 'a.md');
r = run('--staged');
check('denied word in an added line blocks', r.code === 1 && r.out.includes('a.md:2'), r.out);

// A ticket-shaped pattern with \b works.
write('a.md', 'nothing to see\nsee TK-42 for why\n');
g('add', 'a.md');
r = run('--staged');
check('regex pattern blocks', r.code === 1 && r.out.includes('a.md:2'), r.out);

// A denied word in a path blocks.
write('a.md', 'nothing to see\n');
write('zorbleplex/notes.md', 'fine\n');
g('add', '-A');
r = run('--staged');
check('denied word in a path blocks', r.code === 1 && r.out.includes('path zorbleplex/notes.md'), r.out);
g('rm', '-q', '--cached', 'zorbleplex/notes.md');
fs.rmSync(path.join(repo, 'zorbleplex'), { recursive: true });

// An exempt file may carry a denied word.
write('NOTICE', 'Copyright Zorbleplex\n');
g('add', 'NOTICE');
r = run('--staged');
check('exempt file is not scanned', r.code === 0, r.out);

// A denied author identity blocks the commit.
r = run('--staged', { GIT_AUTHOR_EMAIL: 'me@zorbleplex.example' });
check('denied author identity blocks', r.code === 1 && r.out.includes('author identity'), r.out);

// The one allowed identity passes even though it carries a denied word.
r = run('--staged', {
  GIT_AUTHOR_NAME: 'Sam Zorbleplex',
  GIT_AUTHOR_EMAIL: '1+zorbleplex@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'Sam Zorbleplex',
  GIT_COMMITTER_EMAIL: '1+zorbleplex@users.noreply.github.com',
});
check('allowed identity passes', r.code === 0, r.out);

// The same name with another email is still blocked.
r = run('--staged', { GIT_AUTHOR_NAME: 'Sam Zorbleplex', GIT_AUTHOR_EMAIL: 'sam@work.example' });
check('allowed name with another email blocks', r.code === 1 && r.out.includes('author identity'), r.out);

// No denylist is a failure, not a pass.
r = run('--staged', { AGENT_OS_DENYLIST: path.join(tmp, 'absent.txt') });
check('missing denylist fails closed', r.code === 1 && r.out.includes('no denylist'), r.out);

// The explicit off switch skips and says so.
r = run('--staged', { AGENT_OS_DENYLIST: path.join(tmp, 'absent.txt'), AGENT_OS_LEAK_CHECK: 'off' });
check('off switch skips loudly', r.code === 0 && r.out.includes('SKIPPED'), r.out);

// --all: clean tree passes, then a committed hit is found.
g('commit', '-q', '-m', 'clean');
r = run('--all');
check('--all passes a clean tree', r.code === 0, r.out);
write('b.txt', 'line one\nzorbleplex here\n');
g('add', 'b.txt');
g('commit', '-q', '--no-verify', '-m', 'oops');
r = run('--all');
check('--all finds a committed hit', r.code === 1 && r.out.includes('b.txt:2'), r.out);

// --all flags a denied identity anywhere in history.
g('rm', '-q', 'b.txt');
g('commit', '-q', '-m', 'fix');
g('-c', 'user.email=old@zorbleplex.example', 'commit', '-q', '--allow-empty', '-m', 'old identity');
r = run('--all');
check('--all finds a denied identity in history', r.code === 1 && r.out.includes('commit identity'), r.out);

// A bad regex is reported, not ignored.
fs.writeFileSync(path.join(tmp, 'bad.txt'), '([unclosed\n');
r = run('--staged', { AGENT_OS_DENYLIST: path.join(tmp, 'bad.txt') });
check('invalid regex fails', r.code === 1 && r.out.includes('not a valid regex'), r.out);

// Usage.
r = run('--nope');
check('bad mode is a usage error', r.code === 2, r.out);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
