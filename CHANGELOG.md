# Changelog

One line per promoted rule or behavior change: `- <date> | <machine> | <what changed>`.
Newest first. No person, project, host or employer names; those belong in the
owner's overlay changelog.

## 2026-10-09

- 2026-10-09 | home server | RULES.md Long-running work: when a gate, test suite or other automated run starts, state its expected duration and finish time from the suite's last recorded run time, with the source.
- 2026-10-09 | home server | First public release. Rules, hooks, skills and installers split from a private repo; everything personal moved to an overlay (`install.ps1 -Overlay`), with `{{OWNER}}` and `{{OVERLAY}}` placeholders rendered at install time.
