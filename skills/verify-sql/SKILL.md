---
name: verify-sql
description: Adversarial review of a Snowflake script package against the repo's failure checklist, by default. Probes the Cortex second opinion, runs the static patterns (static.js, read-only), reads the newest scratch-schema harness record for the package and stops if there is none, spawns one read-only Opus adversary for one round, sends the same brief through AI_COMPLETE, re-checks every finding itself, and writes a verdict table per checklist entry next to the harness record. Never edits the package, never runs the harness, never commits. Invoke as /verify-sql <package> [checklist].
disable-model-invocation: true
---

# verify-sql

The second opinion {{OWNER}} used to ask for by hand, made the default step between "the
package exists" and "the package is a runbook". Three readers, each on the cheapest thing that
can do its part: a regex (`static.js`) for the pattern-shaped entries, a read-only Opus
subagent for what a reader catches, and Cortex `AI_COMPLETE` for an opinion from outside the
session. The parent trusts none of them: every finding is re-opened at its file and line
before it reaches the table. Built for a Snowflake data engineering repo;
class-level, so any repo with a checklist can use it.

Scripts live next to this file in `C:\GIT\cli-agent-os\skills\verify-sql\` (install.ps1 rewrites
that path):
- `static.js <package> [--config <file>]`: one pattern per static checklist entry (A1 to A7),
  JSON to stdout, reads only. A repo adds its own patterns in `.verify-sql.json` at its root.
- `adversary-prompt.md`: the brief the subagent gets.
- `cortex-prompt.js <package> <checklist> [--model <name>]`: prints the `AI_COMPLETE` SELECT
  with the brief, the checklist entries and the package text dollar-quoted inside it.
- `static.test.js`: the unit tests.

## Inputs

- The package: a folder of `.sql` files (or one file). Relative to the current directory.
- The checklist: the second argument, else `docs/failure-checklist.md` in the repo the package
  is in (walk up to the git root). No checklist, no review: say so and stop.
- The harness record: the newest `harness/runs/<KEY>-<yyyymmdd-HHmm>.md` in that repo whose
  `package:` line names this package (`KEY` is from the package's `targets.json`).
- A scratchpad folder for the intermediate files; nothing goes into the repo except the
  verify record in step 7.

## Steps

1. **Probe Cortex.** One SELECT through the Snowflake connector, after the governance
   bootstrap query the organization instructions require:
   ```sql
   SELECT CURRENT_REGION() AS REGION, AI_COMPLETE('llama3.3-70b', 'Reply with the single word OK.') AS REPLY
   ```
   Quote the reply. If the connector refuses it, the role lacks `SNOWFLAKE.CORTEX_USER`, or the
   model is not in the region (the vendor's regional availability page lists them; the
   function is a SELECT, so SELECT-only governance allows it), record `not run` with the
   connector's message and skip step 5. `SNOWFLAKE.CORTEX.COMPLETE` is the legacy name
   ("This legacy function will be deprecated by the end of 2026", vendor page read
   2026-10-01); use `AI_COMPLETE`.
2. **Static.** `node "C:\GIT\cli-agent-os\skills\verify-sql\static.js" <package> > <scratchpad>/static.json`,
   then read the file. `git -C <repo> status --short` before and after must be identical;
   if not, stop and say so. Show the `summary` counts.
3. **Harness record.** Find the newest record for the package and quote its summary line
   (`HARNESS GREEN` or `HARNESS RED (<n> failing, <m> inconclusive)`) and its `package head:`
   line. **No record: say "no harness run for <package>" and stop here.** A review without a
   run is the review that passes broken packages. {{OWNER}} can say "review anyway"; quote that
   in the table's header and go on. If the record exists but the package has changed since its
   head (`git -C <repo> log -1 --format=%h -- <package>` differs, or `git status --short
   <package>` shows untracked or modified files), the record is **stale**: name the files it
   did not cover, go on, and mark the harness column `not run` for anything only those files
   do. Never run the harness from here; that is `harness/run.py run ... --confirm RUN-<date>`,
   the harness's armed command, run separately and cited.
4. **Adversary.** One subagent, one round: Agent tool, `subagent_type: Explore`, `model: opus`,
   prompt from `adversary-prompt.md` with the placeholders filled (package path, checklist
   path, the static JSON path, the record path, repo notes). The Explore agent's tool list has
   no Edit, Write or NotebookEdit, which is the read-only guarantee; say so in the report.
   Its output is not trusted yet. Do not send it back for a second round; what it missed goes
   on the follow-up list.
5. **Cortex.** If step 1 worked:
   `node "C:\GIT\cli-agent-os\skills\verify-sql\cortex-prompt.js" <package> <checklist> > <scratchpad>/cortex.sql`,
   read the file, run its one statement through the connector, and save the reply to
   `<scratchpad>/cortex-reply.md`. The connector carries one statement per call and the
   prompt is dollar-quoted; the script turns any `$$` in the package into `$ $` and says so
   at the top of the prompt. A prompt the connector rejects for size is `not run` with the
   message; do not split the package to make it fit.
6. **Re-check every finding** from steps 2, 4 and 5 yourself: open the file at the cited line
   (Read with offset and limit) and confirm the pattern is there and means what the finding
   says. A finding that survives keeps its file and line. A finding that does not is listed
   as **rejected**, with the one line that disproves it. A finding with no file and line is
   a hypothesis and goes to the follow-up list, not the table. Two readers finding the same
   thing is one row, with both named.
7. **Verdict table and record.** One row per checklist entry (A1..B5 plus any repo entries):

   | Entry | Static | Harness | Adversary | Cortex | Verdict |
   |---|---|---|---|---|---|
   | A1 | 0 hits | pass | none | none | pass |
   | A6 | 1 hit (03:19) | FAIL (V_X grant lost) | confirmed | missed | FAIL |

   Cell values: a count with file:line for hits, `pass` or `FAIL (<what>)` from the record's
   check for that entry, `confirmed` / `none` / `missed` / `rejected` for the readers,
   `not run` where a reader did not run. Verdict: `FAIL` if any surviving finding, `pass` if
   every reader that ran came back clean and the harness check for the entry passed or does
   not exist, `not run` if nothing could judge it (an analysis entry with no adversary
   finding and no harness check is `pass` only if the adversary listed it under "entries
   checked with no finding"). Under the table: the rejected list (zero entries is fine, say
   so), the follow-up list, the harness record's summary line, the adversary's SUMMARY line
   and the Cortex SUMMARY line or `not run`.

   Write the same content to `harness/runs/<KEY>-<yyyymmdd-HHmm>-verify.md` beside the harness
   record (timestamp from `Get-Date -Format 'yyyyMMdd-HHmm'` in the PowerShell tool), with a
   header naming the package, its head, the record it cites, the checklist, the model used
   for each reader, and the override if the owner gave one. Show the table in the reply. Nothing
   else is written; the record goes in through `/commit-tickets` under the package's key.

## Never

- Edit the package, or write anything into the repo other than the verify record.
- Run the harness (`run.py run` or `drop`); cite the record instead.
- A second adversary round, a second adversary, a builder agent.
- `git add`, `git commit`, `git push`.
- A verdict of `pass` for an entry no reader looked at.
