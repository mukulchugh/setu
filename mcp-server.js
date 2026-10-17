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
import { PACKAGE_VERSION, PORTAL_PORT } from './lib.js';
import { WRITER_AGENT_NAME } from './writer-claims.js';

// Populated by portal.js's initMcpServer() call, once, at startup — after
// the functions it references are defined (safe regardless of call order
// since they're all hoisted function declarations, but this runs last).
let deps = null;

function errorMessage(error) {
  return error?.message ?? String(error);
}

function errorProperty(error, key) {
  return error?.[key];
}

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
    result = { error: errorMessage(error), ok: false };
    for (const key of [
      'code',
      'causeCode',
      'committed',
      'reconciled',
      'phase',
      'operationId',
    ]) {
      const value = errorProperty(error, key);
      if (value !== undefined) {
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
const SIDECAR_NAME_RE = /^[a-zA-Z0-9_-]+$/;

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
  if (Buffer.byteLength(rendered) <= DIFF_TEXT_BUDGET) {
    return text(output);
  }
  output.truncation = DIFF_TRUNCATION_MARKER;
  while (Buffer.byteLength(rendered) > DIFF_TEXT_BUDGET) {
    const group = ['committed', 'uncommitted'].find(
      (key) => output[key]?.files?.length
    );
    if (group) {
      output[group].files.pop();
      rendered = render();
      continue;
    }
    const untracked = output.uncommitted?.untracked;
    if (untracked?.length) {
      untracked.pop();
      rendered = render();
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
        agent: z.string().regex(WRITER_AGENT_NAME),
        name: z.string(),
        pid: z
          .number()
          .int()
          .positive()
          .describe('long-lived local agent process ID, not the portal PID'),
        repo: z.string(),
        session: z.string().min(1).max(200),
        task: z.string().min(1).max(300),
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
        name: z.string(),
        repo: z.string(),
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
    'adopt_worktree',
    {
      description:
        'Register an existing linked Git worktree without installing dependencies, starting a server, or changing files in the checkout. The path must be a verified worktree of the registered repo.',
      inputSchema: {
        name: z.string(),
        path: z.string().min(1),
        repo: z.string(),
      },
      title: 'Adopt an existing worktree',
    },
    ({ repo, name, path }) =>
      mutationResult(() => deps.adoptWorktree(repo, name, path))
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
    'enable_tunnel',
    {
      description:
        "Move Setu's one shared public tunnel URL to this registered worktree.",
      inputSchema: { name: z.string(), repo: z.string() },
      title: 'Move the shared tunnel',
    },
    ({ repo, name }) => mutationResult(() => deps.enableTunnel(repo, name))
  );

  server.registerTool(
    'disable_tunnel',
    {
      description: 'Release the shared public tunnel from this worktree.',
      inputSchema: { name: z.string(), repo: z.string() },
      title: 'Release the shared tunnel',
    },
    ({ repo, name }) => mutationResult(() => deps.disableTunnel(repo, name))
  );

  for (const [tool, title, action] of [
    ['start_inngest', 'Start Inngest', 'startInngest'],
    ['stop_inngest', 'Stop Inngest', 'stopInngest'],
    ['start_trigger', 'Start Trigger.dev', 'startTrigger'],
    ['stop_trigger', 'Stop Trigger.dev', 'stopTrigger'],
    ['start_convex', 'Start Convex development', 'startConvex'],
    ['stop_convex', 'Stop Convex development', 'stopConvex'],
  ]) {
    server.registerTool(
      tool,
      {
        description: `${title} for a worktree through the portal runtime owner.`,
        inputSchema: { name: z.string(), repo: z.string() },
        title,
      },
      ({ repo, name }) => mutationResult(() => deps[action](repo, name))
    );
  }

  server.registerTool(
    'list_sidecars',
    {
      annotations: { readOnlyHint: true },
      description:
        'List the configured custom sidecars for a worktree, including approval and active state.',
      inputSchema: { name: z.string(), repo: z.string() },
      title: 'List worktree sidecars',
    },
    async ({ repo, name }) => text(await deps.listSidecars(repo, name))
  );

  server.registerTool(
    'get_sidecar_logs',
    {
      annotations: { readOnlyHint: true },
      description: "Read a configured sidecar's bounded recent log output.",
      inputSchema: {
        lines: z.number().int().positive().optional(),
        name: z.string(),
        repo: z.string(),
        sidecar: z.string().regex(SIDECAR_NAME_RE),
      },
      title: 'Get sidecar log tail',
    },
    ({ repo, name, sidecar, lines }) => {
      const res = deps.getSidecarLogs(repo, name, sidecar, lines ?? 150);
      return {
        ...text(res.lines?.join('\n') ?? ''),
        isError: res.state === 'read-error',
        structuredContent: res,
      };
    }
  );

  server.registerTool(
    'get_doctor',
    {
      annotations: { readOnlyHint: true },
      description:
        'Read the portal health report without changing the machine.',
      inputSchema: {},
      title: 'Read portal doctor report',
    },
    async () => text(await deps.doctorReport())
  );

  const worktree = { name: z.string().min(1), repo: z.string().min(1) };
  const identity = z.object({}).passthrough();
  const readTools = [
    [
      'get_workspace_storage',
      'Read cached workspace storage observations without scanning.',
      'workspaceStorage',
      {},
    ],
    [
      'list_operations',
      'List recorded portal operation outcomes.',
      'operations',
      {
        limit: z.number().int().positive().max(200).optional(),
        name: z.string().min(1).optional(),
        repo: z.string().min(1).optional(),
        since: z
          .union([z.number().int().nonnegative(), z.string().datetime()])
          .optional(),
      },
    ],
    [
      'get_resource_admission',
      'Read current admission leases and limits.',
      'admissionStatus',
      {},
    ],
    [
      'list_dependency_sharing',
      'List read-only dependency sharing views.',
      'dependencyViews',
      worktree,
    ],
    [
      'list_shared_caches',
      'List configured shared cache catalog entries.',
      'sharedCaches',
      {},
    ],
    [
      'list_agent_sessions',
      'List managed coding terminal sessions.',
      'agentSessions',
      {
        name: z.string().min(1).optional(),
        repo: z.string().min(1).optional(),
      },
    ],
    [
      'get_setup_progress',
      'Read durable setup progress records.',
      'setupProgress',
      {
        name: z.string().min(1).optional(),
        repo: z.string().min(1).optional(),
      },
    ],
    [
      'list_attention',
      'Read normalized terminal attention events.',
      'attention',
      {
        name: z.string().min(1).optional(),
        repo: z.string().min(1).optional(),
      },
    ],
    [
      'list_headless_runs',
      'List bounded headless runs without prompts or output.',
      'headlessRuns',
      {
        name: z.string().min(1).optional(),
        repo: z.string().min(1).optional(),
      },
    ],
    [
      'list_mcp_actions',
      'List saved reviewed connected-MCP actions.',
      'mcpActions',
      {},
    ],
  ];
  for (const [tool, description, action, inputSchema] of readTools) {
    server.registerTool(
      tool,
      {
        annotations: { readOnlyHint: true },
        description,
        inputSchema,
        title: description,
      },
      async (input) => text(await deps[action](input))
    );
  }

  server.registerTool(
    'inspect_workspace_storage',
    {
      description:
        'Inspect server-known storage roots for one registered worktree or store id.',
      inputSchema: { ...worktree, storeId: z.string().min(1).optional() },
      title: 'Inspect workspace storage',
    },
    (input) => mutationResult(() => deps.workspaceStorageInspect(input))
  );
  server.registerTool(
    'verify_dependency_sharing',
    {
      description: 'Verify one registered worktree dependency sharing view.',
      inputSchema: worktree,
      title: 'Verify dependency sharing',
    },
    (input) =>
      mutationResult(() => deps.dependencyVerify({ ...input, source: 'mcp' }))
  );
  server.registerTool(
    'plan_dependency_repair',
    {
      description:
        'Return a dependency repair plan only; this never changes a view.',
      inputSchema: worktree,
      title: 'Plan dependency repair',
    },
    (input) =>
      mutationResult(() => deps.dependencyRepair({ ...input, source: 'mcp' }))
  );
  server.registerTool(
    'end_agent_session',
    {
      description:
        'End one exact owned coding session after checkout-identity confirmation.',
      inputSchema: {
        ...worktree,
        checkoutIdentity: identity,
        sessionId: z.string().min(1),
      },
      title: 'End coding session',
    },
    (input) =>
      mutationResult(() => deps.endAgentSession({ ...input, source: 'mcp' }))
  );
  server.registerTool(
    'prepare_worktree_cache_cleanup',
    {
      description:
        'Prepare a reviewable generated-cache cleanup manifest for an idle registered worktree.',
      inputSchema: worktree,
      title: 'Prepare cache cleanup',
    },
    (input) =>
      mutationResult(() => deps.cachePrepare({ ...input, source: 'mcp' }))
  );
  server.registerTool(
    'execute_worktree_cache_cleanup',
    {
      annotations: { destructiveHint: true },
      description:
        'Execute only the reviewed cache manifest with its exact confirmation.',
      inputSchema: {
        ...worktree,
        confirmation: z.union([
          z.string().min(1),
          z.object({ manifestId: z.string(), retryId: z.string() }),
        ]),
        manifestId: z.string().min(1),
      },
      title: 'Execute cache cleanup',
    },
    (input) =>
      mutationResult(() => deps.cacheExecute({ ...input, source: 'mcp' }))
  );
  server.registerTool(
    'retry_setup',
    {
      description:
        'Retry one exact durable setup attempt after checkout-identity confirmation.',
      inputSchema: {
        ...worktree,
        attemptId: z.string().min(1),
        checkoutIdentity: identity,
      },
      title: 'Retry setup',
    },
    (input) =>
      mutationResult(() => deps.setupRetry({ ...input, source: 'mcp' }))
  );
  server.registerTool(
    'focus_agent_session',
    {
      description:
        'Focus an existing verified native terminal session. Never launches a terminal.',
      inputSchema: {
        ...worktree,
        checkoutIdentity: identity,
        sessionId: z.string().min(1),
      },
      title: 'Focus coding terminal',
    },
    (input) =>
      mutationResult(() => deps.attentionFocus({ ...input, source: 'mcp' }))
  );
  server.registerTool(
    'handoff_review_findings',
    {
      description:
        'Paste a bounded editable review handoff into one exact existing managed terminal without submitting it.',
      inputSchema: {
        ...worktree,
        artifact: z.string().min(1),
        checkoutIdentity: identity,
        findings: z.array(z.object({}).passthrough()).max(100),
        sessionId: z.string().min(1),
      },
      title: 'Handoff review findings',
    },
    (input) =>
      mutationResult(() => deps.handoffReview({ ...input, source: 'mcp' }))
  );
  server.registerTool(
    'start_headless_run',
    {
      description:
        'Start a bounded Claude Code headless run in a registered worktree.',
      inputSchema: {
        ...worktree,
        maxBudgetUsd: z.number().positive().optional(),
        model: z.string().min(1).optional(),
        outputBytes: z.number().int().positive().optional(),
        prompt: z.string().min(1),
        wallClockMs: z.number().int().positive().optional(),
      },
      title: 'Start headless run',
    },
    (input) => mutationResult(() => deps.headlessStart(input, 'mcp'))
  );
  server.registerTool(
    'cancel_headless_run',
    {
      description:
        'Cancel one exact owned headless run after checkout-identity confirmation.',
      inputSchema: {
        ...worktree,
        checkoutIdentity: identity,
        runId: z.string().min(1),
      },
      title: 'Cancel headless run',
    },
    (input) =>
      mutationResult(() => deps.headlessCancel({ ...input, source: 'mcp' }))
  );
  server.registerTool(
    'resume_headless_run',
    {
      description:
        'Resume a documented Claude run with a fresh server checkout identity.',
      inputSchema: {
        ...worktree,
        maxBudgetUsd: z.number().positive().optional(),
        model: z.string().min(1).optional(),
        outputBytes: z.number().int().positive().optional(),
        prompt: z.string().min(1),
        runId: z.string().min(1),
        wallClockMs: z.number().int().positive().optional(),
      },
      title: 'Resume headless run',
    },
    (input) => mutationResult(() => deps.headlessResume(input, 'mcp'))
  );
  server.registerTool(
    'list_github_workflows',
    {
      annotations: { readOnlyHint: true },
      description:
        'List verified dispatchable GitHub workflows for a registered worktree.',
      inputSchema: worktree,
      title: 'List GitHub workflows',
    },
    (input) => mutationResult(() => deps.githubWorkflows(input))
  );
  server.registerTool(
    'list_github_runs',
    {
      annotations: { readOnlyHint: true },
      description:
        'List bounded GitHub workflow runs for a registered worktree branch.',
      inputSchema: worktree,
      title: 'List GitHub workflow runs',
    },
    (input) => mutationResult(() => deps.githubRuns(input))
  );
  server.registerTool(
    'dispatch_github_workflow',
    {
      description:
        'Dispatch one reviewed workflow at the exact current worktree branch.',
      inputSchema: {
        ...worktree,
        confirmation: z.string().min(1).optional(),
        inputs: z.record(z.string(), z.string()),
        ref: z.string().min(1),
        workflow: z.string().min(1),
      },
      title: 'Dispatch GitHub workflow',
    },
    (input) =>
      mutationResult(() => deps.githubDispatch({ ...input, source: 'mcp' }))
  );
  server.registerTool(
    'save_mcp_action',
    {
      description:
        'Save a reviewed action for one currently connected MCP tool.',
      inputSchema: {
        id: z.string().min(1).optional(),
        inputSchema: z.object({}).passthrough(),
        mutates: z.boolean(),
        serverId: z.string().min(1),
        title: z.string().min(1),
        tool: z.string().min(1),
      },
      title: 'Save MCP action',
    },
    (input) => mutationResult(() => deps.saveMcpAction(input))
  );
  server.registerTool(
    'preflight_mcp_action',
    {
      annotations: { readOnlyHint: true },
      description:
        'Review an exact saved MCP action input without invoking it.',
      inputSchema: {
        actionId: z.string().min(1),
        input: z.object({}).passthrough(),
      },
      title: 'Preflight MCP action',
    },
    (input) => mutationResult(() => deps.preflightMcpAction(input))
  );
  server.registerTool(
    'invoke_mcp_action',
    {
      description:
        'Invoke one saved MCP action only with its exact reviewed confirmation.',
      inputSchema: {
        actionId: z.string().min(1),
        confirmation: z.string().min(1),
        input: z.object({}).passthrough(),
      },
      title: 'Invoke MCP action',
    },
    (input) => mutationResult(() => deps.invokeMcpAction(input, 'mcp'))
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
          code: errorProperty(error, 'code') ?? 'REMOVAL_OUTCOME_UNKNOWN',
          error: errorMessage(error),
          ok: false,
          removed: errorProperty(error, 'removed') ?? null,
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
          const value = errorProperty(error, key);
          if (value !== undefined) {
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
const INSTRUCTIONS = `Setu manages parallel git worktrees for local development: one bare repo per project (\`<repo>.git\`), lightweight worktrees under it (one per branch, each with its own dev server, port, and \`<branch>.quivly.local\` domain).

TOOL GROUPS
- Writer coordination: claim_worktree -> edit (refresh the same session periodically) -> release_worktree; list_claims shows current owners. Supply the local agent PID when claiming. If another session holds the claim, use a separate worktree.
- Discovery (read-only, cheap, call these first): list_projects, list_worktrees, list_repo_prs, list_ports.
- Lifecycle: create_worktree -> start_worktree -> ... -> stop_worktree / remove_worktree. adopt_worktree registers a verified existing checkout without installing or starting it.
- Runtime controls: enable_tunnel / disable_tunnel move or release the one shared public URL. start_inngest, start_trigger and start_convex (and their stop tools) own the first-class sidecars. list_sidecars and get_sidecar_logs cover configured custom sidecars.
- Debugging: get_doctor, get_logs, get_diff, list_ports, get_pr_review_status / run_pr_review.
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
    { name: 'setu', version: PACKAGE_VERSION },
    { instructions: INSTRUCTIONS }
  );
  registerTools(server);
  return server;
}

// The outer portal guard requires a local peer and trusted Origin. Keep the
// SDK's Host validation enabled as an additional boundary for MCP clients.
export async function handleMcpRequest(req, port = PORTAL_PORT) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    allowedHosts: [`localhost:${port}`, `127.0.0.1:${port}`],
    enableDnsRebindingProtection: true,
  });
  const server = buildServer();
  await server.connect(transport);
  return transport.handleRequest(req);
}
