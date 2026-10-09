---
name: entropy-sweep
description: Find and report repo entropy (unreferenced docs, docs older than the code they describe, stale or missing "Last verified" lines, orphaned worktrees, dead agent definitions, divergent duplicate files, unreachable-code candidates) by running scan.js and writing docs/entropy-<date>.md. Reports only; never deletes or edits a doc. Invoke with /entropy-sweep [repo path].
disable-model-invocation: true
---

# entropy-sweep

The instrument, not the cleanup. It answers "which documents and worktrees in this repo are nobody's any more" with evidence per line, and it changes nothing except the one report file it writes.

## What to do

1. Pick the repo: the argument if given, else the current working directory. It must be a git checkout (`.git` present).
2. Run the scanner and keep its output out of the conversation:

   ```
   node "C:\GIT\cli-agent-os\skills\entropy-sweep\scan.js" <repo> > <scratchpad>/entropy-scan.json
   ```

   The scanner is plain Node with no dependencies. It walks `git ls-files`, one `git log`, `git worktree list` and the sibling folders of the repo's parent, and prints JSON. Exit code other than 0 means it did not run; say so and stop. Do not reason about the repo yourself; read the JSON.
3. Render the report. `report.js` turns the JSON into the markdown below deterministically, so the report never depends on what the model felt like summarizing:

   ```
   node "C:\GIT\cli-agent-os\skills\entropy-sweep\report.js" <scratchpad>/entropy-scan.json --out <repo>/docs/entropy-<yyyy-mm-dd>.md
   ```

   Use the repo root instead of `docs/` only when the repo has no `docs/` folder. If the file already exists, `report.js` appends a `## Re-run <time>` section and never overwrites. This is the only file the invocation creates.
4. Read the report back (the Read tool) before saying anything about it. Each check carries `command` (what produced it) and every finding carries its `evidence`. `checks.worktrees.all` in the JSON lists every worktree, flagged or not. The top-N table under "3. Last verified" is the ranked list of docs that agents load without being asked; that list is what `/verify-docs` stamps.
5. Triage every finding (the section below), then reply with the summary counts as a table, the path of the report, and the triage lines, and nothing else. Findings are not acted on by this invocation; triage names what each one becomes, it does not do it.

## Triage

A finding that stays "reported" is a finding nobody owns. Once the report is read back, every finding leaves it as exactly one of three dispositions, written as one line in the reply and again in the session's NOTES.md entry:

- `verify: <doc>` - the doc goes on the next `/verify-docs <repo>` run. Nothing else happens to it here.
- `decide: <owner> - <finding> - <the question>` - a person or session has to choose: prune or keep a worktree, reconcile a duplicate and which copy wins, import or delete a code candidate. The owner is a name ({{OWNER}}, the Orchestrator, the session that owns the repo), never "someone". The line also goes into that repo's queue or NOTES so the owner meets it without reading this report.
- `remove: <path>` - a path proposed for the quarantine step. Proposed only: nothing moves until {{OWNER}} approves the list and the armed step runs with its token.

Defaults per check. Depart from one only with the reason on the line:

| check | default | note |
|---|---|---|
| 1. Unreferenced markdown | `remove`, or `decide` when the doc may still be wanted | Also read the names the references came from: a snapshot (`SHUTDOWN-*`, `HANDOFF-*`) cited only by later snapshots does not surface here and is still dead. List those as `remove` with the citing files named as the evidence. The repo's live session file never surfaces: `NOTES.md`, a root `HANDOFF*.md`, and `HANDOFF-<worker>.md` while `<worker>` has a worktree or branch are exempt (one definition with the NOTES Stop hook, `hooks/session-file.js`) and listed in the section's note. A `HANDOFF-*` that does surface has no live worker, so it is a snapshot: `remove`. |
| 2. Docs older than code | `verify` for docs in the top-N table; the rest get one line, `verify: later - <n> docs outside the top N` | Noisy by design. This check is the `/verify-docs` input queue, not a finding to act on by itself. |
| 3. Last verified | `verify` | A top-N doc left unstamped on purpose (this repo's own `CLAUDE.md`, say) is `decide: {{OWNER}} - standing, skip`, not a new finding each week. |
| 4. Worktrees | `decide: <owner of that repo's worktrees>` | Never `remove`. A worktree is not a path the quarantine step can move. |
| 5. Dead agent definitions | `decide` | First check whether any tracked file references the agent; a referenced Agent-tool subagent is a false positive, say so on the line. |
| 6. Divergent duplicates | `decide: <owner> - which copy wins` | A generic name (README, DESIGN, HANDOFF, DECISIONS, NOTES) paired across unrelated repos is a false positive; say so on the line. |
| 7. Unreachable candidates | `decide` | `*.config.*` and scripts run directly (`dev/`, `probes/`, `examples/`) are entry points; say so on the line. `remove` only after the owner says delete. |

Findings that share a check, a disposition and an owner may share one line with a count and the paths listed under it; `remove` paths are always listed one per line, because that list becomes the quarantine step's paths file. A false positive still gets its line (`decide: none - false positive, <class>`), so the counts in the reply add up to the summary table. If they do not add up, say which findings are missing a disposition rather than sending the reply.

## Report format

```
# Entropy sweep: <repo>, <date>

Scanned <n> tracked files, <m> markdown, default branch <b>, at <time>. Scanner: skills/entropy-sweep/scan.js in cli-agent-os. Read-only.

## Summary
| check | findings |
(one row per check)

## 1. Unreferenced markdown
one line per finding: `path` (last commit <date>) - <evidence>

## 2. Docs older than the code they describe
one line per finding: `doc` committed <date>, names `path` committed <date>

## 3. Last verified
### Top <N> loaded docs
| path | inbound | from | Last verified |
### Findings
one line per finding, kind first

## 4. Worktrees
| path | branch | last commit | days | flags |
(every worktree, flagged or not)

## 5. Dead agent definitions
## 6. Divergent duplicates
one line per name: both paths with their sha1 prefixes
## 7. Unreachable code (candidate, not proof)
```

Every line quotes the evidence field. A check with no findings still gets its heading and the line "none".

## The quarantine step (a separate invocation, never this one)

`remove:` lines become moves only when {{OWNER}} approves the list, in a later turn or session, never in the invocation that found them. Write the approved paths to a file in the scratchpad, one per line (the `remove: <path>` lines paste as they are), then:

```
node "C:\GIT\cli-agent-os\skills\entropy-sweep\quarantine.js" <repo> <paths-file>                                   # dry run: show it, ask
node "C:\GIT\cli-agent-os\skills\entropy-sweep\quarantine.js" <repo> <paths-file> --confirm QUARANTINE-<yyyy-mm-dd>  # only after the yes, today's date
```

It moves each file to `<repo-parent>/quarantine/<repo>-<date>/<relative path>`, writes `MANIFEST.md` there (source, destination, sha1, the report line that named it), and stages the removal with `git rm --cached`. It never deletes, never commits, never overwrites, and one refused path (untracked, uncommitted changes, protected name, the repo's session file (`NOTES.md`, `HANDOFF.md`, any root `HANDOFF*.md`), under `.claude/`, outside the repo, destination exists) stops the whole run before anything moves. Undo per file: `git -C <repo> restore --staged --worktree -- <path>`. The commit of the staged removals is the repo owner's, not this step's. Read the manifest and `git status --short` back before reporting what moved.

## Safety rule, not negotiable

- The sweep never deletes and never edits a document. It has no delete path. Removal is the separate armed step above: an explicit dated token on the command line, and anything removed moves to a quarantine folder with a manifest saying what moved and from where, never `rm`.
- Never run a formatter, never touch worktrees, never `git worktree prune`, never check out a branch.
- If the report path already exists for today, append a `## Re-run <time>` section instead of overwriting.
- ASCII only in the report.
