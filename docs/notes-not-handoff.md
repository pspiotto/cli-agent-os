# Why the session file is NOTES.md, not HANDOFF.md

This note exists so every machine, and the sessions that start on them, understand the convention rather than re-deriving it.

## What came first

An early version of the rules said: one work package per session, and when it ends, write `HANDOFF.md` with what shipped, what is unverified, and what the next session should do first. `HANDOFF.md` was a snapshot, overwritten each session.

## What already existed

On one machine, every project and every ticket folder had long carried a `NOTES.md`: an append-only journal, one dated entry per session with the project or ticket id, the files modified, the last command and its result, the validation status, and one exact next step. It became a standing instruction after a `/resume` from the wrong directory cost a full session; a file in the working folder works from any shell. A Stop hook enforced it: a session that wrote files but never touched a `NOTES.md` is reminded before it can end. Tooling read it too: ticket-folder conventions treated a `NOTES.md` append as the signal that a ticket moved phase, and folder watches and hand-off skills drew on it.

So there were two conventions for the same job: `HANDOFF.md` with a few days of history in one repo and no enforcement, and `NOTES.md` with months of habit, a hook, and consumers.

## The decision

`NOTES.md` is the convention. `HANDOFF.md` is retired as a general session file (a project whose own convention is a `HANDOFF*.md` file may keep it; the hook accepts either).

- The Sessions rule says: append a dated entry to the project-local `NOTES.md`, with the fields above and one exact next step.
- The Stop hook lives in this repo as `hooks/notes-stop.js`, so the backstop reaches every machine through `install.ps1`.

## Why NOTES.md and not HANDOFF.md

The two files answered the same question for the same reader: the next session. Everything wanted from `HANDOFF.md` fits in the newest `NOTES.md` entry, and one extra property comes free: append-only keeps the history of what was unverified and when, where a snapshot overwrites it. Against that, `HANDOFF.md` had nothing but recency. When two conventions compete, the one with the habit, the enforcement and the consumers wins.

## Where the file lives, and whether git tracks it

In the working folder of the project or ticket. Whether git tracks it depends on who else reads the repo:

- In a repo that other people share (a product repo, or this public one), `NOTES.md` is personal. Add it to `.gitignore`.
- In a repo that exists to carry state between the owner's own machines or sessions (a private overlay, say), the notes are the point. Track them.

This repo ignores `NOTES.md`.

## What a NOTES.md entry looks like

```
## 2026-09-10 (Thu) ~3:20 PM EDT - <machine> - <one-line purpose>

Project: <name or ticket id; say "no ticket" explicitly if none>.
Files modified: <paths>.
Last command and result: <command> -> <quoted result line>.
Validation status: <what passed, what was not run>.
Exact next step: <one action, not a menu>.
```

Times are 12-hour with the zone, dates absolute. Append below the previous entry; never rewrite old ones.
