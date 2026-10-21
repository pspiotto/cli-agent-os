---
name: verify-docs
description: Verify the docs agents load most in a repo against its code and stamp each with a "Last verified: <date> (<machine>) - checked against <paths>" line, plus "Wrong now:" for what drifted. Takes the list from the entropy-sweep scan, delegates the reading to read-only Sonnet verifiers, re-checks every reported drift itself, shows the stamps as a dry run, and writes only on approval. Never edits doc prose, never commits. Invoke as /verify-docs <repo> [--top N].
disable-model-invocation: true
---

# verify-docs

The ledger line for a document: when it was last checked, on which machine, against what, and what is wrong in it. The sweep (`/entropy-sweep`) reads these lines and flags a doc whose named files have moved since its date. This skill writes them, and only after a real check, because a date without a check is the unproven claim the claims hook exists to stop.

Scripts live next to this file in `C:\GIT\cli-agent-os\skills\verify-docs\` (install.ps1 rewrites that path):
- `topdocs.js <scan.json> [--top N]`: the ranked list with line counts and current stamps.
- `verifier-prompt.md`: the prompt each reader gets.
- `stamp.js <repo> <spec.json> [--write]`: dry by default; `--write` is the arming token.

## Steps

1. **Scan.** Run the sweep's scanner for the repo (`node C:\GIT\cli-agent-os\skills\entropy-sweep\scan.js <repo> --out <scratchpad>/scan.json`; never a `>` redirect, which the no-shell-edits hook blocks). It is read-only. If a scan from today already exists in the scratchpad, reuse it.
2. **List.** `node C:\GIT\cli-agent-os\skills\verify-docs\topdocs.js <scratchpad>/scan.json --top <N>` (default: all of the scan's top list, which is 20 unless the scan ran with `--top`). Show the table. A doc already stamped today is skipped unless {{OWNER}} says otherwise.
3. **Verify, delegated.** Split the docs into groups of five. For each group launch one `general-purpose` agent on `sonnet` with `verifier-prompt.md` filled in (repo path, the numbered doc list with line counts, and any repo-specific notes such as gitignored runtime paths). All groups run in parallel. They are read-only by instruction; nothing they say is trusted yet.
4. **Re-check every drift yourself.** For each `WRONG NOW` line, run the one grep or read that proves or disproves it, in this session, and quote the result. A drift you could not reproduce is dropped from the note and recorded in the report as "reported, not reproduced". Spot-check at least one `current` verdict per group the same way.
5. **Build the spec.** One entry per doc in `<scratchpad>/verify-spec.json` (shape in `stamp.js`): `date` is today from `Get-Date -Format 'yyyy-MM-dd'` in the PowerShell tool; `machine` from `~/.claude/machine.txt`; `checked` is the reader's CHECKED list trimmed to repo paths; `scope` for snapshots and partial reads says what was and was not checked; `note` is the reproduced drift, one line, ASCII. A doc the readers could not verify in the time given gets `"date": "never"` and a `scope` saying why; it is a finding, not a silent pass.
6. **Dry run and ask.** `node stamp.js <repo> <scratchpad>/verify-spec.json` prints every line it would write and which docs it would skip. Show that output and ask for approval with a yes/no question. Write nothing before the answer.
7. **Write.** `node stamp.js <repo> <scratchpad>/verify-spec.json --write`. Then `git -C <repo> diff --stat` (insertions only on a first stamping) and `git -C <repo> diff | grep '^+' | LC_ALL=C grep -c '[^ -~]'` -> `0`.
8. **Read it back.** Re-run the scanner; `checks.last_verified` must show every stamped doc parsed (`topDocs[].verified` set) and no `top-doc-without-line` finding for them. Quote the counts.
9. **Report** as a table: doc, verdict, what was checked, what is wrong now. Then the counts (current / drifted / never), the diff stat, and the readers' GAPS in one line each. No commit, no push; say the stamps are uncommitted in `<repo>`.

## Rules

- Stamp only. Never fix the prose of a drifted doc here; the `Wrong now:` line records it and the owning work item fixes it.
- Readers are read-only and get no write tools in their instructions; the parent does the writing, after approval, through `stamp.js` only.
- ASCII in every line written. The doc's own pre-existing non-ASCII is not this skill's to change.
- One repo per invocation. A repo whose `CLAUDE.md` and agent definitions drive running agents is verified with those agents stopped, because the docs are live prompts.
