# Slice 4: MCP. AI agents can drive Setu and manage env without seeing secrets

Research: `02-env-research.md`, MCP section.

## What you get
`setu mcp` is a stdio MCP server, a thin shim over the daemon socket. Any MCP client connects to it, for example `claude mcp add --transport stdio setu -- setu mcp`. It has no port, no token and no network listener: the 0600 socket is the only access control.

**Tools**

| Group | Tools |
|---|---|
| Runs | `run_list`, `run_start {path \| run}`, `run_stop {run}`, `run_restart {run}`, `run_logs {run, proc?, lines? ≤ 500}`, `run_url {run}` |
| Env | `env_list {scope, target?}`, `env_effective {run}`, `env_set {scope, target?, name, value?, secret?}`, `env_unset`, `env_import {scope, target?, path, preview?}` |
| Disk | `disk_report`, `disk_clean {apply?}` |

How these tools treat secrets:
- **`env_set` for a secret** never needs the value from the agent. Without a value it returns `pending_user_input` and tells the agent to ask the user to run `setu env set NAME --secret`, which prompts without echo. The app will show a sheet later. If the agent passes a value anyway, it is stored and the reply carries no value.
- **There is no reveal tool.** The shim also refuses `env.reveal` at the socket boundary: requests are tagged with the actor `mcp`, and the daemon refuses reveal for that actor.
- **`run_logs` redacts every known secret value** before returning lines.
- **Every write is audited** with actor `mcp` and the client name from the MCP initialize handshake.

## Not in this slice
- An HTTP transport.
- MCP resources and prompts.

## Approach
- Use the `rmcp` crate, pinned. Its versions and feature names are checked against docs.rs before use. If its stdio server pulls in too much, a hand-written JSON-RPC over stdio for the few methods needed (initialize, tools/list, tools/call) is the fallback.
- The daemon gets an `actor` field on every socket request (default `cli`). Reveal is refused for `mcp`.

## Verification
- Drive the server with an MCP client script over stdio: initialize, tools/list, and call each tool against a sandbox project.
- Grep every response for the test secret's value. It must never appear.
- Connect a real client with `claude mcp add` in a scratch session if possible, and list runs.

## Verification results (2026-11-11)
- **Server.** `setu mcp` is a hand-rolled stdio JSON-RPC server: initialize, ping, tools/list and tools/call. rmcp would have pulled in about 92 crates. The release binary grew by 49.7 KB, to 1.42 MB.
- **Tools.** 13 tools. None can reveal a value.
- **End to end** (`crates/setu/e2e/mcp-e2e.sh`), re-run by the coordinator:
  - 19 MCP responses were checked, and the sandbox secret never appears.
  - `run_logs` shows `[redacted:API_TOKEN]`.
  - `env_set` without a value returns `pending_user_input`.
  - A raw `env.reveal` with actor `mcp` is refused.
  - The audit log records `actor:"mcp"` and `client:"e2e-client"`, and no values.
- **Run naming fix.** A worktree outside its project folder is now named after its own directory, not its full path.
- **Not done.** Connecting a real client with `claude mcp add` happens after install, so it uses the installed binary.
