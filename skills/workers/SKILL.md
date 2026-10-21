---
name: workers
description: Spawn standing Claude Code worker panes in wmux from one line. Invoke as /workers <model> [<model> ...] [--prefix ab] [--dry-run], e.g. /workers opus opus sonnet haiku. One worker per model, named <prefix>-<model>-worker (numbered when a model repeats), in the "<PREFIX> Workers" workspace, started in the current folder. Leaves workers that are already up alone, reuses idle shell panes, and reads every screen back.
---

# workers

One line instead of typing `claude --model ... -n ...` into each pane.

```
node "C:\GIT\cli-agent-os\skills\workers\workers.js" <models...> [--prefix ab] [--dry-run]
```

Run it from the Bash or PowerShell tool directly, from the project folder (the
workers start there, so they inherit this session's folder trust). Pass the
user's arguments through unchanged. If wmux is not running, say so and stop.

## What it does

- **Names**: `<prefix>-<model>-worker`, or `worker1`, `worker2` when a model is
  listed more than once (`/workers opus opus sonnet` gives `ab-opus-worker1`,
  `ab-opus-worker2`, `ab-sonnet-worker`). Each is started as
  `claude --model <m> -n <name>`, so the name shows in the pane's input box,
  and the tab gets the same title.
- **Prefix**: `--prefix`, else the prefix of an existing `<X> Workers`
  workspace whose panes sit in this folder, else the folder's initials
  (`web-app` gives `wa`).
- **Workspace** `<PREFIX> Workers`:
  - missing: created with one pane per worker in a grid (at most 8);
  - present: a worker whose name is already on screen is left alone, a missing
    one goes into an idle shell pane, and when none is left it is added as a
    tab. A pane running anything else is never touched.
- **Proof**: a worker counts as up only when its screen shows the ready prompt
  with its own name. The spawn's reply is not taken as proof.

## Report

Relay the script's lines: one `ready` or `FAILED` line per worker, with the
last screen lines under it. Exit 0 means all workers are up, 1 means one or more
failed or wmux is down, 2 means bad arguments. Use `--dry-run` to see the plan
without changing anything.

Tests: `node skills/workers/workers.test.js` from the repo root.
