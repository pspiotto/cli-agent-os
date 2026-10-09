---
name: glm-backend
description: Switch one project's Claude Code sessions to Z.ai's GLM-5.3 (Anthropic-compatible endpoint) or back to the normal Claude login. Edits only that project's .claude/settings.local.json, records what it replaced, and restores it on off. The key never goes in the project. Invoke as /glm-backend [on|off|status] [project path]. Only the user invokes this.
disable-model-invocation: true
---

# glm-backend

Point Claude Code at Z.ai's GLM models for one project, or put it back. Other
projects, and `~/.claude/settings.json`, are never touched.

## What "on" writes

Into `<project>/.claude/settings.local.json` (merged; every other key stays):

| Key | Value |
|---|---|
| `env.ANTHROPIC_BASE_URL` | `https://api.z.ai/api/anthropic` |
| `env.ANTHROPIC_MODEL` | `GLM-5.3` (outranks the global `"model": "opus[1m]"`) |
| `env.ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL` | `GLM-5.3` |
| `env.ANTHROPIC_DEFAULT_HAIKU_MODEL` | `GLM-5.3-Flash` (subagents and background tasks) |
| `env.API_TIMEOUT_MS` | `3000000` |
| `apiKeyHelper` | `node "<this folder>/zai-key.js"` |

Values come from Z.ai's Claude Code guide, `docs.z.ai/devpack/tool/claude`.
The replaced values go to `<project>/.claude/glm-backend.state.json`, which is
also the on/off marker.

## Bundle mode (`on --bundle`)

The Coding Plan endpoint above draws only plan quota (5-hour and weekly
windows, error 1308 when spent) and never a pay-as-you-go usage bundle or the
cash balance (`docs.z.ai/devpack/faq`). `on --bundle` instead sets
`ANTHROPIC_BASE_URL` to `http://127.0.0.1:4000` and every model tier to
`glm-5.3` (the bundle covers glm-5.3 only, so no Flash). A local LiteLLM proxy
there translates Anthropic Messages to Z.ai's OpenAI-style API:

- Plan first: every request goes to `api/coding/paas/v4`, the Coding Plan's
  quota (same pool as `api/anthropic`), which counts prompts, not tokens.
- Bundle as overflow: on a 429 from the plan, LiteLLM retries the request on
  `api/paas/v4`, which bills the bundle, then the cash balance. After a plan
  failure it skips the plan for 5 minutes, then tries it again.
- Which one served a request: the `x-litellm-model-group` response header
  (`glm-bundle` means overflow) and `x-litellm-attempted-fallbacks`.

The overflow bills tokens, and Claude Code resends its whole context every
request. Measured in one project, one trivial request: 58,232
prompt tokens as configured, 45,081 with the cloudflare, impeccable and
typesafe plugins off (`enabledPlugins` false in the project's settings), and
39,689 with no MCP servers either. The ~40k floor is Claude Code plus the
CLAUDE.md files. `/clear` between tasks while on overflow.

- Venv: `%LOCALAPPDATA%\agent-os\glm-proxy\venv` (`py -3.12 -m venv`, then
  `pip install "litellm[proxy]"`; 1.103.1 on the home server, 2026-09-30).
- Config: `proxy/litellm.yaml`. Launcher: `proxy/start-proxy.ps1`, log
  `%LOCALAPPDATA%\agent-os\glm-proxy\proxy.log`.
- Kept running by the `GLM-Bundle-Proxy` logon task
  (`proxy/register-proxy-task.ps1`). Start now:
  `Start-ScheduledTask -TaskName GLM-Bundle-Proxy`.
- To switch a project between modes, run `off` then `on` or `on --bundle`.

## The key

`zai-key.js` prints `ZAI_API_KEY` if set, otherwise the contents of
`~/.claude/secrets/zai-api-key.txt`. Neither is in this repo or in any project.
If the user has not set one up, tell them to create that file with the key as
its only content; do not write the key yourself from chat.

## Steps

1. Resolve the project: the path argument if given, otherwise the current
   working directory. Confirm it with the user if it is not obviously a project
   root (no `.git`, no `.claude`).

2. Run the script from the repo checkout. The path below is the one
   `install.ps1` recorded when it copied this skill; if that folder does not
   exist, ask the user where the checkout is:

   ```
   node "C:\GIT\cli-agent-os\skills\glm-backend\glm.js" <on|off|status> "<project>"
   ```

   With no verb, run `status`.

3. Show the user the script output verbatim, including every `note:` line.
   A note about a replaced or hand-edited value matters; do not summarize it
   away.

4. After `on` or `off`, tell the user:
   - The change applies to Claude Code sessions started in that project from
     now on. Restart any session already open there; do not claim the running
     session switched.
   - To confirm, run `/status` in a new session there: `Anthropic base URL`
     should show `https://api.z.ai/api/anthropic` when on and be absent when
     off.
   - While on, those sessions bill Z.ai per token or against the GLM Coding
     Plan, not the Claude subscription. Remote Control and voice dictation are
     unavailable, and claude.ai connectors are disabled.

## Notes

- Anthropic does not support routing Claude Code to non-Claude models. Features
  that depend on Anthropic-only API fields may fail. If requests fail with 400s
  naming unrecognized fields or betas, add
  `"CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"` to that project's `env` by
  hand. `off` leaves keys it did not set alone.
- A wrong or expired key does not fail fast. Claude Code retries the 401 up to
  11 times with backoff, so a headless run sits for minutes. Seen 2026-09-30.
  Test a new key with one direct request before a long run.
- To run GLM and Claude side by side on one repo, use one worktree per
  backend, never toggle one folder between launches: `docs/worktree-per-model.md`.
- `off` restores only values that still match what `on` wrote. A value edited by
  hand while on is left in place and reported.
- Do not use this on the database administration or data engineering machines
  unless the employer allows sending code to Z.ai.
- Tests: `node skills/glm-backend/glm.test.js` from the repo root.
