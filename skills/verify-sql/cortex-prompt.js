#!/usr/bin/env node
// verify-sql/cortex-prompt.js: build the Cortex second-opinion statement for a package.
//
//   node cortex-prompt.js <package folder or .sql file> <checklist.md> [--model <name>]
//
// Prints one SELECT to stdout: AI_COMPLETE(<model>, $$<prompt>$$), where the prompt is the
// adversary brief in short form, the checklist's entry ids, titles and Class lines, and every
// .sql file in the package with line numbers. The statement is a SELECT, so it runs through
// the governed connector (SELECT only). Redirect it to a file and paste that file's contents
// as the connector's single statement.
//
// The prompt is dollar-quoted, so a literal `$$` inside the package would end the string
// early; any `$$` in the package or checklist text is written as `$ $` and a note at the top
// of the prompt says so. Nothing here connects to anything or writes any file.
//
// Default model: llama3.3-70b (available in AWS US East 1 per the vendor's regional
// availability page, read 2026-10-01). Override with --model.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MODEL = 'llama3.3-70b';

function listSql(target) {
  if (fs.statSync(target).isFile()) return [{ abs: target, rel: path.basename(target) }];
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== '.git' && ent.name !== 'node_modules') walk(abs); }
      else if (/\.sql$/i.test(ent.name)) out.push({ abs, rel: path.relative(target, abs).split(path.sep).join('/') });
    }
  };
  walk(target);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

// "### A1. title" headings plus the "- **Class:**" paragraph under each.
function checklistEntries(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let cur = null;
  let inClass = false;
  for (const ln of lines) {
    const h = /^###\s+([A-Z]\d+)\.\s+(.*)$/.exec(ln);
    if (h) { cur = { id: h[1], title: h[2].trim(), cls: '' }; entries.push(cur); inClass = false; continue; }
    if (!cur) continue;
    if (/^- \*\*Class:\*\*/.test(ln)) { inClass = true; cur.cls = ln.replace(/^- \*\*Class:\*\*\s*/, ''); continue; }
    if (inClass) {
      if (/^- \*\*/.test(ln) || /^\s*$/.test(ln) || /^#/.test(ln)) { inClass = false; continue; }
      cur.cls += ' ' + ln.trim();
    }
  }
  return entries;
}

function main(argv) {
  const args = argv.slice(2);
  let model = DEFAULT_MODEL;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') { model = args[++i]; continue; }
    positional.push(args[i]);
  }
  const [target, checklist] = positional;
  if (!target || !checklist) {
    process.stderr.write('usage: node cortex-prompt.js <package> <checklist.md> [--model <name>]\n');
    return 1;
  }
  for (const p of [target, checklist]) {
    if (!fs.existsSync(p)) { process.stderr.write(`cortex-prompt.js: ${p} does not exist\n`); return 1; }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(model)) { process.stderr.write('cortex-prompt.js: model name has unexpected characters\n'); return 1; }

  const entries = checklistEntries(fs.readFileSync(checklist, 'utf8'));
  const files = listSql(target);
  let dollar = 0;
  const safe = (s) => s.replace(/\$\$/g, () => { dollar++; return '$ $'; });

  const parts = [];
  parts.push('You are the independent second reviewer of a Snowflake script package. Review the package text below against the failure checklist. You cannot run anything; judge from the text.');
  parts.push('Report one block per finding, exactly: FINDING: <entry id> <one line> / EVIDENCE: <file>:<line> <quoted statement> / CONFIDENCE: observed | inferred | hypothesis / GAPS: <what you could not check>. A finding with no file and line is a hypothesis. No fixes, no rewritten SQL. End with a block ENTRIES CHECKED WITH NO FINDING listing every entry id you checked and found nothing for, then one line SUMMARY: <n> findings, <n> entries clear. ASCII only.');
  parts.push('');
  parts.push('CHECKLIST ENTRIES:');
  for (const e of entries) parts.push(`${e.id}. ${e.title}. Class: ${safe(e.cls)}`);
  parts.push('');
  parts.push(`PACKAGE: ${path.basename(path.resolve(target))} (${files.length} file(s))`);
  for (const f of files) {
    parts.push('');
    parts.push(`=== FILE ${f.rel} ===`);
    const lines = fs.readFileSync(f.abs, 'utf8').split(/\r?\n/);
    lines.forEach((ln, i) => parts.push(`${String(i + 1).padStart(4)}: ${safe(ln)}`));
  }
  let prompt = parts.join('\n');
  if (dollar) prompt = `NOTE: ${dollar} occurrence(s) of a double dollar sign in the source are written as "$ $" here so this prompt can be dollar-quoted.\n\n` + prompt;

  const sql = `SELECT AI_COMPLETE('${model}', $$${prompt}$$) AS REVIEW;\n`;
  process.stdout.write(sql);
  process.stderr.write(`cortex-prompt.js: ${files.length} file(s), ${entries.length} checklist entries, ${prompt.length} characters, model ${model}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exit(main(process.argv)); } catch (e) { process.stderr.write(`cortex-prompt.js: ${e.message}\n`); process.exit(1); }
}

module.exports = { checklistEntries };
