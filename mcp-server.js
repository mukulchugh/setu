// mcp-server.js — Setu as an MCP server (the reverse of mcp.js, which
// connects Setu TO other people's MCP servers). Mounted at /mcp inside
// portal.js's existing Bun.serve() fetch handler via
// WebStandardStreamableHTTPServerTransport, verified directly against the
// installed @modelcontextprotocol/sdk source (not context7/docs — same
// discipline mcp.js's own header comment documents, this time for the
// server-side API): McpServer lives at 'server/mcp.js', not the './server'
// barrel (which only re-exports the deprecated low-level Server class).
//
// Every tool here calls straight into portal.js's own functions, wired up
// via initMcpServer() (called once from portal.js, after those functions
// are defined) rather than self-fetching http://localhost:PORTAL_PORT/api/...
// on the same Bun.serve() instance. That HTTP-loopback design was the
// original v1 shape — modeled on the Raycast extension's "third front door"
// pattern (AGENTS.md). A second HTTP round-trip through the same
// single-threaded server was never load-bearing, only convenient, so it's
// gone: direct calls have no loopback socket, no second pass through the
// event loop, no double-timeout stack.
//
// NOTE, since this looks like a hang fix and isn't one: live E2E testing hung
// the whole portal three times (unresponsive to every route, not just the
// slow one). The self-fetch above was the first suspect but is NOT the
// cause — a hang reproduced again after this file stopped self-fetching
// entirely, including once via plain `POST /api/remove` with zero MCP code
// involved. The real cause (see the plan file's "Post-implementation
// finding" section) is synchronous execFileSync/spawnSync calls elsewhere
// (lib.js's git()/activePid()/listActivePorts()/killGroup()) that can
// stall Bun's single JS thread long enough to look like a full hang under
// concurrent load — the same failure class portal.js's fetchPR already hit
// once (see its own "ponytail" comment) and fixed by going async. Not fixed
// here; a pre-existing risk in create_worktree/remove_worktree/
// start_worktree/stop_worktree, not something this file introduces.
//
// Stateless mode throughout (no sessionIdGenerator): a fresh McpServer +
// transport per request, required by the SDK itself (handleRequest throws
// "Stateless transport cannot be reused across requests" otherwise, matches
// the SDK's own shipped Hono example's fresh-instance-per-request pattern).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import z from 'zod/v4';
import { PORTAL_PORT } from './lib.js';
import { WRITER_AGENT_NAME } from './writer-claims.js';

// Populated by portal.js's initMcpServer() call, once, at startup — after
// the functions it references are defined (safe regardless of call order
// since they're all hoisted function declarations, but this runs last).
let deps = null;

export function initMcpServer(d) {
  deps = d;
}

// Preserve recovery fields for both returned refusals and thrown state errors.
// The SDK's default exception response contains only the error message.
async function mutationResult(call) {
  let result;
  try {
    result = await call();
  } catch (error) {
    result = { error: error?.message ?? String(error), ok: false };
    for (const key of [
      'code',
      'causeCode',
      'committed',
      'reconciled',
      'phase',
      'operationId',
    ]) {
      if (error?.[key] !== undefined) {
        result[key] = error[key];
      }
    }
  }
  return {
    ...text(result),
    isError: result?.ok === false,
    ...(result && typeof result === 'object' && !Array.isArray(result)
      ? { structuredContent: result }
      : {}),
  };
}

// ── response shaping ────────────────────────────────────────────────────────
// The two tools whose backing data is UI-sized, not LLM-sized — shaped
// here, not in portal.js, so portal.js's own functions stay exactly what
// every other caller (web UI, Raycast) already expects.

// getWorktrees() returns ~25 UI-oriented fields per worktree (deploy
// status, memMb, ahead/behind, etc.) and returns the full unpaginated list
// (confirmed: /api/worktrees/archived's own comment notes pagination is a
// client-side-only concern for this API). An agent asking "what worktrees
// exist" needs a small fraction of that.
function compactWorktree(w) {
  return {
    active: w.active,
    ahead: w.ahead,
    behind: w.behind,
    branch: w.branch,
    container: w.container,
    dirty: w.dirty,
    domain: w.domain,
    label: w.label,
    lifecycleError: w.lifecycleError,
    name: w.name,
    operation: w.operation,
    phase: w.phase,
    port: w.port,
    pr: w.pr
      ? {
          checks: w.pr.checks,
          number: w.pr.number,
          state: w.pr.state,
          url: w.pr.url,
        }
      : null,
    queued: w.queued,
    queuePosition: w.queuePosition,
    repo: w.repo,
    starting: w.starting,
    stopping: w.stopping,
  };
}

// computeDiff's hunks are UI-bounded (300 files, 2000 lines/file, one JSON
// object per changed line — see portal.js's own DIFF_MAX_FILES/
// DIFF_FILE_LINE_CAP), not LLM-bounded. Default to stats + filenames only;
// full hunks are opt-in via `verbose`, still capped well below the UI's own
// ceiling since a tool result isn't virtualized the way the web UI's list is.
const DIFF_VERBOSE_FILE_CAP = 20;
const DIFF_TEXT_BUDGET = 200 * 1024;
const DIFF_TRUNCATION_MARKER = 'Output truncated at 200 KB.';

function shapeDiffGroup(group, verbose) {
  if (!group) {
    return group;
  }
  const base = {
    additions: group.additions,
    deletions: group.deletions,
    totalFiles: group.totalFiles,
  };
  if (!verbose) {
    return {
      ...base,
      files: group.files.map((f) => ({
        additions: f.additions,
        binary: !!f.binary,
        deletions: f.deletions,
        file: f.file,
      })),
      ...(Array.isArray(group.untracked) ? { untracked: group.untracked } : {}),
    };
  }
  const shown = group.files.slice(0, DIFF_VERBOSE_FILE_CAP);
  return {
    ...base,
    files: shown,
    ...(Array.isArray(group.untracked) ? { untracked: group.untracked } : {}),
    truncatedFileCount:
      Math.max(0, group.files.length - shown.length) +
      (group.truncatedFileCount ?? 0),
  };
}

function boundedDiffText(value) {
  const output = structuredClone(value);
  const render = () => JSON.stringify(output, null, 2);
  let rendered = render();
  if (Buffer.byteLength(rendered) <= DIFF_TEXT_BUDGET) return text(output);
  output.truncation = DIFF_TRUNCATION_MARKER;
  while (Buffer.byteLength((rendered = render())) > DIFF_TEXT_BUDGET) {
    const group = ['committed', 'uncommitted'].find(
      (key) => output[key]?.files?.length
    );
    if (group) {
      output[group].files.pop();
      continue;
    }
    const untracked = output.uncommitted?.untracked;
    if (untracked?.length) {
      untracked.pop();
      continue;
    }
    return text({ truncation: DIFF_TRUNCATION_MARKER });
  }
  return text(output);
}

function text(value) {
  return {
    content: [
      {
        text:
          typeof value === 'string' ? value : JSON.stringify(value, null, 2),
        type: 'text',
      },
    ],
  };
}

// ── tool registration ───────────────────────────────────────────────────────

function registerTools(server) {
  server.registerTool(
    'claim_worktree',
    {
      description:
        'Claim the writer slot before editing a worktree. Repeat with the same session to refresh its heartbeat. A different session can take over only after two hours without a heartbeat and the owner PID has exited.',
      inputSchema: {
        repo: z.string(),
        name: z.string(),
        agent: z.string().regex(WRITER_AGENT_NAME),
        session: z.string().min(1).max(200),
        task: z.string().min(1).max(300),
        pid: z
          .number()
          .int()
          .positive()
          .describe('long-lived local agent process ID, not the portal PID'),
      },
      title: 'Claim worktree writer slot',
    },
    ({ repo, name, ...owner }) =>
      mutationResult(() => deps.claimWriter(repo, name, owner))
  );

  server.registerTool(
    'release_worktree',
    {
      description:
        'Release a worktree writer claim at the end of the task. Only the session holding it can release it.',
      inputSchema: {
        repo: z.string(),
        name: z.string(),
        session: z.string().min(1).max(200),
      },
      title: 'Release worktree writer slot',
    },
    ({ repo, name, session }) =>
      mutationResult(() => deps.releaseWriter(repo, name, session))
  );

  server.registerTool(
    'list_claims',
    {
      annotations: { readOnlyHint: true },
      description:
        'List active writer claims across known worktrees, including agent, session, task, owner PID, heartbeat, and starting git baseline. Stale claims are reported by setu doctor.',
      inputSchema: {},
      title: 'List writer claims',
    },
    async () => text(await deps.listWriterClaims())
  );

  server.registerTool(
    'list_worktrees',
    {
      annotations: { readOnlyHint: true },
      description:
        'List every registered Setu worktree with its branch, port, running state, uncommitted-change count, and PR summary.',
      inputSchema: {},
      title: 'List worktrees',
    },
    async () => {
      const worktrees = await deps.getWorktrees();
      return text(worktrees.map(compactWorktree));
    }
  );

  server.registerTool(
    'create_worktree',
    {
      description:
        "Create a new Setu worktree for a branch (forks from the repo's base branch if the branch doesn't exist yet). Does not start the dev server.",
      inputSchema: {
        name: z.string().describe('branch name'),
        repo: z.string().describe('registered project name, e.g. "quivly-app"'),
        tunnel: z
          .boolean()
          .optional()
          .describe(
            'enable the shared public tunnel for this worktree on creation'
          ),
      },
      title: 'Create worktree',
    },
    ({ repo, name, tunnel }) =>
      mutationResult(() => deps.createWorktree(repo, name, !!tunnel))
  );

  server.registerTool(
    'start_worktree',
    {
      description:
        "Start a worktree's dev server. Omit `container` to use the sticky per-worktree default; pass true/false to force container or bare mode.",
      inputSchema: {
        container: z
          .boolean()
          .optional()
          .describe(
            'force container (true) or bare (false) mode; omit for the sticky default'
          ),
        name: z.string(),
        repo: z.string(),
      },
      title: 'Start dev server',
    },
    ({ repo, name, container }) =>
      mutationResult(() => deps.startWorktree(repo, name, container))
  );

  server.registerTool(
    'stop_worktree',
    {
      annotations: { destructiveHint: true },
      description:
        "Stop a worktree's dev server (or dequeue it if still waiting for a concurrency slot). Also stops its sidecars.",
      inputSchema: { name: z.string(), repo: z.string() },
      title: 'Stop dev server',
    },
    ({ repo, name }) => mutationResult(() => deps.stopWorktree(repo, name))
  );

  server.registerTool(
    'sync_worktree',
    {
      description:
        "Merge the worktree's resolved base branch (staging, or the repo's default) into it. Clean merges only: a would-be conflict is attempted, detected, and aborted (worktree left unchanged), never left mid-conflict -- resolving a real conflict is still the caller's job. Fails if the worktree has uncommitted changes.",
      inputSchema: { name: z.string(), repo: z.string() },
      title: 'Sync worktree with base branch',
    },
    ({ repo, name }) => mutationResult(() => deps.syncWorktree(repo, name))
  );

  server.registerTool(
    'remove_worktree',
    {
      annotations: { destructiveHint: true },
      description:
        "Stop the dev server and permanently remove a worktree's directory, port, and domain. Dirty worktrees are refused unless force is explicitly approved. The git branch is kept. Container node_modules volumes are removed. If cleanup is pending, retry with the returned operationId; this resumes that operation only.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe(
            'Permanently discard uncommitted and untracked files; only with explicit user approval'
          ),
        name: z.string(),
        operationId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Exact pending removal to resume; never starts a new removal'
          ),
        reason: z
          .enum(['manual', 'merged'])
          .optional()
          .describe('defaults to "manual"'),
        repo: z.string(),
      },
      title: 'Remove worktree',
    },
    async ({ repo, name, reason, force, operationId }) => {
      let result;
      try {
        result = await deps.removeWorktree(
          repo,
          name,
          reason ?? 'manual',
          force ?? false,
          operationId
        );
        if (!result || typeof result.ok !== 'boolean') {
          result = {
            code: 'REMOVAL_OUTCOME_UNKNOWN',
            error:
              'Removal outcome was not confirmed. Read status before retrying.',
            ok: false,
            removed: null,
          };
        }
      } catch (error) {
        result = {
          code: error?.code ?? 'REMOVAL_OUTCOME_UNKNOWN',
          error: error?.message ?? String(error),
          ok: false,
          removed: error?.removed ?? null,
        };
        for (const key of [
          'operationId',
          'pendingSteps',
          'completed',
          'completedStages',
          'causeCode',
          'committed',
          'reconciled',
          'phase',
        ]) {
          if (error?.[key] !== undefined) {
            result[key] = error[key];
          }
        }
      }
      return {
        ...text(result),
        isError: !result.ok,
        structuredContent: result,
      };
    }
  );

  server.registerTool(
    'get_diff',
    {
      annotations: { readOnlyHint: true },
      description:
        "Diff a worktree's branch against its base and its uncommitted changes. Defaults to stats + filenames only; pass verbose:true for actual hunks (capped to the first 20 files).",
      inputSchema: {
        name: z.string(),
        repo: z.string(),
        verbose: z
          .boolean()
          .optional()
          .describe(
            'include full line-by-line hunks, default false (stats + filenames only)'
          ),
      },
      title: 'Get worktree diff',
    },
    async ({ repo, name, verbose }) => {
      const diff = await deps.computeDiff(repo, name);
      return boundedDiffText({
        base: diff.base,
        baseResolved: diff.baseResolved,
        committed: shapeDiffGroup(diff.committed, !!verbose),
        uncommitted: shapeDiffGroup(diff.uncommitted, !!verbose),
      });
    }
  );

  server.registerTool(
    'get_logs',
    {
      annotations: { readOnlyHint: true },
      description:
        "Tail a worktree's log file (dev server by default; also tunnel/inngest/trigger/setup/sidecar-<name>/pr-review).",
      inputSchema: {
        lines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('max lines, default 150'),
        name: z.string(),
        repo: z.string(),
        type: z.string().optional().describe('log type, default "dev"'),
      },
      title: 'Get worktree log tail',
    },
    ({ repo, name, type, lines }) => {
      const res = deps.tailLog(repo, name, type ?? 'dev', lines ?? 150);
      let output = res.lines?.join('\n') ?? '';
      if (res.state === 'read-error') {
        const retention = res.retained ? ' Showing retained output.' : '';
        output = `Log read failed (${res.code ?? 'READ_FAILED'}).${retention}${output ? `\n${output}` : ''}`;
      } else if (res.state === 'missing') {
        output = 'Log file is missing.';
      } else if (res.state === 'empty') {
        output = 'Log file is empty.';
      }
      return {
        ...text(output),
        isError: res.state === 'read-error',
        structuredContent: res,
      };
    }
  );

  server.registerTool(
    'list_ports',
    {
      annotations: { readOnlyHint: true },
      description:
        "List processes currently listening on Setu's port range (3000-3999) and which worktree, if any, each belongs to.",
      inputSchema: {},
      title: 'List active ports',
    },
    async () => text(await deps.listPorts())
  );

  server.registerTool(
    'list_projects',
    {
      annotations: { readOnlyHint: true },
      description:
        'List every project registered with Setu (name, label, GitHub repo if any).',
      inputSchema: {},
      title: 'List registered projects',
    },
    async () => text(deps.listProjects())
  );

  server.registerTool(
    'list_repo_prs',
    {
      annotations: { readOnlyHint: true },
      description:
        "List every open GitHub PR on a registered project's repo, whether or not a Setu worktree exists for it yet.",
      inputSchema: { repo: z.string() },
      title: 'List open PRs on a repo',
    },
    async ({ repo }) => text(await deps.fetchRepoPRs(repo))
  );

  server.registerTool(
    'get_pr_review_status',
    {
      annotations: { readOnlyHint: true },
      description:
        'Check whether the pr-walkthrough Claude Code plugin is installed for a worktree, whether a deep review is currently running, and the latest review/brief artifact info (findings count, staleness vs. current HEAD) if one exists.',
      inputSchema: { name: z.string(), repo: z.string() },
      title: 'Get PR review status',
    },
    async ({ repo, name }) => text(await deps.prReviewStatus(repo, name))
  );

  server.registerTool(
    'run_pr_review',
    {
      description:
        "Start a headless deep PR review (pr-walkthrough) or product brief (pr-brief) against a worktree's PR via the installed Claude Code plugin. Fire-and-forget: returns immediately once the run starts, real API budget is spent on Claude's account, and the run takes several minutes. Call get_pr_review_status separately to poll progress and get the result.",
      inputSchema: {
        name: z.string(),
        repo: z.string(),
        skill: z.enum(['pr-walkthrough', 'pr-brief']),
      },
      title: 'Run a deep PR review',
    },
    ({ repo, name, skill }) =>
      mutationResult(() => deps.prReviewRun(repo, name, skill))
  );

  server.registerTool(
    'create_pr',
    {
      description:
        "Push the worktree's branch and open a GitHub PR for it (gh pr create --fill, title/body autofilled from commits). Fails clearly if the repo has no GitHub remote, the branch has no commits ahead of its base, or a PR already exists -- call list_worktrees or get_diff first if unsure. Never valid for a worktree named \"main\" (Setu's fixed slot for a project's primary line, never itself a PR candidate).",
      inputSchema: { name: z.string(), repo: z.string() },
      title: 'Create a pull request',
    },
    ({ repo, name }) => mutationResult(() => deps.createPr(repo, name))
  );

  server.registerTool(
    'pr_ready',
    {
      description:
        "Mark an existing open PR as ready for review, or convert it back to draft. Requires a PR to already exist on the worktree (see list_worktrees's pr field, or list_repo_prs) -- use create_pr first if there isn't one yet.",
      inputSchema: {
        name: z.string(),
        ready: z
          .boolean()
          .describe('true to mark ready for review, false to convert to draft'),
        repo: z.string(),
      },
      title: 'Toggle a PR between draft and ready for review',
    },
    ({ repo, name, ready }) =>
      mutationResult(() => deps.setPrReady(repo, name, ready))
  );
}

// Shown once to the connecting client at initialize time (MCP's own
// `instructions` field on InitializeResult, confirmed by reading
// node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js directly:
// Server stores options.instructions and includes it in every initialize
// response verbatim) -- not a tool, not per-call, the one place to brief an
// agent on how this whole server fits together before it starts picking
// tools one at a time from titles/descriptions alone.
const INSTRUCTIONS = `Setu manages parallel git worktrees for local development: one bare repo per project (\`<repo>.git\`), lightweight worktrees under it (one per branch, each with its own dev server, port, and \`<branch>.quivly.local\` domain). This server is a full front door onto it — the same backend the web UI and CLI use, no capability gap.

TOOL GROUPS
- Writer coordination: claim_worktree -> edit (refresh the same session periodically) -> release_worktree; list_claims shows current owners. Supply the local agent PID when claiming. If another session holds the claim, use a separate worktree.
- Discovery (read-only, cheap, call these first): list_projects, list_worktrees, list_repo_prs, list_ports.
- Lifecycle: create_worktree -> start_worktree -> ... -> stop_worktree / remove_worktree.
- Debugging: get_logs, get_diff, list_ports, get_pr_review_status / run_pr_review.
- GitHub: create_pr, pr_ready, list_repo_prs.

EFFICIENT USE
- Always call list_worktrees before create_worktree. A branch that already has a worktree needs start_worktree, not another create_worktree call.
- To debug "why isn't this worktree behaving as expected", in order: (1) list_worktrees for its current state (active/dirty/ahead-behind/container mode), (2) get_logs (type defaults to "dev") for the dev server's actual recent output, (3) get_diff to see what's really changed vs. its base branch rather than assuming, (4) list_ports if the dev server seems unreachable — a stale/crashed process can still hold the port.
- get_diff defaults to stats + filenames only (LLM-sized, not the UI's full hunks) — pass verbose:true only when you actually need line-by-line detail, capped at 20 files and 200 KB total output.
- A worktree literally named "main" is Setu's fixed slot for a project's primary line. sync_worktree refuses it. create_pr does not add a special main guard, so do not create a PR from main.
- sync_worktree only ever performs a clean merge. A real conflict is detected and the merge is aborted automatically, worktree left exactly as it was — it does not attempt any conflict resolution, that's still your job afterward.
- Omit the \`container\` param on start_worktree unless you specifically need to force a mode — omitting it uses the sticky per-worktree default (a worktree's own history, not a global setting), which is almost always what's wanted.
- remove_worktree is destructive (uncommitted work is gone, and a container-backed worktree's node_modules volume too) but never deletes the git branch itself — the branch can always be recovered by creating a new worktree from it.
- run_pr_review is fire-and-forget and spends real API budget on the user's own account over several minutes — confirm that's actually wanted before calling it, then poll get_pr_review_status separately rather than blocking on it.
- The portal daemon must already be running for any of this to work; there's no auto-start on a failed connection.`;

function buildServer() {
  const server = new McpServer(
    { name: 'setu', version: '1.0.0' },
    { instructions: INSTRUCTIONS }
  );
  registerTools(server);
  return server;
}

// The outer portal guard requires a local peer and trusted Origin. Keep the
// SDK's Host validation enabled as an additional boundary for MCP clients.
const ALLOWED_HOSTS = [`localhost:${PORTAL_PORT}`, `127.0.0.1:${PORTAL_PORT}`];

export async function handleMcpRequest(req) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    allowedHosts: ALLOWED_HOSTS,
    enableDnsRebindingProtection: true,
  });
  const server = buildServer();
  await server.connect(transport);
  return transport.handleRequest(req);
}
