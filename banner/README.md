# ASCII art when Claude Code starts

A short guide for adding a banner that prints every time you launch Claude
Code. Nothing here depends on the rest of this repo; copy what you need.

What you get, in the terminal, right before Claude Code's own welcome box:

```
+========================================================================+
|                     ___ ___ ___ ___ _____ _____ ___                    |
|                    / __| _ \_ _/ _ \_   _|_   _/ _ \                   |
|      .-=====-.     \__ \  _/| | (_) || |   | || (_) |                  |
|     /#########\    |___/_| |___\___/ |_|   |_| \___/                   |
|    |#.--. .--.#|      _   ___ ___ _  _ _____ ___ ___                   |
|    |#|  | |  |#|     /_\ / __| __| \| |_   _|_ _/ __|                  |
|    |#'--'v'--'#|    / _ \ (_ | _|| .' | | |  | | (__                   |
|     \#########/    /_/ \_\___|___|_|\_| |_| |___\___|                  |
|      |_|_|_|_|      ___ _  _  ___ ___ _  _ ___ ___ ___ ___ _  _  ___   |
|                    | __| \| |/ __|_ _| \| | __| __| _ \_ _| \| |/ __|  |
|                    | _|| .' | (_ || || .' | _|| _||   /| || .' | (_ |  |
|                    |___|_|\_|\___|___|_|\_|___|___|_|_\___|_|\_|\___|  |
+========================================================================+
|     S P I O T T O   -   A G E N T I C   -   E N G I N E E R I N G      |
+========================================================================+
```

## How it works

Claude Code has no banner setting, and a `SessionStart` hook will not do it:
whatever a SessionStart hook prints goes into Claude's context, not onto your
screen. The trick is a shell function named `claude` that prints the art and
then runs the real `claude` executable with whatever arguments you typed. The
function lives in your shell profile, so it loads with every new terminal.

## Step 1: make the art

- Generate the letters at https://patorjk.com/software/taag or with `figlet`.
  The banner above is the figlet `small` font.
- Stick to plain ASCII. Block characters and box-drawing glyphs look better but
  turn into question marks in any console that is not in UTF-8, and Windows
  PowerShell 5.1 is not by default.
- Avoid backticks. Several figlet fonts use one in the letter N. If you ever
  paste the art into a chat prompt, markdown treats two backticks as an inline
  code span and mangles the lines between them. Swap them for an apostrophe.
- Keep every row the same width. Check with:

  ```bash
  awk '{ print length($0) }' banner.txt | sort -u
  ```

  One number back means every row matches.

## Step 2: save it

Put the finished art in a text file. This guide assumes:

```
Windows:      %USERPROFILE%\.claude\banner\banner.txt
macOS/Linux:  ~/.claude/banner/banner.txt
```

## Step 3: add the wrapper to your shell profile

### Windows PowerShell

Add this to your profile. Note the two profile files below; read the gotcha
first.

```powershell
# claude-banner:start
function claude {
    $art = Join-Path $env:USERPROFILE '.claude\banner\banner.txt'
    if ((Test-Path -LiteralPath $art) -and ($env:CLAUDE_NO_BANNER -ne '1')) {
        Write-Host ''
        Get-Content -LiteralPath $art | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
        Write-Host ''
    }
    $exe = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) { Write-Error 'claude.exe not found on PATH'; return }
    & $exe.Source @args
}
# claude-banner:end
```

`Get-Command claude -CommandType Application` finds the real executable even
though the function now shadows the name. `@args` passes everything through,
so `claude --resume`, `claude -p "..."` and the rest keep working.

**The gotcha: PowerShell has two profiles.** PowerShell 7 (`pwsh.exe`) reads

```
Documents\PowerShell\Microsoft.PowerShell_profile.ps1
```

and Windows PowerShell 5.1 (`powershell.exe`) reads

```
Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1
```

Each host loads only its own file. If the banner shows in one terminal and not
another, this is why. Windows Terminal usually runs pwsh 7; many tools that
spawn a shell for you (wmux, some IDE terminals, scheduled tasks) run 5.1.
Put the block in both files. `$PROFILE` in a running shell tells you which one
that shell uses; the folder may not exist yet, create it.

### macOS and Linux (bash or zsh)

Add to `~/.bashrc` or `~/.zshrc`:

```bash
# claude-banner:start
claude() {
    if [ -f "$HOME/.claude/banner/banner.txt" ] && [ "$CLAUDE_NO_BANNER" != "1" ]; then
        echo
        cat "$HOME/.claude/banner/banner.txt"
        echo
    fi
    command claude "$@"
}
# claude-banner:end
```

`command claude` bypasses the function and runs the real binary.

## Step 4: try it

Open a new terminal window (the current one has not re-read the profile) and
run `claude`. The art prints, then Claude Code starts as usual.

To skip the banner for one shell session:

```
PowerShell:  $env:CLAUDE_NO_BANNER = '1'
bash/zsh:    export CLAUDE_NO_BANNER=1
```

## Step 5: the status line, and keeping the one you have

The banner prints once at launch. Claude Code's status line (`statusLine` in
`~/.claude/settings.json`) is the always-visible strip at the bottom, and
`claude-os-statusline.js` next to this file writes it. Its first segment is a
canary: green `agent-os on` when the block between the markers in the
installed `CLAUDE.md` holds rules, red `agent-os OFF` when it is empty or the
markers are gone. That segment is not configurable, since a status line that
can hide whether the layer is loaded is worth nothing.

Next is the checkout's version, `r<commit count> <date>`: green when it is
level with origin/main, red when origin/main is ahead and a pull is waiting.
The count is cached in `banner\version-cache.json` and git only runs when HEAD
or origin/main moves; a background `git fetch` (through `conhost --headless`)
runs at most every 30 minutes, stamped in `banner\last-fetch.txt`. It
describes the checkout, not what `install.ps1` last installed.

Everything after it is read from the session JSON Claude Code pipes in: model
and version, context use, token counts, cost, both
rate limits with reset countdowns, and (off by default) worktree, directory,
agent, session name, vim mode and output style. Which ones print comes from
`banner\statusline.json`, written by the `/statusline` skill. That file is
seeded once at install and never overwritten, so the choices survive a pull.

There is only one `statusLine` key, so a machine that already has a status line
of its own would have to give it up. It does not: `install-banner.ps1` records
the command that was there in `banner\chain.txt` and points the key here, and
this script runs the recorded command with the same stdin JSON and prints its
output on the lines underneath. Its own segments stay off in that case, so the
two never print the same numbers twice.

```
[#] agent-os on | r115 Sep 30
Opus 5 2.1.267 | ctx:8% used 92% left/200.0k | tokens: in:15.3k out:2.4k
$1.23 | 5h:12% ↺ 4h39m
```

`uninstall-banner.ps1` reads `chain.txt` back and restores the command to
`settings.json`. A chain that is missing, broken or slow prints nothing and the
canary line stands alone, so the worst case is losing the extra lines, never the
status line itself. The same goes for the config: a missing or malformed
`statusline.json` falls back to the default segment set rather than to nothing.

Rolling your own: anything that reads session JSON on stdin and writes a line to
stdout works, in any language. Keep it fast, it runs on every render, and make
it exit 0 no matter what it is handed.

`statusline-command.sh` next to this file is where those segments came from: a
shell pipeline with `jq` doing the JSON parsing, chained on the home server
from 2026-09-10 to 2026-09-13. It is kept for reference and is no longer
installed or chained by anything.

**It was replaced because a shell pipeline cannot run everywhere.** It spawns
about 28 subprocesses, so its cost is set by how expensive process creation is
on the machine. On the home server that was 1.3s per render. On the DBA machine
(corporate Windows 11 laptop, real-time scanning) the same script took 6 to 9
seconds warm against 0.213s for the canary alone, which blew through the
5-second chain cap on every render: the canary printed, the chain timed out, and
that machine was stuck with a one-segment status line. Porting the segments into
`claude-os-statusline.js` made the whole line one Node process with no `jq`,
which is what let every machine have it. Measured on the home server, same
input:

```bash
time (bash ~/.claude/statusline-command.sh < banner/sample-session.json > /dev/null)   # 1.299s
time (node ~/.claude/banner/claude-os-statusline.js < banner/sample-session.json > /dev/null)   # 0.074s
```

`sample-session.json` next to this file is the fixture both of those read, and
the one `install-banner.test.ps1` feeds the script when it checks that the
segment config is honoured.

`install-banner.ps1` rewrites the `C:\GIT\cli-agent-os` literal in the two scripts
it copies to whatever checkout it runs from, the same way `install.ps1` does for
its `.md` files. Both the banner and the canary read the repo's `.git` for the
version (`r<commit count> <date>`, red when origin/main is ahead), so without
that rewrite a clone at another path silently shows no version at all. The
banner line reads `agent-os loaded @ r116 Oct 01  |  <launch time>`. The art
(`art.txt`, or the overlay's `banner\art.txt` when the overlay saved in
`~/.claude/overlay.txt` has one) is copied byte-for-byte and never rewritten.

## Removing it

Delete the block between the `claude-banner:start` and `claude-banner:end`
comments from each profile file you edited, and delete the banner folder. Open
a new terminal and `claude` is the plain executable again.

## Ideas

- Print a line under the art with the date, the machine name, or the short SHA
  of a repo you care about. Anything the shell can compute cheaply.
- Make the banner conditional on something being true, so its absence tells
  you something. The version in this repo only draws the box when a marker
  line exists in `~/.claude/CLAUDE.md`, and prints one red line when it does
  not.
- Claude Code's status line (`statusLine` in `~/.claude/settings.json`) is a
  separate, always-visible spot for a one-line version. See step 5 above and
  `claude-os-statusline.js` next to this file.
