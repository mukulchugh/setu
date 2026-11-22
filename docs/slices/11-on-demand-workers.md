# Slice 11: on-demand workers, and a crashed worker no longer blocks the run

## Problem
1. Every `[procs.*]` of a project starts with its run. For a stack with a Trigger worker (1 to 3 GB) and an Inngest dev server, both start with every dev server even when nobody is testing background jobs.
2. When such a worker exited at startup (code 1), the run stayed `starting` with the note "trigger exited (code 1)" and the proxy answered 503 for the run's domain, although the web proc was up on its port.

## Design
**`autostart` (bool, default true)** on a proc, in project configs and recipes.
- `start` spawns only autostart procs. Ports and env are allocated and injected as before, so `INNGEST_BASE_URL` and friends still point at the (not yet running) worker.
- A project can flip the flag on a recipe's proc without restating it: `[procs.trigger]` with only `autostart = false`. A proc with `run` replaces the recipe's proc whole, as before. A proc with no `run` and no recipe supplying it, or with other keys but no `run`, is a config error. The proc that owns the web port must autostart (config error otherwise), so readiness never waits on something that was not started.
- `setu start [run] <proc>` and `setu stop [run] <proc>` (socket cmds `proc.start`/`proc.stop`; MCP `run_proc_start`/`run_proc_stop`). Start needs the run to be `running` or `starting` ("start the run first" otherwise). Stop of the web proc is refused (stop the run). A stopped proc leaves the run up and is not reported as a crash. Both honour claims like `down`.
- `ls --json` gains `proc_states` (`running`, `starting`, `off`, `exited`, `stopped`); `setu ls` prints `off` and `exited` procs under the run; `logs <proc>` on an off proc that never ran says it is off.
- Run status is derived from the web port only, so off procs are never waited on. The idle sweep treats a run as dead only when it has autostart procs and none is alive (all-on-demand runs stay up).

**Bug 2, root cause.** `start` spawns the waiter that promotes `starting` to `running` once the web port opens. It guarded against a stale waiter by comparing the run's pid list captured at spawn with the list after the wait. `on_exit` removes an exited sidecar from that list, so a worker that died during the wait made the lists differ and the waiter returned without promoting the run. Fix: stale means a stop happened since (`gens` moved) or a pid exists that this start did not spawn; a list that merely shrank is fine. The crashed worker stays in the status note and `proc_states`, and the domain is served. Regression test: `a_worker_that_crashes_at_startup_does_not_block_the_web_proc` (fails on the old code with status `starting` and the exact note).

## Alternatives, ranked
1. **`autostart` flag (chosen).** One bool, same shape as supervisord's `autostart=false`; composes with recipes (flip one flag); the env stays wired.
2. **Compose-style profiles** (`profiles = ["jobs"]`, `setu up --profile jobs`). More expressive for groups, but needs a selection concept in every command, in run state and in the app. Not needed for "two workers off by default"; a flag can grow into it later.
3. **Separate project for the workers.** No core change, but a second run, domain and port set per worktree, and the web app's env cannot reference the worker's ports.

## Not done
- A restart or an on-demand browser start does not remember that a worker was started by hand; it is off again.
- The Swift app does not show `proc_states` yet.
