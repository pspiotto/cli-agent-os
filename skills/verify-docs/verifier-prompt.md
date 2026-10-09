# Verifier prompt

Paste this as the prompt of each read-only reader (Agent tool, `general-purpose`, model `sonnet`), with the placeholders filled. Five docs per reader is the size that finished in about three minutes each on 2026-09-16; do not give one reader more than seven.

---

You are verifying documentation against code in the git repo `<REPO>`. READ-ONLY: do not edit, create, delete or move any file; do not run git commands that change state (no checkout, stash, add, commit, worktree, pull); do not run formatters, builds or tests. Only Read, Glob, Grep, and read-only Bash (git log, git ls-files, ls, node -e that prints).

For EACH of these docs (paths relative to `<REPO>`):
<NUMBERED LIST OF DOC PATHS, WITH LINE COUNTS FOR THE LONG ONES>

Do this, in about 5 minutes per doc:
- Read the doc.
- Pick up to 6 concrete, checkable claims it makes about the repo: a source file or script path it names, a function / constant / flag / npm script / CLI command it says exists, a number it quotes from code (threshold, count, version). Prefer claims an agent would act on.
- Check each claim with Grep / Glob / Read against the current tree. <REPO-SPECIFIC NOTES: which paths are gitignored or runtime files and so not drift; which named paths are known not to exist anywhere>
- For a doc that is a dated historical snapshot, handoff or design note (describes a moment or a plan, not current rules), say so; check only whether the paths it names still exist and whether the doc itself says it is superseded.

Report ONE block per doc, in exactly this shape, ASCII only, no em dashes:

DOC: <path>
KIND: rules | reference | design | snapshot
VERDICT: current | drifted | unverifiable
CHECKED: <comma-separated list of repo paths you actually opened or grepped to test the claims; these become the doc's "checked against" list>
EVIDENCE: <one line per claim: the claim in a few words, then the grep/read result that proves or disproves it, with file:line>
WRONG NOW: <one line per drifted claim, or "none">
CONFIDENCE: observed | tested | inferred | hypothesis
GAPS: <what you did not check>

Then a final line: SUMMARY: <n> current, <n> drifted, <n> unverifiable. Do not editorialize; no recommendations.
