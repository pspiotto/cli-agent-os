---
name: disable-global-rules
description: Turn the agent-os global layer off for this machine, for every agent (empties the global rules block, removes the guard hooks and the shared skills). Runs uninstall.ps1 from the agent-os checkout. Only the user invokes this.
disable-model-invocation: true
---

# disable-global-rules

Turn the agent-os user-level layer off for this machine, for every agent. Machine-local text
in `~/.claude/CLAUDE.md`, every other hook in `~/.claude/settings.json`, and
the two toggle skills stay in place.

1. Run the uninstaller from the repo checkout. The path below is the one
   `install.ps1` recorded when it copied this skill; if that folder does not
   exist, ask the user where the checkout is:

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GIT\cli-agent-os\uninstall.ps1"
   ```

2. Show the user the `Summary` lines from the output verbatim.

3. Tell the user: new Claude Code sessions start without the global rules and
   without the shell-edit guard. The current session keeps whatever it loaded
   at start. To turn the layer back on, run `/enable-global-rules`.

Do not edit `~/.claude/CLAUDE.md` or `~/.claude/settings.json` by hand as part
of this skill. The uninstall script owns those changes and backs the files up
before touching them.
