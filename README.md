# cli-agent-os

A user-level layer for coding agents on Windows: one set of global rules,
guard hooks and shared skills, installed for Claude Code, Codex CLI and
Google's Antigravity CLI (`agy`) from one repo, plus any agent that reads the
shared `~/.agents/skills` folder (DeepCode, Gemini CLI, Copilot CLI, Cursor,
OpenCode).

Everything personal (your name, your machines, your projects, your own extra
rules and permission rules) lives in a separate private **overlay** folder, so
this repo stays generic and the overlay stays yours. See "Overlay" below.

## Agents

One canonical rules file, `RULES.md`, is rendered per agent with a short
preamble from `targets/<agent>.preamble.md` that maps the rules' generic nouns ("the
file tool", "the shell") onto that agent's own tools.

| Agent | Rules | Machine profile | Hooks | Skills | Pre-approved commands |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` block | `@import` | `~/.claude/settings.json` | `~/.claude/skills` | `settings.json` `permissions.allow` |
| Codex CLI | `~/.codex/AGENTS.md` block | inlined | `~/.codex/hooks.json`, same entries plus `commandWindows`; trust once with `/hooks` | `~/.agents/skills` | none (Codex has no per-command allowlist) |
| Antigravity (`agy`) | plugin `~/.gemini/config/plugins/agent-os/rules/AGENTS.md` | `rules/machine-profile.md` | plugin `hooks.json` through `hooks/agy-hook.js` | plugin `skills/` | `permissions.allow` in `~/.gemini/antigravity-cli/settings.json` |
| DeepCode, Gemini, Copilot, Cursor, OpenCode | | | | `~/.agents/skills` | |

**Inlined copies go stale.** Claude Code `@import`s the machine profile, so
an edit reaches its next session. Codex and agy get the rules and the profile
copied in at install time, so after any edit to either, or a pull that brings
one, rerun `install.ps1` or those two keep the old text. The rerun is safe for
Codex hook trust: it prints `codex : hooks.json unchanged` unless the hook
entries themselves changed, and only then does Codex need `/hooks` re-trusted
(it skips untrusted hooks without a warning).

The hooks are written once, against Claude Code's protocol. Codex speaks the
same protocol (it reports its shell as `Bash` and its `apply_patch` edits
through the `Edit|Write` matcher), so the same entries work there;
`hooks/transcript.js` reads both transcript formats for the Stop hooks.
Antigravity's protocol differs (camelCase, JSON decisions), and
`hooks/agy-hook.js` translates it.

## Purpose

Running agents across several machines, the same handful of lessons came back
on every one of them: use the file tools instead of shell heredocs, put
evidence before any claim of "done", handle Windows shell quirks, use hooks and
skills. A rule that surfaces on every machine is a rule about how you and your
agents work, not about a project. Kept in per-project CLAUDE.md files that
never see each other, every lesson gets re-learned per project.

This repo holds that user-level layer (the rules, the hooks, `skills/`,
`agents/`) and is cloned to every machine. Project CLAUDE.md and AGENTS.md
files keep only domain facts.

What it enforces mechanically:

1. **No file edits through the shell.** `hooks/no-shell-edits.js` is a
   PreToolUse hook on the shell tool. It blocks heredocs redirected into
   files, `sed -i`, `perl -i`, `echo`/`printf` redirected into source or
   config files, and the PowerShell forms Codex and agy produce
   (`Set-Content`, `Add-Content`, a literal piped to `Out-File`, a here-string
   redirected into a file, `[IO.File]::Write*`, `New-Item -Value`), and tells
   the model to use its file tool instead.
2. **Claims do not outrun evidence.** `RULES.md` states the four claim tiers
   (observed, tested, inferred, hypothesis) and the words that need evidence
   before they may be written; `hooks/claims-stop.js` holds a session that
   ends on a bare claim once.
3. **ASCII punctuation only.** `hooks/no-em-dash.js` (the name is historical)
   is a PostToolUse hook on Write and Edit. It scans only the text the model
   just wrote, never the whole file, for em dashes, en dashes and curly
   quotes in every file type, and for their escaped forms (an HTML entity, a
   backslash-u sequence written as text) in prose and copy files only, so
   code that names the character by escape is left alone. It reports back to
   the model so it rewrites the line; it never blocks the write.
4. **Every working session ends with a NOTES.md entry.** `hooks/notes-stop.js`
   is a Stop hook. If the session used Edit, Write or NotebookEdit and none
   of those touched a `NOTES.md` (or a `HANDOFF*.md`, for a project that keeps
   its session file under that name), the stop is held once with a reminder.
   Read-only sessions end quietly, and so does any session started with
   `CLAUDE_OS_SKIP_NOTES_HOOK=1` in its environment (headless runners set it;
   the reminder would only cost them an extra model turn).
   A session whose turns end to wait on background work (an orchestrator with
   worker panes and a watcher) gets the reminder on every such turn, since a
   Stop hook cannot tell a turn end from a session end. Two ways to keep it
   quiet: write the NOTES.md opening entry first, which silences the hook for
   the rest of that session; or create an empty file `.claude/skip-notes-hook`
   in the session's working directory (each worker pane's worktree needs its
   own), which silences it until the file is removed. Remove it when the run
   ends, or the closing entry never gets asked for. Prefer the first route in
   an auto-mode session: a session that created the marker with the Write tool
   has had its next Bash command refused by the auto-mode classifier as
   "[Self-Modification]" (anything written under a project's `.claude/` reads
   as a config change to it). Creating the file by hand, or the opening
   NOTES.md entry, does not trip it.
   `docs/notes-not-handoff.md` explains why NOTES.md and not HANDOFF.md.
5. **A compaction does not lose the charter.** `hooks/compact-recharter.js` is a
   SessionStart hook with matcher `compact`, so it fires only when a session
   resumes after its context was compacted. SessionStart is one of the few
   events whose plain-text stdout is added to the model's context, so what it
   prints is what the compacted session reads first. It names the charter files
   registered for that directory and orders a re-read before the next action
   that changes state. It exists because the global and project `CLAUDE.md` are
   re-injected after a compaction but a charter they only POINT at is not: the
   pointer survives and the rules do not. A rule written inside such a charter
   cannot enforce itself, because the session must already open the file to
   meet the rule telling it to open the file. Register a charter in the
   overlay's `overlay.json` (`charters`); the installer writes them to
   `~/.claude/hooks/charters.json`. A directory with nothing registered gets
   no output, so the hook costs nothing in projects that do not need it.

## What is in the repo

| Path | What it is |
|---|---|
| `RULES.md` | The global rules, agent-neutral. Installed into `~/.claude/CLAUDE.md` between `<!-- claude-os:start -->` and `<!-- claude-os:end -->` (the marker keeps the project's earlier name; the banner and status line accept both), into `~/.codex/AGENTS.md` between `<!-- agent-os:start -->` and `<!-- agent-os:end -->`, and into the agy plugin. `{{OWNER}}` and `{{OVERLAY}}` in it are filled in by the installer. |
| `targets/` | Per-agent pieces: `<agent>.preamble.md` preambles (not `<agent>.md`: on Windows `claude.md` is a nested `CLAUDE.md`), `codex.config.toml` (top-level keys added to `~/.codex/config.toml` when absent: `CLAUDE.md` as a fallback project file, and a 128 KiB project-doc cap), `agy.permissions.json`. |
| `lib/common.ps1` | Helpers dot-sourced by both installers, so install and uninstall transform files the same way. Also the overlay layout. |
| `settings.json` | User-level hooks and the generic permission allow rules. Its `hooks` key and its `permissions.allow` list are merged into `~/.claude/settings.json`. |
| `hooks/no-shell-edits.js` | The shell-edit guard. Needs Node on PATH. |
| `hooks/no-em-dash.js` | The ASCII-punctuation check on written text. Needs Node on PATH. |
| `hooks/notes-stop.js` | The NOTES.md reminder at session end. Needs Node on PATH. |
| `hooks/claims-stop.js` | Holds a session that ends on a bare claim of done, fixed, verified and the rest. |
| `hooks/compact-recharter.js` | The post-compaction charter re-read order, from `charters.json` beside it. Needs Node on PATH. |
| `hooks/agy-hook.js` | Runs the Claude-protocol hooks under Antigravity (see its header for the contract as probed). |
| `hooks/transcript.js` | Reads Claude Code, Codex and Antigravity transcripts for the two Stop hooks. |
| `skills/enable-global-rules`, `skills/disable-global-rules` | The on/off switch. `/disable-global-rules` runs `uninstall.ps1`; `/enable-global-rules` runs `install.ps1`. |
| `skills/statusline` | `/statusline <segment> on\|off` picks which status line segments print on this machine, by writing `~/.claude/banner/statusline.json`. The `agent-os on`/`OFF` canary is not among them and cannot be turned off. |
| `skills/adhd-ste` | `/adhd-ste` turns on ADHD output shaping plus ASD-STE100 Simplified Technical English for the rest of the session: next action first, numbered steps, state restated every turn, short active-voice sentences, and the same shape applied to Jira summaries, descriptions and comments. Model invocation is disabled, so only the slash command starts it; "normal mode" stops it. |
| `skills/promote` | `/promote <correction>` turns a correction made twice into a rule: reads the repo's RULES.md and the overlay's rules, picks the file and section (public rule, overlay rule, or machine profile), shows the diff, and on approval writes the rule plus the changelog line. Never commits. Model invocation stays on so it can be suggested the second time a correction lands. |
| `skills/entropy-sweep` | `/entropy-sweep [repo]` runs `scan.js` (seven read-only checks: unreferenced docs, docs older than their code, `Last verified` lines, orphaned worktrees, dead agent defs, divergent duplicates, unreachable-code candidates) and renders `docs/entropy-<date>.md` with `report.js`, then triages every finding as `verify`, `decide: <owner>` or `remove` (a proposal). The sweep reports only. Approved `remove` paths go through the separate armed step, `quarantine.js <repo> <paths-file> --confirm QUARANTINE-<today>` (dry without the token): it moves files to `<repo-parent>/quarantine/<repo>-<date>/` with a manifest and stages the removal; it never deletes or commits. |
| `skills/verify-docs` | `/verify-docs <repo>` takes the sweep's most-loaded docs, has read-only Sonnet readers check each against the code, re-checks every reported drift itself, and on approval stamps `Last verified: <date> (<machine>) - checked against <paths>` plus `Wrong now:` under the H1 via `stamp.js` (dry by default, `--write` arms it). Never edits prose, never commits. |
| `skills/commit-tickets` | `/commit-tickets [repo]` commits uncommitted work one ticket key at a time. `group.js` (read-only, no dependencies) assigns every changed or untracked path to the key in its path (first folder-level key wins, and the JSON says when two matched), else the key in its first lines, else `ungrouped`; session logs (`NOTES.md`, `HANDOFF*.md`) are never keyed from content; a `<KEY>-<yyyymmdd>` tail is a date stamp, never a key; a repo overrides the key pattern with `.commit-tickets.json`. The skill shows one proposed commit per key as a table, waits for approval per group, stages exactly those paths, commits `<KEY>: <one line>` with the environment folders in the body, and quotes each `git log --oneline -1`. Ungrouped is never committed without the owner assigning a key. Never `git add -A`, never amend, never push. `group.test.js` covers the cases. |
| `skills/glm-backend` | `/glm-backend [on\|off\|status] [project]` points one project's Claude Code sessions at Z.ai's GLM-5.3 through its Anthropic-compatible endpoint, or back. `glm.js` merges the base URL, model mapping and an `apiKeyHelper` into that project's `.claude/settings.local.json` and records every replaced value in `.claude/glm-backend.state.json`, so `off` restores the file exactly (values edited by hand while on are left and reported). `zai-key.js` supplies the key from `ZAI_API_KEY` or `~/.claude/secrets/zai-api-key.txt`, so the key never lands in a project. Takes effect in new sessions. `on --bundle` points the project at a local LiteLLM proxy (`proxy/`, 127.0.0.1:4000, kept up by a logon task that `proxy/register-proxy-task.ps1` registers) that uses Coding Plan quota first and falls back to a pay-as-you-go usage bundle when the plan returns 429. `glm.test.js` covers the cases. |
| `skills/verify-sql` | `/verify-sql <package> [checklist]` is the adversarial review of a Snowflake script package, by default rather than on request. `static.js` (read-only, no dependencies) applies one class-level pattern per static entry of the repo's failure checklist (unqualified names, single-quoted bodies, `COMMENT ON COLUMN` against a view the package creates, `CREATE OR REPLACE` on a policy, `CREATE MANAGED ACCOUNT IF NOT EXISTS`, a replace without `COPY GRANTS` on a granted object with no re-grant, `IF` without parentheses) and prints JSON; a repo adds its own patterns in `.verify-sql.json`. The skill probes Cortex `AI_COMPLETE` through the connector, reads the newest scratch-schema harness record for the package and stops if there is none, spawns one read-only Opus adversary (`adversary-prompt.md`, one round), sends the same brief through `AI_COMPLETE` (`cortex-prompt.js` builds the dollar-quoted SELECT), re-checks every finding at its file and line, and writes a verdict table per checklist entry. Never edits the package, never runs the harness, never commits. `static.test.js` covers the patterns. |
| `skills/workers` | `/workers <model> [<model> ...] [--prefix ab] [--dry-run]` starts standing Claude Code worker panes in wmux, one per model, named `<prefix>-<model>-worker`, in the `<PREFIX> Workers` workspace. Leaves running workers alone, reuses idle shell panes, never touches a pane running anything else, and counts a worker as up only when its screen shows the ready prompt with its own name. Claude Code only. `workers.test.js` covers the pure parts. |
| `agents/` | Shared agents. Empty for now. |
| `machines/_template.md` | The shape of a machine profile. Real profiles live in the overlay's `machines/`. |
| `banner/` | Opt-in startup banner and status line. `banner/install-banner.ps1` adds a `claude` wrapper to both PowerShell profiles and a `statusLine` to settings, chaining any status line the machine already had; `banner/uninstall-banner.ps1` removes both and restores the chained one. `banner/claude-os-statusline.js` renders the whole line in one Node process: the canary, then the segments `/statusline` turns on. The art is `banner/art.txt`, or the overlay's `banner/art.txt`. `banner/install-banner.test.ps1` covers the round trip and the segment config. Not touched by `install.ps1`. `banner/README.md` is a standalone guide. |
| `install.ps1` | Installs the layer for Claude Code (always), the shared `~/.agents/skills`, and Codex and agy when their home folders exist (`-Agents codex,agy` forces them). Installs the Claude plugins listed in its `$plugins` table. Idempotent. |
| `uninstall.ps1` | Reverses the install for every agent without touching anything the layer did not add. Idempotent. |
| `install.test.ps1` | Round-trips install and uninstall against a scratch home folder, all three agents and an overlay. |
| `CHANGELOG.md` | One line per promoted rule: date, machine, rule. |
| `docs/` | Decision notes (`notes-not-handoff.md`). |

## Install

Requires Windows, git, Node (`node --version` from Git Bash must work) and
PowerShell 5.1 or 7.

```powershell
git clone https://github.com/<you>/cli-agent-os.git C:\GIT\cli-agent-os
cd C:\GIT\cli-agent-os
.\install.ps1 -Machine <machine-name> -Overlay C:\GIT\<your-overlay>
```

Both options are needed once per machine. The machine name is saved to
`~/.claude/machine.txt` and the overlay path to `~/.claude/overlay.txt`; later
runs reuse them. `-Overlay none` forgets the overlay. Without an overlay the
layer still installs, and the rules say "the user" wherever they name the
owner.

Codex needs one manual step after the first install and after any hook change:
open `codex`, run `/hooks`, and trust the agent-os entries. Codex skips
untrusted hooks without a warning.

When a profile `machines/<name>.md` exists (in the overlay first, then in this
repo), the installer writes an `@import` of it right after the claude-os end
marker, between `<!-- claude-os-machine:start -->` and
`<!-- claude-os-machine:end -->`, so every session on that machine loads its
own profile without a tool call. Without a name, or with a name that has no
profile, the installer says so in its summary and imports nothing.

`C:\GIT\cli-agent-os` is the convention, not a requirement. The repo text
names itself by that path, and `install.ps1` rewrites every copy of it in the
rules and in the skills' `.md` files to the folder it actually runs from, so
a clone anywhere works and the toggle skills still find `install.ps1` and
`uninstall.ps1`.

`install.ps1` never clobbers what is already there:

- `~/.claude/CLAUDE.md` gets the rules between `<!-- claude-os:start -->`
  and `<!-- claude-os:end -->`. If that marker pair is already in the file,
  only the block is replaced and every line outside it is kept, so
  machine-local rules can live anywhere outside the block. A file with no
  markers is treated as a first install: it is backed up to
  `CLAUDE.md.bak-<timestamp>` and replaced, and two kinds of block survive
  the replace and are re-appended after the rules: a hand-written
  machine-local block between `<!-- local:start -->` and `<!-- local:end -->`
  (for content that belongs to one machine only, such as a hand-written
  `@import` of a local file), and the auto-managed wmux block between
  `<!-- wmux:start -->` and `<!-- wmux:end -->`. Anything else outside those
  markers is dropped on that first pass, which is why the first install on a
  machine starts by reading the old file. Once the claude-os markers exist,
  the `local` wrapper is no longer needed; it is still honoured.
- `~/.claude/settings.json` is backed up, then only the `hooks` key and the
  `permissions.allow` list are merged. Hook entries and allow rules already
  present are skipped, rules the machine added on its own are kept, and
  `model`, plugins and every other key are preserved as they were. The allow
  rules pre-approve commands the auto-mode classifier keeps refusing on the
  owner's say-so; in this repo that is a release publish (`npm run
  publish:release`). Your own go in the overlay.
- `hooks/`, `skills/`, `agents/` are copied over. Local extras are never
  deleted.
- Plugins listed in the `$plugins` table at the top of `install.ps1` are
  installed through `claude plugin marketplace add` and `claude plugin install`
  when `enabledPlugins` in `~/.claude/settings.json` does not already have
  them. Currently: `i-have-adhd@i-have-adhd` (ADHD-friendly output shaping;
  `/i-have-adhd` in a session, or create `~/.claude/.i-have-adhd-always` to
  make it always-on). `-SkipPlugins` skips the step.

On the first install on a machine, read the backup first and move anything
unique from the old `~/.claude/CLAUDE.md` into the overlay's rules file (or,
if it holds for anyone, into `RULES.md`), and then install. Rules only survive
if they live in one of the two.

New sessions pick up the layer. A session that is already running may or may
not; start a new session to be sure.

## Overlay

The overlay is a private folder, usually its own private git repo, holding
everything about one owner. Every part is optional:

```
<overlay>/
  overlay.json        { "owner": "Sam",
                        "rules": "owner-rules.md",
                        "allow": ["Bash(npx wrangler deploy:*)"],
                        "charters": [ { "exact": ["C:/work"], "under": ["C:/work/steward"],
                                        "files": ["C:/work/steward/CLAUDE.md"],
                                        "note": "Steward charter." } ] }
  owner-rules.md      appended after RULES.md, for every agent
  machines/<name>.md  machine profiles (start from machines/_template.md here)
  skills/<name>/      your own skills; a name this repo already has is skipped
  banner/art.txt      your own banner art
```

- `owner` replaces `{{OWNER}}` in the rules, preambles and skills. Without it
  the text reads "the user".
- `{{OVERLAY}}` renders to the overlay folder, so the rules point agents at
  your machine profiles and your rules file.
- `allow` rules are merged into `~/.claude/settings.json` beside the repo's
  and removed by `uninstall.ps1`.
- `charters` become `~/.claude/hooks/charters.json` for `compact-recharter.js`.

Keep project names, ticket ids, hostnames, employers and incident dates in the
overlay, never in this repo.

## Update

```powershell
cd C:\GIT\cli-agent-os
git pull
.\install.ps1
```

## Turning the layer off and on

The layer is a switch, not a commitment. If the global rules get in the way on
a machine, turn them off there without losing anything local:

```
/disable-global-rules      # in a Claude Code session, or:  .\uninstall.ps1
/enable-global-rules       # in a Claude Code session, or:  .\install.ps1
```

For Codex and agy it removes the agent-os block from `~/.codex/AGENTS.md`, the
repo's entries from `~/.codex/hooks.json`, the `config.toml` keys still holding
the installed value, the generated agy plugin folder and the agy permission
rules; for every agent, the shared skill copies. For Claude Code,
`uninstall.ps1` empties the claude-os block in `~/.claude/CLAUDE.md` but
leaves the marker pair, drops the machine profile import (the saved name in
`machine.txt` and the overlay path in `overlay.txt` stay, so the next install
restores them), removes the repo's and the overlay's hook entries and allow
rules from `~/.claude/settings.json`, and deletes the copied hook and skill
files that still match what was installed. Text outside the markers, every
other hook (wmux, local ones), every other settings key, the plugins, and the
two toggle skills stay. Both files are backed up first. The empty marker pair
is what tells the next `install.ps1` to keep the local text instead of
replacing the file.

The switch is coarse. If only one rule chafes, the better fix is to trim that
rule, or to move it below the end marker on that machine so it becomes
machine-local. If the whole layer stays off on a machine for long, the rules
need revisiting.

Both scripts affect new sessions. A running session keeps what it loaded at
start.

## The promote habit

Any correction you make twice goes into the rules the same day:

1. A rule that holds for anyone goes in `RULES.md` under the section it
   belongs to (files, shell, claims, before building, long-running work,
   delegation, reports, sessions, writing), with one line in `CHANGELOG.md`.
   A rule about your own machines or projects goes in the overlay's rules file.
2. Commit, push, and run `.\install.ps1` on each machine at its next pull.

`/promote` does steps 1 and the diff for you.

## The entropy loop: sweep, then verify, then quarantine

1. `/entropy-sweep <repo>`: scans, writes `docs/entropy-<date>.md`, and
   triages every finding as `verify:`, `decide: <owner>` or `remove:`.
2. `/verify-docs <repo>`: works the `verify:` queue and writes the
   `Last verified` stamps. It reuses the same-day scan from the scratchpad,
   so it does not rescan.
3. Answer the `decide:` lines, then run `quarantine.js` for the approved
   `remove:` paths (dry first, then `--confirm QUARANTINE-<today>`).

`/verify-docs` on its own still works (step 1 of the skill runs the scanner
itself), but then the docs stamped are whatever ranked top-N, not a list
anyone triaged. Sweep first.

## Testing

From the repo root:

```bash
for t in hooks/*.test.js skills/*/*.test.js; do node "$t" | tail -1; done
```

```powershell
.\install.test.ps1
.\banner\install-banner.test.ps1
```

`install.test.ps1` points `USERPROFILE` at a scratch folder and walks the
toggle round trip: fresh install, reinstall with local text and wmux content
present, uninstall, reinstall, a legacy file with no markers, a double
uninstall, the machine profile, the Codex and agy targets (with user text and
user-set config values that must survive), the shared skills, and an overlay.
It exits 1 on any failed check and never touches the real `~/.claude`. Run it
under both `pwsh` and `powershell.exe`.

### Testing the guard

The suite feeds each case to the hook the way Claude Code does and checks the
exit code (2 = blocked, 0 = allowed): the plain heredoc forms, the
redirect-before-heredoc shape (`cat > f <<'EOF'`), stderr redirects that must
stay allowed, and the sed, perl, echo and printf forms.

The cases live in a script on purpose. A shell command whose text contains
`sed -i` or an echo-into-file trips the installed guard itself, so a one-liner
test that pastes those strings into Bash cannot run once the hook is live.

To exercise it end to end, in a fresh session:

```bash
claude -p "Create hooktest.txt containing the word hello using a bash heredoc. Do not use the Write tool." --allowedTools Bash
ls hooktest.txt    # expect: no such file, and the block message in the output above
```

## License

Apache License 2.0, see `LICENSE`. Redistributions must keep the `NOTICE`
file, which carries the attribution.
