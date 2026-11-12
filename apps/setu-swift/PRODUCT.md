# Setu.app: product context
*(Inferred from the owner's brief, 2026-11-11. The interview was skipped at the owner's request. Correct anything wrong here.)*

## Who and where
- One developer who runs many git worktrees of several projects at once, often driven by AI coding agents.
- Disk and RAM are tight on a 32 GB Mac. They glance at the menu bar dozens of times a day, and open the window only to fix something: a crashed run, env, disk.
- Light and dark both matter: follow the system.

## Jobs, in priority order
1. **"Is my stuff up, and where is it?"** See every run, its URL and its RAM at a glance. Open it in one click.
2. **"Start, stop or restart this one."** One action, no terminal.
3. **"Why did it break?"** Logs for a run, one click away, with secrets already hidden.
4. **"Set this env var for everything, this project, or just this worktree."** Secrets are typed hidden and never shown by default.
5. **"Give me my disk back."** See what is big and safe to delete, then free it in one click.
6. **"Is Setu itself healthy?"** Run doctor, and see the exact fix.

## Product principles
- **Glanceable first.** The menu bar answers job 1 without opening anything.
- **Plain words.** Running, Starting, Stopped, Crashed. No internal terms like "lease", "proc" or "layer" in the UI.
- **Every empty state teaches the next action,** with a button that does it.
- **Destructive actions say exactly what they delete and how much,** and nothing else asks for confirmation.
- **Secrets are never visible by default.** Reveal is deliberate and copies to the clipboard with an auto-clear.
- **Native means native.** Standard macOS controls, behaviour and keyboard shortcuts. No invented widgets.
