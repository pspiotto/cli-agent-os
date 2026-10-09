#!/usr/bin/env node
// verify-sql/static.js: the static half of the failure checklist, one pattern per entry.
//
//   node static.js <package folder or .sql file> [--config <file>]
//
// Reads every .sql file under the package (sorted by relative path), splits each into
// statements with a scanner that survives '...' bodies, "quoted" identifiers, $$ bodies and
// both comment styles, applies one class-level pattern per static checklist entry, and prints
// JSON: { root, files, statements, entriesChecked, findings: [{ entry, title, file, line,
// matched, detail }], summary }. It reads and prints; it never writes.
//
// The patterns carry no object, database or role name. A repo adds its own with
// `.verify-sql.json` at its root (found by walking up from the package):
//   { "patterns": [ { "entry": "X1", "title": "...", "regex": "...", "flags": "i",
//                     "scope": "statement" | "line" } ],
//     "exclude": [ "<regex over the file's relative path>" ] }
//
// Entries (the static rows of a repo's docs/failure-checklist.md):
//   A1 object name not fully qualified      A5 CREATE MANAGED ACCOUNT IF NOT EXISTS
//   A2 single-quoted procedure or UDF body   A6 CREATE OR REPLACE without COPY GRANTS on a
//   A3 COMMENT ON COLUMN against a view         granted object, no re-grant after
//   A4 CREATE OR REPLACE on a policy          A7 Snowflake Scripting IF without parentheses
//
// No dependencies beyond Node.

'use strict';

const fs = require('fs');
const path = require('path');

const ENTRIES = {
  A1: 'object name not fully qualified in a deployable script',
  A2: 'quote escaping inside a single-quoted procedure or UDF body',
  A3: 'COMMENT ON COLUMN against a view',
  A4: 'CREATE OR REPLACE on a row access or masking policy',
  A5: 'CREATE MANAGED ACCOUNT re-run with IF NOT EXISTS',
  A6: 'grants lost when an object is replaced without COPY GRANTS',
  A7: 'Snowflake Scripting IF without parentheses',
};

// Words that may precede the object type in CREATE / ALTER / DROP / GRANT ... ON.
const MODIFIERS = new Set([
  'SECURE', 'TRANSIENT', 'TEMPORARY', 'TEMP', 'LOCAL', 'GLOBAL', 'VOLATILE', 'RECURSIVE',
  'EXTERNAL', 'HYBRID', 'ICEBERG', 'DYNAMIC', 'MATERIALIZED', 'EVENT', 'SEMANTIC',
  'MASKING', 'ROW', 'ACCESS', 'PACKAGES', 'AGGREGATION', 'PROJECTION', 'AUTHENTICATION',
  'PASSWORD', 'SESSION', 'PRIVACY', 'JOIN', 'NETWORK', 'API', 'STORAGE', 'NOTIFICATION',
  'SECURITY', 'CATALOG', 'MANAGED', 'RESOURCE', 'COMPUTE', 'CORTEX', 'SEARCH', 'DATA',
  'METRIC', 'FILE', 'REPLICATION', 'FAILOVER', 'IMAGE', 'ORGANIZATION', 'DATABASE',
  'APPLICATION',
]);
const TYPE_WORDS = new Set([
  'TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'STAGE', 'TASK', 'STREAM', 'PIPE', 'SEQUENCE',
  'POLICY', 'FORMAT', 'SCHEMA', 'DATABASE', 'WAREHOUSE', 'ROLE', 'USER', 'INTEGRATION',
  'SHARE', 'ACCOUNT', 'TAG', 'ALERT', 'STREAMLIT', 'MODEL', 'SERVICE', 'NOTEBOOK', 'MONITOR',
  'POOL', 'APPLICATION', 'PACKAGE', 'LISTING', 'RULE', 'SECRET', 'VOLUME', 'DATASET', 'GROUP',
  'CONNECTION', 'REPOSITORY',
]);
const SKIP_WORDS = new Set(['OR', 'REPLACE', 'ALTER', 'IF', 'NOT', 'EXISTS']);
// Object types that live at account level: zero dots is correct.
const ACCOUNT_LEVEL = new Set([
  'WAREHOUSE', 'ROLE', 'USER', 'INTEGRATION', 'SHARE', 'ACCOUNT', 'MONITOR', 'POOL',
  'APPLICATION', 'PACKAGE', 'LISTING', 'GROUP', 'CONNECTION', 'VOLUME',
]);
// Replaced objects whose grants a replace drops (A6). The family is what GRANT ... ON ALL
// <family>S IN SCHEMA names.
const REPLACE_FAMILIES = new Set([
  'TABLE', 'VIEW', 'DYNAMIC TABLE', 'MATERIALIZED VIEW', 'EXTERNAL TABLE', 'EVENT TABLE',
  'ICEBERG TABLE', 'HYBRID TABLE', 'PROCEDURE', 'FUNCTION',
]);
const FAMILY_PREFIXES = new Set(['DYNAMIC', 'MATERIALIZED', 'EXTERNAL', 'EVENT', 'ICEBERG', 'HYBRID']);

// --- scanner --------------------------------------------------------------------------------

// Blank out comments (keeping newlines so offsets map to lines) and split on ';' outside
// '...', "...", $$...$$ and comments. Returns { clean, statements: [{ text, offset }] }.
function scan(text) {
  const n = text.length;
  let clean = '';
  const bounds = [];
  let start = 0;
  let state = 'code';
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = i + 1 < n ? text[i + 1] : '';
    if (state === 'code') {
      if (c === '-' && d === '-') { state = 'line'; clean += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; clean += '  '; i += 2; continue; }
      if (c === "'") { state = 'squote'; clean += c; i += 1; continue; }
      if (c === '"') { state = 'dquote'; clean += c; i += 1; continue; }
      if (c === '$' && d === '$') { state = 'dollar'; clean += '$$'; i += 2; continue; }
      if (c === ';') { clean += c; bounds.push([start, clean.length]); start = clean.length; i += 1; continue; }
      clean += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; clean += c; } else { clean += ' '; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; clean += '  '; i += 2; }
      else { clean += c === '\n' ? c : ' '; i += 1; }
      continue;
    }
    if (state === 'squote') {
      if (c === '\\' && d !== '') { clean += c + d; i += 2; continue; }
      clean += c;
      if (c === "'") {
        if (d === "'") { clean += d; i += 2; continue; }
        state = 'code';
      }
      i += 1; continue;
    }
    if (state === 'dquote') {
      clean += c;
      if (c === '"') state = 'code';
      i += 1; continue;
    }
    // dollar
    if (c === '$' && d === '$') { state = 'code'; clean += '$$'; i += 2; continue; }
    clean += c; i += 1;
  }
  if (start < clean.length) bounds.push([start, clean.length]);
  const statements = [];
  for (const [a, b] of bounds) {
    const text = clean.slice(a, b);
    if (text.replace(/[\s;]/g, '') === '') continue;
    statements.push({ text, offset: a });
  }
  return { clean, statements };
}

function lineAt(clean, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < clean.length; i++) if (clean[i] === '\n') line++;
  return line;
}

function snippet(s, max = 120) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '...' : t;
}

// --- names ----------------------------------------------------------------------------------

const NAME_RE = /^((?:"[^"]*"|[A-Za-z_$][\w$]*)(?:\s*\.\s*(?:"[^"]*"|[A-Za-z_$][\w$]*))*)/;

// Parse a (possibly qualified) identifier at the start of s. Returns { raw, parts, key, dots }.
function parseName(s) {
  const m = NAME_RE.exec(s);
  if (!m) return null;
  const raw = m[1];
  if (/^IDENTIFIER$/i.test(raw) || raw.includes('{')) return null;
  const parts = raw.split(/\s*\.\s*/).map((p) => (p.startsWith('"') ? p.slice(1, -1) : p.toUpperCase()));
  return { raw, parts, key: parts.join('.'), dots: parts.length - 1, length: raw.length };
}

// Tokenizer for the keyword run at the head of a DDL statement.
const WORD_RE = /\s*([A-Za-z_$][\w$]*)/y;

// CREATE / ALTER / DROP [OR REPLACE] <modifiers> <type> [IF [NOT] EXISTS] <name>
function parseDdl(text) {
  const head = /^\s*(CREATE|ALTER|DROP)\b/i.exec(text);
  if (!head) return null;
  let pos = head[0].length;
  const words = [];
  for (;;) {
    WORD_RE.lastIndex = pos;
    const w = WORD_RE.exec(text);
    if (!w) break;
    const up = w[1].toUpperCase();
    if (!(SKIP_WORDS.has(up) || MODIFIERS.has(up) || TYPE_WORDS.has(up))) break;
    words.push(up);
    pos = WORD_RE.lastIndex;
  }
  let typeIdx = -1;
  for (let k = words.length - 1; k >= 0; k--) if (TYPE_WORDS.has(words[k])) { typeIdx = k; break; }
  if (typeIdx < 0) return null;
  const type = words[typeIdx];
  const modifiers = words.slice(0, typeIdx).filter((w) => !SKIP_WORDS.has(w));
  const rest = text.slice(pos).replace(/^\s+/, '');
  const nameOffset = text.length - rest.length;
  const name = parseName(rest);
  if (!name) return null;
  return {
    verb: head[1].toUpperCase(),
    replace: /^\s*CREATE\s+OR\s+REPLACE\b/i.test(text),
    modifiers,
    type,
    family: familyOf(modifiers, type),
    name,
    nameOffset,
    text,
  };
}

function familyOf(modifiers, type) {
  const last = modifiers[modifiers.length - 1];
  if (last && FAMILY_PREFIXES.has(last)) return `${last} ${type}`;
  if (type === 'POLICY' && last) return `${modifiers.join(' ')} ${type}`;
  return type;
}

// How many dots a correctly qualified name of this type carries; null means "not judged".
function requiredDots(modifiers, type) {
  if (modifiers.some((m) => m === 'TEMPORARY' || m === 'TEMP' || m === 'VOLATILE')) return null;
  if (type === 'DATABASE') return 0;
  if (type === 'SCHEMA') return 1;
  if (type === 'ROLE') return modifiers.includes('DATABASE') ? 1 : 0;
  if (type === 'POLICY' && modifiers.includes('NETWORK')) return 0;
  if (ACCOUNT_LEVEL.has(type)) return 0;
  return 2;
}

// GRANT | REVOKE <privs> ON [ALL|FUTURE <types> IN] <type> <name> TO|FROM ...
function parseGrant(text) {
  const head = /^\s*(GRANT|REVOKE)\b/i.exec(text);
  if (!head) return null;
  const on = /\bON\s+/i.exec(text);
  if (!on) return null;
  let pos = on.index + on[0].length;
  const words = [];
  let scope = 'object';
  for (;;) {
    WORD_RE.lastIndex = pos;
    const w = WORD_RE.exec(text);
    if (!w) break;
    const up = w[1].toUpperCase();
    if (up === 'ALL' || up === 'FUTURE') { scope = up === 'ALL' ? 'all-in' : 'future-in'; pos = WORD_RE.lastIndex; continue; }
    if (up === 'IN') { pos = WORD_RE.lastIndex; continue; }
    if (up === 'TO' || up === 'FROM') break;
    const singular = up.endsWith('S') && !TYPE_WORDS.has(up) && TYPE_WORDS.has(up.slice(0, -1)) ? up.slice(0, -1) : up;
    if (!(MODIFIERS.has(singular) || TYPE_WORDS.has(singular))) break;
    words.push(singular);
    pos = WORD_RE.lastIndex;
  }
  let container = null;
  let objWords = words;
  if (scope !== 'object') {
    // ... ON ALL VIEWS IN SCHEMA x.y: the last type word is the container.
    container = words[words.length - 1];
    objWords = words.slice(0, -1);
  }
  const rest = text.slice(pos).replace(/^\s+/, '');
  const nameOffset = text.length - rest.length;
  const name = parseName(rest);
  if (scope === 'object' && words.length && words[words.length - 1] === 'ACCOUNT' && (!name || /^(TO|FROM)$/i.test(name.raw))) {
    return { verb: head[1].toUpperCase(), scope: 'account', text };
  }
  if (!name || /^(TO|FROM)$/i.test(name.raw)) return null;
  let type;
  let modifiers;
  if (scope === 'object') {
    let typeIdx = -1;
    for (let k = words.length - 1; k >= 0; k--) if (TYPE_WORDS.has(words[k])) { typeIdx = k; break; }
    type = typeIdx >= 0 ? words[typeIdx] : 'TABLE';
    modifiers = typeIdx >= 0 ? words.slice(0, typeIdx) : [];
  } else {
    type = container;
    modifiers = [];
  }
  const famWords = objWords.length ? objWords : [];
  let family = null;
  if (scope !== 'object' && famWords.length) {
    const t = famWords[famWords.length - 1];
    family = familyOf(famWords.slice(0, -1), t);
  } else if (scope === 'object') {
    family = familyOf(modifiers, type);
  }
  return {
    verb: head[1].toUpperCase(),
    scope, // object | all-in | future-in
    type, // for all-in/future-in: SCHEMA or DATABASE
    modifiers,
    family, // the granted object family (VIEW, TABLE, DYNAMIC TABLE ...)
    name,
    nameOffset,
    text,
  };
}

// INSERT INTO | MERGE INTO | COPY INTO | TRUNCATE [TABLE] | DELETE FROM | UPDATE <name>
const DML_RE = /^\s*(?:(INSERT)\s+(?:OVERWRITE\s+)?INTO|(MERGE)\s+INTO|(COPY)\s+INTO|(TRUNCATE)\s+(?:TABLE\s+)?(?:IF\s+EXISTS\s+)?|(DELETE)\s+FROM|(UPDATE))\s+/i;
function parseDml(text) {
  const m = DML_RE.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  if (rest.startsWith('@') || rest.startsWith('(')) return null; // a stage, or a subquery
  const name = parseName(rest);
  if (!name) return null;
  return { verb: (m[1] || m[2] || m[3] || m[4] || m[5] || m[6]).toUpperCase(), name, nameOffset: m[0].length, text };
}

// COMMENT [IF EXISTS] ON <type> <name> IS '...'
const COMMENT_RE = /^\s*COMMENT\s+(?:IF\s+EXISTS\s+)?ON\s+((?:[A-Z]+\s+)*?)([A-Z]+)\s+/i;
function parseComment(text) {
  const m = COMMENT_RE.exec(text);
  if (!m) return null;
  const type = m[2].toUpperCase();
  const modifiers = m[1].trim() ? m[1].trim().toUpperCase().split(/\s+/) : [];
  const name = parseName(text.slice(m[0].length));
  if (!name) return null;
  return { type, modifiers, name, nameOffset: m[0].length, text };
}

// --- per-package analysis -------------------------------------------------------------------

function listSqlFiles(root, exclude) {
  const stat = fs.statSync(root);
  if (stat.isFile()) return [{ abs: root, rel: path.basename(root) }];
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '.git' || ent.name === 'node_modules') continue;
        walk(abs);
      } else if (/\.sql$/i.test(ent.name)) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (exclude.some((re) => re.test(rel))) continue;
        out.push({ abs, rel });
      }
    }
  };
  walk(root);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

function findConfig(start, explicit) {
  if (explicit) return explicit;
  let dir = fs.statSync(start).isDirectory() ? start : path.dirname(start);
  for (;;) {
    const candidate = path.join(dir, '.verify-sql.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadConfig(file) {
  if (!file) return { patterns: [], exclude: [] };
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  const patterns = (cfg.patterns || []).map((p, i) => {
    if (!p.entry || !p.regex) throw new Error(`${file}: patterns[${i}] needs "entry" and "regex"`);
    return {
      entry: String(p.entry),
      title: p.title || `repo pattern ${p.entry}`,
      re: new RegExp(p.regex, (p.flags || 'i').replace(/[gy]/g, '')),
      scope: p.scope === 'line' ? 'line' : 'statement',
    };
  });
  const exclude = (cfg.exclude || []).map((s) => new RegExp(s));
  return { patterns, exclude };
}

function analyze(root, opts = {}) {
  const configFile = findConfig(root, opts.config);
  const config = loadConfig(configFile);
  const files = listSqlFiles(root, config.exclude);
  const findings = [];
  const add = (entry, file, line, matched, detail) => {
    findings.push({ entry, title: ENTRIES[entry] || detail, file, line, matched: snippet(matched), detail });
  };

  // Pass 1: scan every file, collect statements in package order plus the facts the
  // cross-statement checks need (views, temporary names, grants, replaces).
  const scanned = [];
  const views = new Set();
  const tempNames = new Set();
  const grants = []; // { seq, scope, family, key, schemaKey }
  const replaces = []; // { seq, family, key, schemaKey, copyGrants, file, line, text }
  let seq = 0;
  let statementCount = 0;
  for (const f of files) {
    const text = fs.readFileSync(f.abs, 'utf8');
    const { clean, statements } = scan(text);
    statementCount += statements.length;
    const items = statements.map((s) => {
      const first = s.text.search(/\S/);
      const line = lineAt(clean, s.offset + Math.max(first, 0));
      const item = { ...s, line, seq: seq++, ddl: parseDdl(s.text), file: f.rel, clean };
      if (item.ddl && item.ddl.verb === 'CREATE') {
        const d = item.ddl;
        if (d.type === 'VIEW' && (d.modifiers.length === 0 || d.modifiers.every((m) => m === 'SECURE' || m === 'RECURSIVE' || m === 'MATERIALIZED'))) {
          views.add(d.name.key);
        }
        if (d.modifiers.some((m) => m === 'TEMPORARY' || m === 'TEMP' || m === 'VOLATILE')) tempNames.add(d.name.key);
        if (d.replace && REPLACE_FAMILIES.has(d.family)) {
          replaces.push({
            seq: item.seq, family: d.family, key: d.name.key,
            schemaKey: d.name.parts.length >= 3 ? d.name.parts.slice(0, -1).join('.') : null,
            copyGrants: /\bCOPY\s+GRANTS\b/i.test(d.text), file: f.rel, line, text: d.text,
            noClause: d.family === 'PROCEDURE' || d.family === 'FUNCTION',
          });
        }
      }
      const g = parseGrant(s.text);
      if (g && g.scope !== 'account' && g.verb === 'GRANT') {
        grants.push({ seq: item.seq, scope: g.scope, family: g.family, key: g.name.key, type: g.type });
      }
      return item;
    });
    scanned.push({ file: f.rel, clean, raw: text, items });
  }

  // Pass 2: per-statement patterns.
  for (const sf of scanned) {
    for (const it of sf.items) {
      const t = it.text;
      const lineOf = (off) => lineAt(sf.clean, it.offset + off);
      const firstLine = lineOf(Math.max(t.search(/\S/), 0));

      // A1: qualification.
      const ddl = it.ddl;
      if (ddl) {
        const need = requiredDots(ddl.modifiers, ddl.type);
        if (need !== null && ddl.name.dots < need) {
          add('A1', sf.file, lineOf(ddl.nameOffset), t,
            `${ddl.verb} ${ddl.family} ${ddl.name.raw}: ${ddl.name.dots} of ${need} qualifier(s); the statement lands wherever the session points`);
        }
      } else {
        const g = parseGrant(t);
        if (g && g.scope !== 'account') {
          let need;
          if (g.scope === 'object') need = requiredDots(g.modifiers, g.type);
          else need = g.type === 'DATABASE' ? 0 : 1;
          if (need !== null && g.name.dots < need) {
            add('A1', sf.file, lineOf(g.nameOffset), t,
              `${g.verb} ON ${g.scope === 'object' ? g.family : `${g.scope === 'all-in' ? 'ALL' : 'FUTURE'} ... IN ${g.type}`} ${g.name.raw}: ${g.name.dots} of ${need} qualifier(s)`);
          }
        } else {
          const dml = parseDml(t);
          if (dml && dml.name.dots < 2 && !tempNames.has(dml.name.key)) {
            add('A1', sf.file, lineOf(dml.nameOffset), t, `${dml.verb} target ${dml.name.raw}: ${dml.name.dots} of 2 qualifier(s)`);
          } else {
            const cm = parseComment(t);
            if (cm) {
              let need;
              if (cm.type === 'COLUMN') need = 3;
              else need = requiredDots(cm.modifiers, cm.type);
              if (need !== null && cm.name.dots < need) {
                add('A1', sf.file, lineOf(cm.nameOffset), t, `COMMENT ON ${cm.type} ${cm.name.raw}: ${cm.name.dots} of ${need} qualifier(s)`);
              }
            } else {
              const use = /^\s*USE\s+(?!ROLE\b|WAREHOUSE\b|SECONDARY\b)(?:(DATABASE|SCHEMA)\s+)?/i.exec(t);
              if (use && parseName(t.slice(use[0].length))) {
                add('A1', sf.file, firstLine, t, `USE ${use[1] ? use[1].toUpperCase() : 'DATABASE'} sets session context; a deployable must not depend on it`);
              }
            }
          }
        }
      }

      // A2: single-quoted procedure or function body.
      if (ddl && ddl.verb === 'CREATE' && (ddl.type === 'PROCEDURE' || ddl.type === 'FUNCTION') && !t.includes('$$')) {
        const as = /\bAS\s*'/i.exec(t);
        if (as) {
          const q = as.index + as[0].length - 1;
          let k = q + 1;
          let closed = -1;
          while (k < t.length) {
            if (t[k] === '\\') { k += 2; continue; }
            if (t[k] === "'") { if (t[k + 1] === "'") { k += 2; continue; } closed = k; break; }
            k++;
          }
          const after = closed >= 0 ? t.slice(closed + 1).replace(/[\s;]/g, '') : '';
          if (closed < 0) {
            add('A2', sf.file, lineOf(q), t, "single-quoted body never closes in this statement");
          } else if (after) {
            add('A2', sf.file, lineOf(closed), t, `single-quoted body closes early at an unescaped quote; text after the close: ${snippet(t.slice(closed + 1), 60)}`);
          } else {
            add('A2', sf.file, lineOf(q), t, "single-quoted body: every inner quote must be doubled; use $$ delimiters");
          }
        }
      }

      // A3: COMMENT ON COLUMN against a view this package creates.
      {
        const cm = parseComment(t);
        if (cm && cm.type === 'COLUMN' && cm.name.parts.length >= 2) {
          const objKey = cm.name.parts.slice(0, -1).join('.');
          if (views.has(objKey)) {
            add('A3', sf.file, lineOf(cm.nameOffset), t, `${objKey} is created as a VIEW in this package; COMMENT ON COLUMN is scoped to tables`);
          }
        }
      }

      // A4: replace on a policy.
      if (ddl && ddl.replace && ddl.type === 'POLICY' && !ddl.modifiers.includes('NETWORK')) {
        add('A4', sf.file, firstLine, t, `CREATE OR REPLACE ${ddl.family} ${ddl.name.raw} fails if the policy is attached; ALTER ... SET BODY instead`);
      }

      // A5: CREATE MANAGED ACCOUNT IF NOT EXISTS.
      if (/^\s*CREATE\s+MANAGED\s+ACCOUNT\s+IF\s+NOT\s+EXISTS\b/i.test(t)) {
        add('A5', sf.file, firstLine, t, 'CREATE MANAGED ACCOUNT has no IF NOT EXISTS clause; pre-check in the runbook instead');
      }

      // Repo patterns, statement scope.
      for (const p of config.patterns) {
        if (p.scope !== 'statement') continue;
        const m = p.re.exec(t);
        if (m) findings.push({ entry: p.entry, title: p.title, file: sf.file, line: lineOf(m.index), matched: snippet(t), detail: `matched: ${snippet(m[0], 80)}` });
      }
    }

    // A7 over the comment-free text; line-scoped repo patterns over the raw text, comments
    // included, so a repo can flag markers that live in comments.
    const lines = sf.clean.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (/^\s*(?:ELSE\s*)?IF\s+(?!\()\S.*\bTHEN\s*$/i.test(ln)) {
        add('A7', sf.file, i + 1, ln, 'IF <condition> THEN without parentheses; the documented form is IF ( <condition> ) THEN');
      }
    }
    const rawLines = sf.raw.split('\n');
    for (let i = 0; i < rawLines.length; i++) {
      for (const p of config.patterns) {
        if (p.scope !== 'line') continue;
        const m = p.re.exec(rawLines[i]);
        if (m) findings.push({ entry: p.entry, title: p.title, file: sf.file, line: i + 1, matched: snippet(rawLines[i]), detail: `matched: ${snippet(m[0], 80)}` });
      }
    }
  }

  // A6: a replace without COPY GRANTS on an object granted on earlier, with no re-grant after.
  // Every other replace without COPY GRANTS goes into `notes`, so the count is visible without
  // being a finding (2026-10-01 follow-up: the adversary wanted to see the 36 the pairing rule
  // had cleared).
  const notes = [];
  for (const r of replaces) {
    if (r.copyGrants) continue;
    const grantedBefore = grants.filter((g) => g.seq < r.seq && (
      (g.scope === 'object' && g.key === r.key) ||
      (g.scope === 'all-in' && r.schemaKey && g.key === r.schemaKey && g.family === r.family)));
    const futureCovered = grants.some((g) => g.scope === 'future-in' && r.schemaKey && g.key === r.schemaKey && g.family === r.family);
    const regrantAfter = grants.some((g) => g.seq > r.seq && (
      (g.scope === 'object' && g.key === r.key) ||
      (g.scope === 'all-in' && r.schemaKey && g.key === r.schemaKey && g.family === r.family)));
    if (!grantedBefore.length || futureCovered || regrantAfter) {
      const why = !grantedBefore.length ? 'no earlier grant on it in this package'
        : futureCovered ? `${grantedBefore.length} earlier grant(s) restored by a FUTURE grant on the schema`
          : `${grantedBefore.length} earlier grant(s) re-granted after the replace`;
      notes.push({ entry: 'A6', file: r.file, line: r.line, matched: snippet(r.text), detail: `CREATE OR REPLACE ${r.family} ${r.key} without COPY GRANTS: ${why}` });
      continue;
    }
    const how = r.noClause ? 'this type has no COPY GRANTS clause; re-grant after the replace' : 'add COPY GRANTS or re-grant after the replace';
    add('A6', r.file, r.line, r.text, `CREATE OR REPLACE ${r.family} ${r.key} drops ${grantedBefore.length} earlier grant(s) in this package and nothing re-grants; ${how}`);
  }
  notes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));

  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.entry < b.entry ? -1 : 1)));
  const summary = {};
  const entriesChecked = [...Object.keys(ENTRIES), ...config.patterns.map((p) => p.entry).filter((e, i, arr) => arr.indexOf(e) === i)];
  for (const e of entriesChecked) summary[e] = 0;
  for (const f of findings) summary[f.entry] = (summary[f.entry] || 0) + 1;
  return {
    root: path.resolve(root),
    config: configFile ? path.resolve(configFile) : null,
    files: scanned.map((s) => ({ file: s.file, statements: s.items.length })),
    statements: statementCount,
    viewsCreated: [...views].sort(),
    entriesChecked,
    findings,
    notes,
    summary,
  };
}

// --- CLI ------------------------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  let target = null;
  let config = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config') { config = args[++i]; continue; }
    if (args[i] === '--help' || args[i] === '-h') { target = null; break; }
    if (!target) target = args[i];
  }
  if (!target) {
    process.stderr.write('usage: node static.js <package folder or .sql file> [--config <file>]\n');
    return 1;
  }
  if (!fs.existsSync(target)) {
    process.stderr.write(`static.js: ${target} does not exist\n`);
    return 1;
  }
  const result = analyze(target, { config });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (e) {
    process.stderr.write(`static.js: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { analyze, scan, parseDdl, parseGrant, parseDml, parseComment, requiredDots, ENTRIES };
