---
name: promote
description: Promote a correction {{OWNER}} has made twice into the agent-os rules. Takes the correction in one line, reads the repo's RULES.md and the overlay's rules (never an installed copy such as ~/.claude/CLAUDE.md or ~/.codex/AGENTS.md), proposes the file, section and wording in the owner's voice, shows the diff, and only on approval writes the rule plus the CHANGELOG line. Never commits unless asked. Invoke as /promote <correction>; the model may also suggest it the second time the same correction lands.
---

# promote

The Promotion rule at the bottom of the global rules (RULES.md) says any correction {{OWNER}} makes twice is added to the rules the same day, with a line in the changelog. This skill is that rule as a command. It edits the source of truth, shows the change before writing it, and stops there.

## Inputs

- The correction, in one line, from the argument. If none was given, ask for it in one line and wait.
- The repo checkout: `C:\GIT\cli-agent-os` (install.ps1 rewrites this path to the real one when it copies this skill). General rules are written there.
- The overlay: `{{OVERLAY}}` (install.ps1 renders this to the overlay folder, or to the repo checkout when there is no overlay). Rules about the owner's own machines and projects go in its rules file (`owner-rules.md` unless its `overlay.json` names another) and its `CHANGELOG.md`; machine facts go in its `machines\<machine>.md`.
- Never edit an installed copy (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, the Antigravity plugin); the next install overwrites it.
- This machine's name, from `~/.claude/machine.txt`, used as the changelog's machine label. If the file is missing, ask which machine this is.

## Steps

1. **Read the current rules.** Read `C:\GIT\cli-agent-os\RULES.md` and the overlay's rules file in full and check whether the correction is already covered. If a rule already says it, quote that rule, say so, and stop: a duplicate is not a promotion.
2. **Pick the target file.** A rule of conduct that holds for anyone goes in the repo's `RULES.md` under the section whose heading it belongs to (Files, Windows shell, Claims, Before building anything, Long-running work, Delegated and subagent work, Reports between agents, Sessions, Writing). A rule that names the owner's own machines, projects, tickets or incidents goes in the overlay's rules file; a general rule can still go public with its dated incident in the overlay. A fact about this machine only (a tool path, a quirk of a program installed here, what runs where) goes in `{{OVERLAY}}\machines\<machine>.md` under its `## Quirks` or `## Tools & paths` heading instead, per the "Machine facts" rule in Before building anything. Say which file and heading you chose and why, in one sentence.
3. **Draft the rule** as one bullet in the owner's voice: imperative, concrete, the failure it prevents named in a parenthetical, ASCII punctuation only, no em dashes, no curly quotes, no hedging. A public rule names no person, project, ticket or host; it says "the owner". Two to four lines wrapped at the file's width. Model it on the bullets already under that heading.
4. **Draft the CHANGELOG line** in the changelog beside the file you chose (the repo's `CHANGELOG.md` for `RULES.md`, the overlay's for the overlay): `- <yyyy-mm-dd> | <machine label> | <what the rule says, one sentence, and the correction that caused it>` under the `## <yyyy-mm-dd>` heading for today (create the heading directly under the intro paragraph if today has none; newest first). A public changelog line names no person or project. Take today's date from `Get-Date -Format 'yyyy-MM-dd'` in the PowerShell tool, never from memory.
5. **Show the diff and wait.** Print both proposed insertions as a unified diff (file, heading, the exact lines) and ask for approval with a yes/no question. Write nothing before the answer. If the answer changes the wording, show the new diff and ask again.
6. **On approval, write.** Two Edit calls, anchored on the heading's last existing bullet (rule) and on the `## <date>` heading or the intro paragraph (changelog). Then run `LC_ALL=C grep -c '[^ -~]'` on both files and confirm `0`.
7. **Print the two-line summary** and stop:
   ```
   promoted : <file> / <heading> - <first six words of the rule>
   changelog: <the line as written>
   ```
   Do not commit, push or run install.ps1. Say that the rule reaches this machine's agents (`~/.claude/CLAUDE.md`, and the Codex and Antigravity copies where installed) on the next `install.ps1`, and the other machines after `git pull` plus `install.ps1` there.

## When the model suggests this

The second time the same correction lands in a session, offer `/promote <the correction in one line>` in one sentence at the end of the reply. Do not run it unasked, and never write a rule without the approval in step 5.
