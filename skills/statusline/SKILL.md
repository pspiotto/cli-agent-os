---
name: statusline
description: Turn claude-os status line segments on or off (tokens, cost, context, rate limits, worktree, directory, agent, session name, vim mode, output style). Writes ~/.claude/banner/statusline.json. Only the user invokes this.
disable-model-invocation: true
---

# statusline

Choose which segments the claude-os status line prints on this machine. The
segments are rendered by `~/.claude/banner/claude-os-statusline.js`; this skill
only edits the config file it reads, `~/.claude/banner/statusline.json`.

The `agent-os on` / `agent-os OFF` canary is not in the table and cannot be
turned off. A status line that can hide whether the global layer is loaded is
worth nothing, which is the whole reason the canary exists.

## Arguments

| Invocation | What it does |
|---|---|
| `/statusline` | Report the current state: which segments are on, and where the config lives. Change nothing. |
| `/statusline <segment> on` | Turn one segment on. |
| `/statusline <segment> off` | Turn one segment off. |
| `/statusline <segment> <segment> off` | Several at once; the last word is the verb. |
| `/statusline all on` | Every segment in the table on. |
| `/statusline all off` | Every segment off, leaving the canary line alone. |
| `/statusline reset` | Back to the shipped defaults in the table below. |

## Segments

| Name | Default | What it prints |
|---|---|---|
| `sha` | on | Checkout version as commit count and date (`r115 Sep 30`): green when level with origin/main, red when origin/main is ahead. Fetches in the background at most every 30 minutes. The key keeps its old name. |
| `model` | on | Model display name and the Claude Code version. |
| `glm` | on | Only when the model is GLM (`/glm-backend on`): `GLM off-peak 1x peak in 5h12m (2 AM)` or red `GLM PEAK 3x ends 1h20m (6 AM)`. Z.ai peak is Mon-Fri 14:00-18:00 UTC+8; times shown are local. |
| `context` | on | `ctx:17% used 83% left/200.0k`. |
| `tokens` | on | `tokens: in:15.3k out:2.4k`. |
| `cost` | on | Session cost in dollars. |
| `limits` | on | The 5 hour and 7 day rate limits with reset countdowns. |
| `worktree` | off | Worktree name, branch and the branch it came from. |
| `dir` | off | Current directory name. |
| `agent` | off | Running agent name and type, when one is running. |
| `session` | off | Session name, when set with `/rename`. |
| `vim` | off | `[NORMAL]` or `[INSERT]`, when vim mode is on. |
| `style` | off | Output style, when it is not `default`. |

A segment that is on still prints nothing when the session JSON has no value
for it, so `agent`, `session`, `vim` and `style` cost nothing on a session that
does not use them.

## Steps

1. Read `~/.claude/banner/statusline.json`. If it is missing, the status line
   is running on the defaults in the table above; build the object from those.
   If the file exists but does not parse, say so and treat it as the defaults,
   because that is what the status line itself is doing.

2. With no arguments, report the current state and stop. Do not write the file.

3. Otherwise apply the change and write the whole file back with the Write
   tool, keeping this shape and every key in the table, so the next run has a
   complete file to read:

   ```json
   {
     "segments": {
       "sha": true,
       "vim": false,
       "agent": false,
       "session": false,
       "model": true,
       "glm": true,
       "style": false,
       "worktree": false,
       "dir": false,
       "context": true,
       "tokens": true,
       "cost": true,
       "limits": true
     },
     "width": 0
   }
   ```

   `width` is the column count to wrap at. Leave it `0`, which means the script
   decides: the terminal width when it can read one, 80 otherwise. Set it only
   if the user asks for a specific width.

4. Reject an unknown segment name by listing the valid ones. Never invent a
   key: the script only honours the thirteen names in the table and ignores the
   rest.

5. Tell the user the change is live on the next status line render, in this
   session and every other one. Nothing needs restarting and no installer needs
   to run, because the script reads this file on every render.

## Notes

- If `~/.claude/banner/` does not exist, the banner and status line are not
  installed on this machine. Say so and point at
  `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GIT\cli-agent-os\banner\install-banner.ps1"`,
  rather than creating the folder here.
- `install-banner.ps1` seeds this file once with the defaults and never
  overwrites it afterwards, so choices made here survive a `git pull` and a
  reinstall.
- The config is per machine and deliberately not in the repo. The defaults are,
  in `DEFAULTS` in `banner/claude-os-statusline.js` and `$defaultSegments` in
  `banner/install-banner.ps1`.
