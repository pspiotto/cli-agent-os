---
name: commit-tickets
description: Commit uncommitted work grouped by Jira ticket key. Runs group.js (read-only) over git status, shows one proposed commit per key as a table, waits for approval per group, then stages exactly those paths and commits with "<KEY>: <one line>" and the folders touched in the body. Anything without a key is shown as ungrouped and never committed until {{OWNER}} assigns it. Never git add -A, never amend, never push. Invoke with /commit-tickets [repo path].
disable-model-invocation: true
---

# commit-tickets

One commit per ticket key, from whatever is uncommitted right now. The detection is a plain
script; the model only reasons about the table it prints. Built for a data engineering work
repo and generic enough for any repo that names tickets in paths or file heads.

## Inputs

- The repo: the argument, else the current working directory. It must be a git work tree.
- The key pattern: `[A-Z][A-Z0-9]+-[0-9]+` by default. A repo overrides it with
  `.commit-tickets.json` at its root: `{ "pattern": "DATA-[0-9]+", "flags": "i", "lines": 30,
  "ignore": ["UTF-8"] }`. `flags` are JavaScript regex flags; `lines` is how many leading lines
  of a file are searched for a key when the path has none.
- No network. The skill does not look tickets up in Jira; a key is a string.
- Session logs (`NOTES.md`, `HANDOFF*.md`, the shared definition in `hooks/session-file.js`) are
  never keyed from their content: a log is appended to, so its first lines are its oldest entry.
  One lands in `ungrouped` unless its path carries a key, and {{OWNER}} says which commit
  takes it (usually the one whose work the new entry records). Found live when a work repo's
  `NOTES.md` was keyed to a ticket from eight days earlier.

## Steps

1. **Group.** Run the grouper, to a file, and read the file:
   ```
   node "C:\GIT\cli-agent-os\skills\commit-tickets\group.js" <repo> > <scratchpad>/commit-groups.json
   ```
   It reads `git status --porcelain=v1 -z` and prints JSON. It stages nothing and writes
   nothing; if `git status --short` differs before and after, stop and say so. If `changed` is
   0, say the tree is clean and stop.

2. **Show the table, then wait.** One row per group, plus the ungrouped rows, before any
   `git add`:

   | Key | Files | Proposed message |
   |---|---|---|
   | DATA-444 | `client-access/fourleaf/01_provision.sql`, `client-access/fourleaf/02_grants.sql` | `DATA-444: reader account for fourleaf` |
   | ungrouped | `ad-hoc/one_off.sql` | (not committed until a key is given) |

   The one-line subject after `<KEY>: ` is yours to write from the diff (`git diff -- <paths>`
   and `git diff --cached -- <paths>`); the grouper only proposes the body. A file whose row
   carries `alsoMatches` is called out under the table: which key won and why (the first
   folder-level key), so {{OWNER}} can move it. Ask for approval per group, or for all groups
   at once. **Ungrouped is never committed without the owner naming its key** (or saying to
   leave it). A row the owner moves to another key is committed with that key.

3. **Commit each approved group, one at a time.**
   ```
   git -C <repo> add -- <exactly the paths in that row>
   git -C <repo> diff --cached --name-only
   ```
   Compare the staged list with the row; any extra or missing path means reset (`git reset
   -q`) and stop. Then:
   ```
   git -C <repo> commit -m "<KEY>: <one line>" -m "<body>"
   git -C <repo> log --oneline -1
   ```
   Body: the environment folders touched (`dev`, `stg`, `prod` and the like, from the
   grouper's `environments`), the top-level folders, and the session's attribution trailer if
   the harness asks for one. Quote the `git log --oneline -1` line under the row. A deleted
   file in a group is staged with the same `git add -- <path>`; a rename is staged by its new
   path and its old one.

4. **Show what is left.** After the last commit:
   ```
   git -C <repo> status --short
   ```
   so anything left behind (ungrouped, unapproved) is visible. Then stop.

## Never

- `git add -A`, `git add .`, `git add -u`, `git add -f`, or a pathspec wider than the row.
- `git commit --amend`, `git push`, `git rebase`, `git stash`.
- A commit for `ungrouped` without a key from {{OWNER}}.
- Editing a file to give it a key. If a file should carry one, say so and let the owner decide.
- A message body that names a person, client or system the repo's own README would not.

## Output shape

Per committed group:
```
DATA-444  2 files  a1b2c3d DATA-444: reader account for fourleaf
```
Then the `git status --short` block, or `(clean)`.
