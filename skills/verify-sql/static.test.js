// Unit tests for skills/verify-sql/static.js.
//   node skills/verify-sql/static.test.js
// Builds throwaway packages under the OS temp folder, one per checklist entry plus a clean
// one and a repo-config one, runs the analyzer over each, and checks the findings by entry,
// file and line. Exits 1 if any case fails. Writes nothing outside the temp folder.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, 'static.js');
const { analyze } = require(script);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-sql-test-'));
let failed = 0;
let total = 0;

function check(label, ok, detail) {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  -> ${detail}` : ''}`);
}

function pkg(name, files) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  }
  return dir;
}

// 1-based line of the first line containing `needle`.
function lineOf(text, needle) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) return i + 1;
  throw new Error(`fixture lacks: ${needle}`);
}

function lines(result, entry, file) {
  return result.findings.filter((f) => f.entry === entry && (!file || f.file === file)).map((f) => f.line).sort((a, b) => a - b);
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// --- A1: qualification -----------------------------------------------------------------------

const A1 = [
  '-- comment only: CREATE OR REPLACE PIPE below is prose, not a statement',
  'CREATE TABLE T_BARE (X INT);',
  'CREATE TABLE S.T_ONE (X INT);',
  'CREATE TABLE D.S.T_FULL (X INT);',
  'CREATE TEMPORARY TABLE TMP_X (X INT);',
  'INSERT INTO TMP_X VALUES (1);',
  'CREATE DATABASE D;',
  'CREATE SCHEMA S_BARE;',
  'CREATE SCHEMA D.S;',
  "CREATE WAREHOUSE IF NOT EXISTS W WAREHOUSE_SIZE = 'XSMALL';",
  'GRANT SELECT ON VIEW V_BARE TO ROLE R;',
  'GRANT USAGE ON SCHEMA D.S TO ROLE R;',
  'GRANT SELECT ON ALL VIEWS IN SCHEMA D.S TO ROLE R;',
  'GRANT USAGE ON DATABASE D TO ROLE R;',
  'GRANT ROLE R TO USER U;',
  'INSERT INTO T_BARE VALUES (1);',
  'INSERT INTO D.S.T_FULL SELECT 1;',
  'USE SCHEMA D.S;',
  "COMMENT ON COLUMN D.S.T_FULL.X IS 'x; CREATE TABLE INSIDE_STRING (Y INT)';",
  "COMMENT ON COLUMN T_FULL.X IS 'x';",
  'CREATE DATABASE ROLE D.DR;',
  'CREATE DATABASE ROLE DR_BARE;',
  'ALTER TABLE T_BARE ADD COLUMN Y INT;',
  'DROP VIEW IF EXISTS D.S.V;',
  'GRANT USAGE ON WAREHOUSE W TO ROLE R;',
  'GRANT SELECT ON ALL TABLES IN SCHEMA S_BARE TO ROLE R;',
  'USE ROLE R;',
  'GRANT APPLY MASKING POLICY ON ACCOUNT TO ROLE R;',
  'MERGE INTO D.S.T_FULL T USING D.S.T_FULL S ON T.X = S.X WHEN MATCHED THEN UPDATE SET X = S.X;',
  'MERGE INTO T_BARE T USING D.S.T_FULL S ON T.X = S.X WHEN MATCHED THEN UPDATE SET X = S.X;',
  '/* block comment with CREATE TABLE INSIDE_BLOCK (Z INT); in it */',
  'CREATE OR REPLACE STORAGE INTEGRATION SI TYPE = EXTERNAL_STAGE;',
  'CREATE OR REPLACE FUNCTION F_BARE(X INT) RETURNS INT AS $$ X + 1 $$;',
].join('\n');
{
  const r = analyze(pkg('a1', { '01_a1.sql': A1 }));
  const expected = [
    'CREATE TABLE T_BARE', 'S.T_ONE', 'CREATE SCHEMA S_BARE', 'VIEW V_BARE', 'INSERT INTO T_BARE',
    'USE SCHEMA', "COMMENT ON COLUMN T_FULL.X", 'DATABASE ROLE DR_BARE', 'ALTER TABLE T_BARE',
    'IN SCHEMA S_BARE', 'MERGE INTO T_BARE', 'F_BARE',
  ].map((n) => lineOf(A1, n)).sort((a, b) => a - b);
  const got = lines(r, 'A1');
  check('A1: every unqualified target found, nothing else', same(got, expected), `got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  check('A1: only A1 fires on the A1 fixture', r.findings.every((f) => f.entry === 'A1'), JSON.stringify(r.summary));
  check('A1: comments and string literals are not statements', !r.findings.some((f) => /INSIDE_STRING|INSIDE_BLOCK|PIPE below/.test(f.matched)));
  check('A1: detail names the shortfall', r.findings.some((f) => /0 of 2 qualifier/.test(f.detail)));
}

// --- A2: single-quoted bodies ----------------------------------------------------------------

const A2 = [
  'CREATE OR REPLACE PROCEDURE D.S.P_GOOD()',
  'RETURNS STRING LANGUAGE SQL',
  "AS 'BEGIN RETURN ''a''; END';",
  'CREATE OR REPLACE PROCEDURE D.S.P_BAD()',
  'RETURNS STRING LANGUAGE SQL',
  "AS 'BEGIN RETURN 'oops'; END';",
  'CREATE OR REPLACE PROCEDURE D.S.P_DOLLAR()',
  'RETURNS STRING LANGUAGE SQL',
  "AS $$ BEGIN LET x STRING := 'AS ''q'''; RETURN x; END; $$;",
].join('\n');
{
  const r = analyze(pkg('a2', { '01_a2.sql': A2 }));
  const a2 = r.findings.filter((f) => f.entry === 'A2');
  check('A2: two single-quoted bodies found, the $$ one not', a2.length === 2 && !a2.some((f) => /P_DOLLAR/.test(f.matched)), JSON.stringify(a2.map((f) => f.matched)));
  check('A2: the escaped body is a warning about doubling quotes', a2.some((f) => /P_GOOD/.test(f.matched) && /must be doubled/.test(f.detail)));
  check('A2: the broken body is reported as closing early, at its line', a2.some((f) => /P_BAD/.test(f.matched) && /closes early/.test(f.detail) && f.line === lineOf(A2, "'oops'")));
  check('splitter: $$ body with inner semicolons is one statement (3 in file)', r.statements === 3, `statements=${r.statements}`);
  check('A2 fixture is fully qualified (no A1)', lines(r, 'A1').length === 0);
}

// --- A3: COMMENT ON COLUMN against a view ----------------------------------------------------

const A3 = [
  'CREATE OR REPLACE VIEW D.S.V AS SELECT 1 AS C;',
  'CREATE TABLE D.S.T (C INT);',
  "COMMENT ON COLUMN D.S.V.C IS 'view col';",
  "COMMENT ON COLUMN D.S.T.C IS 'table col';",
  "COMMENT ON VIEW D.S.V IS 'the view';",
].join('\n');
{
  const r = analyze(pkg('a3', { '01_a3.sql': A3 }));
  check('A3: the view column comment found, the table one not', same(lines(r, 'A3'), [lineOf(A3, 'view col')]), JSON.stringify(lines(r, 'A3')));
  check('A3: views created are listed', same(r.viewsCreated, ['D.S.V']), JSON.stringify(r.viewsCreated));
  check('A3 fixture has no other findings', r.findings.length === 1, JSON.stringify(r.summary));
}

// --- A4, A5, A7 -----------------------------------------------------------------------------

const A457 = [
  'CREATE OR REPLACE MASKING POLICY D.S.MP AS (V STRING) RETURNS STRING -> V;',
  'CREATE MASKING POLICY D.S.MP2 AS (V STRING) RETURNS STRING -> V;',
  'ALTER ROW ACCESS POLICY D.S.RAP SET BODY -> TRUE;',
  "CREATE OR REPLACE NETWORK POLICY NP ALLOWED_IP_LIST = ('1.1.1.1');",
  "CREATE MANAGED ACCOUNT IF NOT EXISTS RA ADMIN_NAME = 'a', ADMIN_PASSWORD = 'b', TYPE = READER;",
  "CREATE MANAGED ACCOUNT RA2 ADMIN_NAME = 'a', ADMIN_PASSWORD = 'b', TYPE = READER;",
  'CREATE OR REPLACE PROCEDURE D.S.P() RETURNS STRING LANGUAGE SQL AS $$',
  'BEGIN',
  '  LET a INT := 1;',
  '  IF a = 1 THEN',
  "    RETURN 'x';",
  '  ELSEIF a = 2 THEN',
  "    RETURN 'y';",
  '  END IF;',
  '  IF (a = 3) THEN',
  "    RETURN 'z';",
  '  END IF;',
  "  RETURN 'w';",
  'END;',
  '$$;',
].join('\n');
{
  const r = analyze(pkg('a457', { '01_mixed.sql': A457 }));
  check('A4: replace on a masking policy found; plain create, ALTER SET BODY and network policy not', same(lines(r, 'A4'), [lineOf(A457, 'POLICY D.S.MP ')]), JSON.stringify(lines(r, 'A4')));
  check('A5: CREATE MANAGED ACCOUNT IF NOT EXISTS found, the plain one not', same(lines(r, 'A5'), [lineOf(A457, 'IF NOT EXISTS RA')]), JSON.stringify(lines(r, 'A5')));
  check('A7: IF and ELSEIF without parentheses found, the parenthesised IF not', same(lines(r, 'A7'), [lineOf(A457, 'IF a = 1 THEN'), lineOf(A457, 'ELSEIF a = 2 THEN')]), JSON.stringify(lines(r, 'A7')));
  check('A4/A5/A7 fixture has no A1 (account-level names are zero-dot)', lines(r, 'A1').length === 0, JSON.stringify(lines(r, 'A1')));
}

// --- A6: grants lost on replace ---------------------------------------------------------------

const A6_1 = [
  'CREATE OR REPLACE VIEW D.S.V_LOST AS SELECT 1 AS C;',
  'GRANT SELECT ON VIEW D.S.V_LOST TO ROLE R;',
  'CREATE OR REPLACE VIEW D.S.V_COPY AS SELECT 1 AS C;',
  'GRANT SELECT ON VIEW D.S.V_COPY TO ROLE R;',
  'CREATE OR REPLACE VIEW D.S.V_REGRANT AS SELECT 1 AS C;',
  'GRANT SELECT ON VIEW D.S.V_REGRANT TO ROLE R;',
  'CREATE OR REPLACE TABLE D.S.T_LANDING (X INT);',
  'CREATE OR REPLACE VIEW D.S2.V_SCHEMA AS SELECT 1 AS C;',
  'GRANT SELECT ON ALL VIEWS IN SCHEMA D.S2 TO ROLE R;',
  'CREATE OR REPLACE VIEW D.S3.V_FUTURE AS SELECT 1 AS C;',
  'GRANT SELECT ON ALL VIEWS IN SCHEMA D.S3 TO ROLE R;',
  'GRANT SELECT ON FUTURE VIEWS IN SCHEMA D.S3 TO ROLE R;',
].join('\n');
const A6_2 = [
  'CREATE OR REPLACE VIEW D.S.V_LOST AS SELECT 2 AS C;',
  'CREATE OR REPLACE VIEW D.S.V_COPY COPY GRANTS AS SELECT 2 AS C;',
  'CREATE OR REPLACE VIEW D.S.V_REGRANT AS SELECT 2 AS C;',
  'GRANT SELECT ON VIEW D.S.V_REGRANT TO ROLE R;',
  'CREATE OR REPLACE TABLE D.S.T_LANDING (X INT, Y INT);',
  'CREATE OR REPLACE VIEW D.S2.V_SCHEMA AS SELECT 2 AS C;',
  'CREATE OR REPLACE VIEW D.S3.V_FUTURE AS SELECT 2 AS C;',
].join('\n');
{
  const r = analyze(pkg('a6', { '01_create.sql': A6_1, '02_replace.sql': A6_2 }));
  check('A6: the first create of a granted object is not a finding', lines(r, 'A6', '01_create.sql').length === 0, JSON.stringify(lines(r, 'A6', '01_create.sql')));
  check('A6: object grant lost and schema-level ALL grant lost are found', same(lines(r, 'A6', '02_replace.sql'), [lineOf(A6_2, 'V_LOST'), lineOf(A6_2, 'V_SCHEMA')]), JSON.stringify(lines(r, 'A6', '02_replace.sql')));
  check('A6: COPY GRANTS, a re-grant after, a landing table and a FUTURE grant are not findings', !r.findings.some((f) => /V_COPY|V_REGRANT|T_LANDING|V_FUTURE/.test(f.matched)));
  check('A6: detail says how many grants and what to do', r.findings.some((f) => f.entry === 'A6' && /drops 1 earlier grant/.test(f.detail) && /COPY GRANTS/.test(f.detail)));
  check('A6 fixture has no other findings', r.findings.every((f) => f.entry === 'A6'), JSON.stringify(r.summary));
  const noteKeys = r.notes.map((n) => `${n.file}:${n.line}`);
  check('A6 notes: every replace without COPY GRANTS that is not a finding is listed (6 in 01, 3 in 02)', r.notes.length === 9 && noteKeys.filter((k) => k.startsWith('01_')).length === 6, JSON.stringify(noteKeys));
  check('A6 notes: the COPY GRANTS replace and the two findings are not notes', !noteKeys.includes(`02_replace.sql:${lineOf(A6_2, 'V_COPY')}`) && !noteKeys.includes(`02_replace.sql:${lineOf(A6_2, 'V_LOST')}`) && !noteKeys.includes(`02_replace.sql:${lineOf(A6_2, 'V_SCHEMA')}`), JSON.stringify(noteKeys));
  check('A6 notes: reasons name the cover', r.notes.some((n) => /FUTURE grant/.test(n.detail)) && r.notes.some((n) => /re-granted after/.test(n.detail)) && r.notes.some((n) => /no earlier grant/.test(n.detail)));
}

// --- repo config: patterns, exclude, discovery by walking up ---------------------------------

{
  const root = pkg('cfg', {
    '.verify-sql.json': JSON.stringify({
      patterns: [
        { entry: 'X1', title: 'SELECT star in a view', regex: 'SELECT\\s+\\*', flags: 'i' },
        { entry: 'X2', title: 'TODO left in a deployable', regex: 'TODO', scope: 'line' },
      ],
      exclude: ['^skip/'],
    }),
    'pkg/01_clean.sql': 'CREATE OR REPLACE VIEW D.S.V COPY GRANTS AS SELECT * FROM D.S.T;\n-- TODO later\n',
    'pkg/skip/02_bad.sql': 'CREATE TABLE BARE (X INT);\n',
  });
  const r = analyze(path.join(root, 'pkg'));
  check('config: found by walking up from the package', r.config && r.config.endsWith('.verify-sql.json'), String(r.config));
  check('config: statement-scope pattern fires with a line', same(lines(r, 'X1'), [1]), JSON.stringify(lines(r, 'X1')));
  check('config: line-scope pattern sees comments', same(lines(r, 'X2'), [2]), JSON.stringify(lines(r, 'X2')));
  check('config: excluded path is not read', r.files.length === 1 && lines(r, 'A1').length === 0, JSON.stringify(r.files));
  check('config: entriesChecked lists the repo entries after A1..A7', same(r.entriesChecked, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'X1', 'X2']), JSON.stringify(r.entriesChecked));
  let threw = false;
  try { analyze(path.join(root, 'pkg'), { config: path.join(root, 'nope.json') }); } catch (e) { threw = /nope\.json/.test(e.message) || /ENOENT/.test(e.message); }
  check('config: an unreadable --config is an error, not a silent default', threw);
}

// --- clean package ----------------------------------------------------------------------------

{
  const clean = pkg('clean', {
    '01_views.sql': 'CREATE OR REPLACE VIEW D.S.V AS SELECT 1 AS C;\nGRANT USAGE ON SCHEMA D.S TO ROLE R;\n',
    'sub/02_grants.sql': 'GRANT SELECT ON ALL VIEWS IN SCHEMA D.S TO ROLE R;\nGRANT SELECT ON FUTURE VIEWS IN SCHEMA D.S TO ROLE R;\n',
  });
  const r = analyze(clean);
  check('clean: zero findings', r.findings.length === 0, JSON.stringify(r.findings));
  check('clean: the ungranted replace is a note, not a finding', r.notes.length === 1 && /no earlier grant/.test(r.notes[0].detail), JSON.stringify(r.notes));
  check('clean: every entry still listed as checked, each at 0', same(r.entriesChecked, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']) && Object.values(r.summary).every((n) => n === 0));
  check('clean: files sorted by relative path, subfolder included', same(r.files.map((f) => f.file), ['01_views.sql', 'sub/02_grants.sql']), JSON.stringify(r.files));
}

// --- CLI ---------------------------------------------------------------------------------------

{
  const single = path.join(tmpRoot, 'a3', '01_a3.sql');
  const r = spawnSync(process.execPath, [script, single], { encoding: 'utf8' });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
  check('cli: a single .sql file is accepted and prints JSON', r.status === 0 && parsed && parsed.files.length === 1 && parsed.summary.A3 === 1, `status=${r.status}`);
  const missing = spawnSync(process.execPath, [script, path.join(tmpRoot, 'does-not-exist')], { encoding: 'utf8' });
  check('cli: a missing path exits 1 with a message', missing.status === 1 && /does not exist/.test(missing.stderr));
  const noargs = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  check('cli: no argument prints usage and exits 1', noargs.status === 1 && /usage/.test(noargs.stderr));
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
