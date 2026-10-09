#!/usr/bin/env node
// verify-docs step 1: list the docs worth verifying, from an entropy-sweep scan.
//   node topdocs.js <scan.json> [--top N]
// Prints one line per doc: rank, inbound count, line count, current stamp (or
// "none"), path. Read-only. The scan is produced by skills/entropy-sweep/scan.js.
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (!argv.length) {
  process.stderr.write('usage: node topdocs.js <scan.json> [--top N]\n');
  process.exit(1);
}
const scan = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
let top = scan.checks.last_verified.topDocs.length;
for (let i = 1; i < argv.length; i++) if (argv[i] === '--top') top = Number(argv[++i]);

const docs = scan.checks.last_verified.topDocs.slice(0, top);
console.log(`repo: ${scan.repo}`);
console.log(`rank  inbound  lines  last verified            path`);
docs.forEach((d, i) => {
  let lines = '?';
  try { lines = fs.readFileSync(path.join(scan.repo, d.path), 'utf8').split(/\r?\n/).length; } catch (err) { /* keep ? */ }
  const v = d.verified ? `${d.verified.date}${d.verified.machine ? ' (' + d.verified.machine + ')' : ''}` : 'none';
  console.log(`${String(i + 1).padStart(4)}  ${String(d.inbound).padStart(7)}  ${String(lines).padStart(5)}  ${v.padEnd(24)} ${d.path}`);
});
console.log(`\n${docs.length} docs; ${docs.filter((d) => !d.verified).length} without a stamp.`);
