# Changelog

One line per promoted rule or behavior change: `- <date> | <machine> | <what changed>`.
Newest first. No person, project, host or employer names; those belong in the
owner's overlay changelog.

## 2026-10-21

- 2026-10-21 | home server | The shell-edit guard now covers Claude Code's PowerShell tool: a second PreToolUse entry in `settings.json` with matcher `PowerShell`. Until now only the Bash tool reached `no-shell-edits.js`, so a `Set-Content` through the PowerShell tool was never checked. Codex's `hooks.json` leaves the entry out (Codex reports its shell as Bash), so no re-trust is needed. Also: a `|` with no space on either side no longer counts as a PowerShell pipe, so `grep -E "a|Set-Content"` is no longer blocked. `no-shell-edits.test.js` 48/48; `install.test.ps1` 155 passed, 0 failed (4 new asserts failed before the `settings.json` entry).
- 2026-10-21 | home server | `install.ps1` and `uninstall.ps1` compare permission rules case-sensitively (`-ccontains`). PowerShell's `-contains` ignores case, so an overlay that allowed both `C:/git/...` and `C:/GIT/...` got only the first one installed. `install.test.ps1`: 154 passed, 0 failed.
- 2026-10-21 | home server | Ported from the overlay's engine copies made after the first release: `scan.js --out <file>` (refuses a path inside the scanned repo; entropy-sweep and verify-docs use it instead of a `>` redirect); the `/workers` skill (Claude Code only); RULES.md bullets for the `> ` prompt-line suggestion, orchestrator-decided implementation choices and relayed owner authorization, plus the release-chain bullet now accepts a relayed grant; `autoMode.allow` in `settings.json` (`$defaults` plus the relay sentence), merged by `install.ps1` and removed by `uninstall.ps1` with `$defaults` kept. `install.test.ps1`: 152 passed, 0 failed.

## 2026-10-09

- 2026-10-09 | home server | RULES.md Long-running work: when a gate, test suite or other automated run starts, state its expected duration and finish time from the suite's last recorded run time, with the source.
- 2026-10-09 | home server | First public release. Rules, hooks, skills and installers split from a private repo; everything personal moved to an overlay (`install.ps1 -Overlay`), with `{{OWNER}}` and `{{OVERLAY}}` placeholders rendered at install time.
