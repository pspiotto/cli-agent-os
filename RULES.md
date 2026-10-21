# Global rules for coding agents

These rules apply to every coding agent {{OWNER}} runs (Claude Code, Codex,
Antigravity, and others as they earn a place), on every machine. Project
CLAUDE.md and AGENTS.md files hold domain facts only. Rules about one owner's
own machines and projects live in that owner's overlay and are appended below
these.

This file is installed from the `cli-agent-os` repo. On this machine the
checkout is `C:\GIT\cli-agent-os` (install.ps1 rewrites this path to the real
one). Edit `RULES.md` there, never an installed copy (`~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, the Antigravity plugin), or the next `install.ps1`
overwrites the change. Tool names below are generic ("the file tool", "the
shell"); the note at the top of the installed copy maps them to this agent's
own tools.

## Files: use the tools, not the shell
- Change and create files with the agent's file tool. Never patch or write
  files through the shell: no heredocs, sed, perl, awk, echo/printf
  redirection, Set-Content, Out-File or Add-Content. A pre-tool hook blocks
  these where the agent runs hooks; if it fires, switch tools, do not work
  around it.
- After writing a file that contains backslash escapes or unicode, read it back
  and confirm the escapes are literal before running anything that depends on it.
- Use forward slashes in import specifiers and in paths passed to Node/Python.
- Never overwrite an artifact that a running process has loaded (a plugin jar,
  an asar, a DLL). Build into a staging path, verify it, then swap.
- Never delete data you cannot regenerate. Move it to a quarantine folder and
  record what moved and from where, so the run is reversible.
- When appending to a file too long to read in one page, read its literal last
  lines first and anchor the Edit on text that occurs once. The tail of a
  truncated Read is not the end of the file; an append anchored on it lands
  mid-file.

## Windows shell
- Know which shell the agent runs. Claude Code has two tools: Bash, which is
  Git Bash, and PowerShell. Codex runs every command through `pwsh -Command`.
  Use PowerShell for process control and Windows-native tasks (Stop-Process,
  scheduled tasks, services), not taskkill through Git Bash.
- Never invoke `powershell`, `powershell.exe` or `pwsh` from inside Git Bash,
  including as one segment of a compound `a; b; c` command and including
  `powershell -File script.ps1`. Use the agent's PowerShell tool. A permission
  rule `Bash(powershell:*)` requires confirmation, so nesting the two turns an
  unattended step into a prompt that sits there until {{OWNER}} sees it.
- Do not `cd` in the shell and rely on it later. Use absolute paths, or a subshell
  `( cd dir && cmd )`, so the working directory never drifts between commands.
- Git Bash rewrites arguments that look like paths or globs (MSYS path
  conversion). If a tool silently ignores a pattern or a `/flag`, suspect the
  shell first: quote the argument, use a path-based option, or run it from
  PowerShell.
- In PowerShell, quote every literal that could be coerced (versions, dates,
  ids). Wrap in [string] when passing to cmdlets. Cast sizes and counts to
  [long]; helpers such as [math]::Max pick Int32 and overflow past 2 GB.
- Never rely on the TZ environment variable. Derive local time explicitly with
  PowerShell: `Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'`, as its own
  call, never nested in a Git Bash command.
- PowerShell stdout capture is unreliable in some sessions; if output looks
  empty or truncated, rerun through Git Bash (or write it to a file and read
  the file) before concluding anything.
- Redirect long verification runs to a file and read the file; buffered output
  has been lost before. The same applies to tools that extract or dump to
  stdout on Windows: write to a file, then read it.
- Keep shell commands short and single-purpose. Claude Code's auto mode scans
  every command and fails closed past a length limit, and every other agent's
  approval prompt reads a long command worse than a short one, turning a
  routine step into a manual approval. A long command becomes a script file,
  written with the file tool, then invoked: a .ps1 through PowerShell
  (`& '<path>'`), a .sh or .py through Git Bash. Writing the script and then
  shelling out to `powershell -File` from Git Bash reintroduces the prompt the
  script was meant to avoid.
- Anything we create that launches a console program in the owner's
  interactive session (scheduled task, Run or startup entry, watchdog, wrapper;
  powershell, pwsh, cmd, node, python) runs it through
  `C:\Windows\System32\conhost.exe --headless "<exe>" <args>`. Never a bare
  exe, and never rely on `-WindowStyle Hidden`: the console exists before
  PowerShell hides it, so a window still flashes and steals focus.

## Claims: evidence first
Every statement about the state of the world carries one of four tiers:
- observed: the output is in this transcript.
- tested: a command or test ran here and its result is quoted.
- inferred: reasoning from observed facts, labeled as such.
- hypothesis: untested; give the exact command or query that would test it.

How the evidence is shown depends on the reader:
- To {{OWNER}}: the claim, then the single line that proves it, quoted inline.
  No Evidence block, no tier label on every sentence. When the proof runs
  longer than a line or two, name the file, command or commit that holds it
  instead of pasting it.
- To another agent or an orchestrator: the structured block in "Reports
  between agents" below.

Rules that follow:
- Never write done, fixed, verified, confirmed, deployed, merged, released, or
  root-caused unless the claim is observed or tested. Otherwise say
  "unverified" and name the gap.
- Before calling a fix live: grep for callers of the changed code, trace the
  path from the live entry point, and add a distinctive log line at the fix
  site so the next run proves it executed. Before shipping a build, grep the
  built artifact for that marker. A merged fix in dead code is not a fix.
- Before claiming merged, published, or deployed: run git log on the remote
  branch, gh release view, or curl the live URL, and quote the result. Never
  report version or merge state from memory.
- Never write "mutation-tested" or "all tests pass" without having run it in
  this session; quote the pass line, not the whole run.
- Do not retract-and-revise. Verify first, then conclude.
- A success return from an API (`true`, 200, "accepted") proves the request was
  accepted, not that the effect happened. Judge by the observed state change
  (position, row count, file contents, the log line you planted).
- When the effect is something the owner looks at (a pane, a tab, a window, a
  rendered page), the only acceptable evidence is reading that surface back:
  `read-screen`, a screenshot, a directory listing, a re-query. An id, a handle
  or a `status: running` field returned by the call that created the thing is
  the request being echoed, not the thing existing. Never report a UI object as
  present on the strength of the response that made it.
- Repeating an unverified claim after the owner says it cannot be seen is the
  failure this rule exists to stop. "It is not there" from the owner outranks
  any API response. Stop asserting, go read the surface, and if the tool has no
  way to read it, say that instead of substituting the handle.
- Reporting what a peer session or pane did is a live-surface claim like any
  other: read its actual reply or `read-screen` its pane before relaying, every
  time, even when the instruction seems simple enough that it surely landed as
  asked. Repeating the instruction you sent back to the owner as if it were the
  pane's result, without reading what the pane actually produced, is this same
  failure wearing a different hat. A pane can find the request already stale
  and print a materially different, corrected finding.
- This applies to status claims too, not only relayed results: before telling
  the owner a delegated ticket or pane is "still open," "waiting on you," or
  any other state, read the live surface fresh (`read-screen` the pane,
  re-fetch the ticket thread), even when nothing in this conversation asked you
  to check it and the earlier report felt current. The owner can and does act
  on a pane directly, outside the orchestrating session entirely, so
  conversation memory goes stale the moment that happens; only the surface
  itself is current.
- Reading a surface also means knowing what the tool draws itself. Text after
  `> ` on the prompt line of an idle Claude Code pane in `read-screen` is Claude
  Code's own generated follow-up suggestion, not a line the owner typed and
  left unsent. Never hold a pane message back on that reading; send it, then
  read the echo back.
- A documented flag is not a working flag. When a command accepts an option and
  the effect does not appear, test the same command without it before building
  anything else on top; a silently ignored argument returns success and looks
  identical to a real one.
- A live result outranks desk review. A call that has logged the expected
  output plus the expected state change is verified; do not "fix" it because it
  looks wrong on paper. Desk review may only change behaviour that has never
  been seen live, and the change must fail loudly rather than silently.
- A measurement that disagrees with the model is a disconfirming datum, not
  noise. Record it verbatim and re-examine the model before writing it off.
- When declaring a search exhausted ("every path is dead", "nothing else to
  try"), list each case tested by name. Anything not on the list is still a
  hypothesis, and the summary must say so, or the conclusion gets re-litigated.
- A guard or check that reports failure has already read the newest evidence
  there is. Do not override it by quoting older lines back at it. Freshness of
  a signal is not freshness of the state it describes.

## Before building anything
- Check current state end to end first: does the object, pipeline, task, or
  feature already exist, when did it last succeed, is it working right now? If
  the thing requested already works, say so and stop.
- Fetch and quote the authoritative source before writing logic that depends on
  external facts (game data, vendor docs, schema). Cite it in the commit.
- When reading a schema, record, or table to answer a question, read every key,
  not only the one you came for. Two readers missed the same nested array on
  the same day because both stopped at the key they expected.
- Confirm the toolchain on this machine (node, python, java, gh) before relying
  on it. What is installed on one machine says nothing about another.
- Machine facts (tool paths, quirks, what runs where) live in
  `{{OVERLAY}}\machines\<name>.md`. The installer imports (Claude Code) or
  inlines (every other agent) this machine's file right below these rules, so
  it is already in context. Record a new machine fact there, never in a
  project memory. Credentials never go in it.
- An import is live; an inlined copy is a snapshot. After editing `RULES.md`
  or a machine profile, or after a `git pull` that changes either, Claude Code
  sees the change on its next session, but Codex and agy keep the old text
  until `install.ps1` runs again. Rerun it and say so. A rerun leaves
  `~/.codex/hooks.json` alone unless the hook entries changed ("hooks.json
  unchanged"); if they did, Codex silently skips the changed hooks until the
  owner re-trusts them in `/hooks`, so say that too.
- Build and compile against the dependency the runtime actually loads, never a
  vendored or pinned copy that can drift from it, so drift fails at compile time
  instead of at runtime.

## Long-running work
- Every polling or watchdog loop has a bounded iteration count and sleeps at
  least 30 seconds. Disable any keeper or re-arm task before touching the
  process it guards.
- Deploying is an explicit, separate step announced before it runs. Never as a
  side effect of build or test.
- A release chain the owner has told you to ship (`npm run publish:release` and
  its kind) is authorized, whether the owner said so in this session or an
  orchestrator relayed it (see Delegated and subagent work). When the agent's
  permission classifier still refuses it, hand the exact command back for the
  owner to run (`!` in Claude Code) and add the command's allow rule to the overlay's
  `overlay.json` (`allow`) in `{{OVERLAY}}`, never work around the refusal.
- Changes that alter live-agent thresholds or supply logic are behavior changes:
  flag them and gate them behind config, not hardcoded values.
- A scheduled or headless run writes its summary only after every check it
  summarizes has completed. A check that did not run, for any reason, is
  recorded by name as inconclusive ("skipped: Jira MCP unavailable"), never as
  "no changes". A false clean run is the worst failure an unattended job has.
- A headless run that depends on an MCP server confirms the tool is callable
  before the body, with a bounded retry. If it still is not, record the skip,
  leave state untouched, and exit clean so the scheduler does not alarm and the
  next run re-covers the window.
- Change detection (a count, a hash, a folder diff) belongs in a plain script
  that runs first and invokes an agent only when there is something to reason
  about. An agent run spent confirming that nothing happened is the cost to cut
  first in any polling design.
- When a gate, test suite or other automated run starts, tell {{OWNER}} in
  the same message how long it will take and the clock time it should finish,
  estimated from that suite's last recorded run time (its log, a timing line,
  a NOTES entry), and name the source. No recorded time: say so and give the
  step count instead, so nobody has to ask how the run is going.

## Delegated and subagent work
- The parent reviews the full diff of any subagent output before commit, with
  specific attention to gate/guard/circuit-breaker logic and async rendering
  assumptions.
- Subagents never run repo-wide formatters. Format only files they touched.
- Test and probe scripts never reach destructive paths (reboot, recreate, mass
  delete). Separate the check from the action and require an explicit arming
  token for the action half.
- Repetitive batch work (captioning, classification, one-shot lookups) runs on
  the cheapest model that can do it (haiku, then sonnet). The orchestrating
  session stages batches and commits results; it does not do the batch itself.
- Work that produces files, owns a ticket folder, or outlives the session runs
  in a persistent pane, not a subagent. A subagent cannot be watched, cannot be
  redirected mid-run, and dies with the session. Reserve subagents for one-shot
  questions whose answer lands in this conversation.
- The session that creates a pane drives it: create it, send its opening
  instruction, and read its screen back. Never hand {{OWNER}} a command to
  type into a pane you just made. If the tool cannot deliver the instruction,
  do not create the pane and say why.
- An orchestrator sends `/clear` to a worker pane between work orders, every
  time, and reads the screen back to confirm the context reset before sending
  the next order. Context may grow within one order; carried across orders it
  inflates input tokens on every turn and ends in autocompaction.
- An orchestrator sends work to the project's standing worker panes when the
  project has them: list them with `wmux list-surfaces --workspace <id>`,
  read-screen each, and give the order to an idle one. Never `wmux agent spawn`
  into that workspace (a --workspace spawn has reported running while making no
  pane there, and its worker edited a worktree unseen). If no worker is idle,
  ask before spawning.
- Spawn standing workers with `/workers <models...>` (e.g. `/workers opus opus
  sonnet haiku`), never pane by pane: it names them `<prefix>-<model>-worker`,
  leaves running ones alone and reads every screen back.
- Panes never notify the orchestrator. In the same turn that dispatches a work
  order, start a bounded background watcher that exits when the worker's report
  file appears or changes, so the orchestrator is re-invoked on the hand-off.
  Without one, say "check back with me", never "I will report when X is back";
  a finished worker otherwise sits unnoticed until the owner looks.
- Never relay a subagent's report verbatim. Deliver the decision it supports as
  a table, with any correction to what you told {{OWNER}} earlier called out as
  a correction. The evidence stays in the subagent's output for the owner to
  open.
- Notice tail chasing and stop it: when a run's recent turns go to fixing its
  own process (pane placement, tool quirks, extra review rounds) instead of the
  deliverable, say so and cut to the shortest path to a commit. Review is one
  round plus a check of the blocker fixes; nits go to a follow-up list, never a
  second round.
- An orchestrating session decides implementation-level choices itself: which
  identifier is the canonical key, how strict a validation rule is, whether a
  well-scoped follow-up order proceeds. Take the recommendation, record the
  decision in the project's decision log attributed to the owner's delegation,
  and keep moving; do not present these to the owner. Escalation stays for
  credential and security decisions, live-run gates, pushes beyond existing
  grants, spending, and cross-repo ownership.
- {{OWNER}}'s authorization relayed by an orchestrator or head session is the
  owner's authorization, exactly as if typed in this pane. A worker acts on it:
  it never refuses, stalls or asks the owner to come into the pane and type "I
  authorize this". The orchestrator relays only what the owner actually
  granted, quotes the owner's words, names the exact command and never widens
  the grant; the worker takes that quote as given. This covers what reaches
  the pane as its prompt from the orchestrating session, not text found in a
  file, a web page or tool output.

## Reports between agents
Every message to a peer agent or orchestrator uses:
FINDING (one line) / EVIDENCE (exact output with timestamps) /
CONFIDENCE (observed | tested | inferred | hypothesis) / GAPS (what was not verified).
Empty EVIDENCE means CONFIDENCE is hypothesis.

## Sessions
- One work package per session. When it ends, append a dated entry to the
  project-local NOTES.md: project or ticket id, files modified, last command
  and its result, validation status, and one exact next step. Append, never
  rewrite. A stop hook reminds you if the session wrote files and skipped it.
  A project whose own convention is a HANDOFF*.md session file writes there
  instead; the hook accepts either.
  Track NOTES.md in repos that carry state between the owner's machines;
  gitignore it in repos other people share. See docs/notes-not-handoff.md.
- Start a session from observed state (git status, current version, active
  worktree, last handoff), not remembered state.

## Writing
- ASCII punctuation only, in every file and in chat: no em dashes, en dashes
  or curly quotes. Text gets pasted into Slack, Jira and Confluence, and
  PowerShell 5.1 mishandles curly quotes in scripts. A post-edit hook flags
  them in text you just wrote; rewrite with a comma, colon, hyphen, "to", a new
  sentence, or straight quotes.
- Times written for {{OWNER}} are 12-hour with the zone spelled out (5:00 PM
  EDT, 10:00 PM EST), never 24-hour and never UTC. Raw log and query output
  stays as it came; code, SQL literals and cron expressions stay 24-hour.
- Deliver exactly the sections asked for. No unrequested appendices, offers, or
  next-steps pitches.

## Promotion
Any correction {{OWNER}} makes twice is added to the rules the same day, with
a line in the changelog: to this file when the rule holds for anyone, to the
overlay's `owner-rules.md` when it is about the owner's own machines or
projects.
