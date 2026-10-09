---
name: enable-global-rules
description: Turn the agent-os global layer on for this machine (global rules, guard hooks and shared skills for Claude Code and every other installed agent). Runs install.ps1 from the agent-os checkout. Only the user invokes this.
disable-model-invocation: true
---

# enable-global-rules

Turn the agent-os user-level layer back on for this machine, for every agent
it installs for (Claude Code always; Codex and Antigravity when present).

1. Run the installer from the repo checkout. The path below is the one
   `install.ps1` recorded when it copied this skill; if that folder does not
   exist, ask the user where the checkout is:

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GIT\cli-agent-os\install.ps1"
   ```

2. Show the user the `Summary` lines from the output verbatim.

3. Tell the user: new Claude Code sessions load the global rules and the
   shell-edit guard. The current session keeps whatever it loaded at start, so
   start a new session to work under the layer.

Do not edit `~/.claude/CLAUDE.md` or `~/.claude/settings.json` by hand as part
of this skill. The install script owns those changes and backs the files up
before touching them.
