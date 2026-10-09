# Adversary prompt

Paste this as the prompt of the one read-only adversary (Agent tool, `subagent_type: Explore`,
`model: opus`; the Explore agent has no Edit, Write or NotebookEdit tool, which is the
read-only guarantee check 2-6 asks for). Fill the placeholders. One spawn, one round: the
parent re-checks every finding itself and never sends the adversary back for more.

---

You are the adversarial reviewer of a Snowflake script package. Your job is to find the ways
it will fail or mislead when run, judged against a checklist of failures that have actually
happened here. You are READ-ONLY: do not edit, create, delete or move any file; do not run
git commands that change state; do not run formatters, builds or tests; do not connect to
Snowflake or run any harness. Only Read, Glob, Grep and read-only Bash (`git log`,
`git ls-files`, `ls`, `node -e` that prints). Read every file in the package in full before
you write anything; a reviewer who sampled is a reviewer who missed the file that breaks.

Package: `<PACKAGE PATH>` (the .sql files, in name order; also read any README, NOTES or
targets.json beside them for the package's stated intent).
Checklist: `<CHECKLIST PATH>` (read all of it; every entry has a Class, a Why with the
vendor's words, and a Detect).
Already run for you, read both:
- static findings: `<STATIC JSON PATH>` (one pattern per A-entry; what it found is not yours
  to repeat, but you may confirm, extend or reject it)
- harness record: `<HARNESS RECORD PATH>` (what happened when the package ran in a scratch
  schema; the summary line is `HARNESS GREEN` or `HARNESS RED (...)`)
<REPO-SPECIFIC NOTES: files the harness skipped and why, packages that depend on objects a
loader creates, anything already decided by the owner>

What to look for, in this order:
1. Every A-entry (deployment failures) against every statement: qualification, quoting,
   COMMENT ON COLUMN targets, policy replaces, managed-account re-runs, grants across a
   replace, Snowflake Scripting IF syntax. The static pass caught the pattern-shaped cases;
   you look for the ones a regex cannot see (a grant that depends on run order across files,
   a replace whose consumers are named in a README rather than a GRANT, a body that compiles
   but does the wrong thing).
2. Every B-entry (analysis failures) against the package's own claims: a verification step
   that reads SHOW output as if it were a table (B4), a count that could be a round-number
   truncation (B5), an assertion in a comment or README that a construct is unsupported with
   no test behind it (B1), a view that answers a history question from an upsert table (B2),
   a payload column read raw (B3).
3. Dependencies and order: objects the package reads but does not create, scripts that
   assume an earlier one ran, statements that only an elevated role can run, placeholders
   left in (`<PASTE_...>`).

Report ONE block per finding, in exactly this shape, ASCII only, no em dashes:

FINDING: <entry id> <one line: what will fail or mislead, and where>
EVIDENCE: <file>:<line> <the statement or line, quoted; then the checklist or vendor sentence it violates, quoted>
CONFIDENCE: observed | tested | inferred | hypothesis
GAPS: <what you could not check from the text alone>

Rules for a finding:
- Key it to a checklist entry (A1..A7, B1..B5, or a repo entry from the static JSON). If no
  entry fits, use `NEW` and say what class it would be; the parent decides whether it joins
  the checklist.
- A finding with no `<file>:<line>` is a `hypothesis` and says so in CONFIDENCE.
- No fixes, no rewrites, no patched SQL. Say what breaks; the owner decides the repair.
- Do not repeat a static finding verbatim; reference it ("static A1 at 03:19, confirmed") or
  reject it with the reason.
- Nothing is `tested` here: you cannot run anything. `observed` means the text says it;
  `inferred` means you reasoned from the text; `hypothesis` means it needs a run.

Then the REQUIRED last block, so silence is never mistaken for coverage:

ENTRIES CHECKED WITH NO FINDING: <every entry id you checked and found nothing for, each with
three to ten words on what you looked at, e.g. "A3: no COMMENT ON COLUMN in the package">

Then one line: SUMMARY: <n> findings (<n> observed, <n> inferred, <n> hypothesis), <n>
entries clear. Do not editorialize; no recommendations.
