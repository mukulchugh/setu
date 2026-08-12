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
import * as z from 'zod/v4';
import { PORTAL_PORT } from './lib.js';

// Populated by portal.js's initMcpServer() call, once, at startup — after
// the functions it references are defined (safe regardless of call order
// since they're all hoisted function declarations, but this runs last).
let deps = null;

export function initMcpServer(d) {
  deps = d;
}

// Mirrors portalRequest's old contract (lib.js): a result shaped like
// {ok:false, error} throws instead of being returned as a "success". Several
// of portal.js's own functions (startWorktree, removeWorktree, ...) report
// failure this way rather than throwing, so tool handlers need the same
// unwrap portalRequest used to do — now applied locally instead of over HTTP.
function unwrap(result) {
  if (result && typeof result === 'object' && result.ok === false) {
    throw new Error(result.error || 'request failed');
  }
  return result;
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
    repo: w.repo, name: w.name, branch: w.branch, label: w.label,
    port: w.port, domain: w.domain, active: w.active, container: w.container,
    dirty: w.dirty, ahead: w.ahead, behind: w.behind,
    pr: w.pr ? { number: w.pr.number, state: w.pr.state, checks: w.pr.checks, url: w.pr.url } : null,
  };
}

// computeDiff's hunks are UI-bounded (300 files, 2000 lines/file, one JSON
// object per changed line — see portal.js's own DIFF_MAX_FILES/
// DIFF_FILE_LINE_CAP), not LLM-bounded. Default to stats + filenames only;
// full hunks are opt-in via `verbose`, still capped well below the UI's own
// ceiling since a tool result isn't virtualized the way the web UI's list is.
const DIFF_VERBOSE_FILE_CAP = 20;

function shapeDiffGroup(group, verbose) {
  if (!group) return group;
  const base = { totalFiles: group.totalFiles, additions: group.additions, deletions: group.deletions };
  if (!verbose) {
    return { ...base, files: group.files.map(f => ({ file: f.file, additions: f.additions, deletions: f.deletions, binary: !!f.binary })) };
  }
  const shown = group.files.slice(0, DIFF_VERBOSE_FILE_CAP);
  return {
    ...base,
    files: shown,
    truncatedFileCount: Math.max(0, group.files.length - shown.length) + (group.truncatedFileCount ?? 0),
  };
}

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

// ── tool registration ───────────────────────────────────────────────────────

function registerTools(server) {
  server.registerTool('list_worktrees', {
    title: 'List worktrees',
    description: 'List every registered Setu worktree with its branch, port, running state, uncommitted-change count, and PR summary.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const worktrees = await deps.getWorktrees();
    return text(worktrees.map(compactWorktree));
  });

  server.registerTool('create_worktree', {
    title: 'Create worktree',
    description: 'Create a new Setu worktree for a branch (forks from the repo\'s base branch if the branch doesn\'t exist yet). Does not start the dev server.',
    inputSchema: {
      repo: z.string().describe('registered project name, e.g. "quivly-app"'),
      name: z.string().describe('branch name'),
      tunnel: z.boolean().optional().describe('enable the shared public tunnel for this worktree on creation'),
    },
  }, async ({ repo, name, tunnel }) => {
    return text(unwrap(deps.createWorktree(repo, name, !!tunnel)));
  });

  server.registerTool('start_worktree', {
    title: 'Start dev server',
    description: 'Start a worktree\'s dev server. Omit `container` to use the sticky per-worktree default; pass true/false to force container or bare mode.',
    inputSchema: {
      repo: z.string(), name: z.string(),
      container: z.boolean().optional().describe('force container (true) or bare (false) mode; omit for the sticky default'),
    },
  }, async ({ repo, name, container }) => {
    return text(unwrap(deps.startWorktree(repo, name, container)));
  });

  server.registerTool('stop_worktree', {
    title: 'Stop dev server',
    description: 'Stop a worktree\'s dev server (or dequeue it if still waiting for a concurrency slot). Also stops its sidecars.',
    inputSchema: { repo: z.string(), name: z.string() },
    annotations: { destructiveHint: true },
  }, async ({ repo, name }) => {
    return text(unwrap(deps.stopWorktree(repo, name)));
  });

  server.registerTool('remove_worktree', {
    title: 'Remove worktree',
    description: 'Stop the dev server and permanently remove a worktree\'s directory, port, and domain. The git branch itself is NOT deleted. For a container-backed worktree this also removes its node_modules volume.',
    inputSchema: {
      repo: z.string(), name: z.string(),
      reason: z.enum(['manual', 'merged']).optional().describe('defaults to "manual"'),
    },
    annotations: { destructiveHint: true },
  }, async ({ repo, name, reason }) => {
    return text(unwrap(deps.removeWorktree(repo, name, reason ?? 'manual')));
  });

  server.registerTool('get_diff', {
    title: 'Get worktree diff',
    description: 'Diff a worktree\'s branch against its base and its uncommitted changes. Defaults to stats + filenames only; pass verbose:true for actual hunks (capped to the first 20 files).',
    inputSchema: {
      repo: z.string(), name: z.string(),
      verbose: z.boolean().optional().describe('include full line-by-line hunks, default false (stats + filenames only)'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ repo, name, verbose }) => {
    const diff = await deps.computeDiff(repo, name);
    return text({
      base: diff.base, baseResolved: diff.baseResolved,
      committed: shapeDiffGroup(diff.committed, !!verbose),
      uncommitted: shapeDiffGroup(diff.uncommitted, !!verbose),
    });
  });

  server.registerTool('get_logs', {
    title: 'Get worktree log tail',
    description: 'Tail a worktree\'s log file (dev server by default; also tunnel/inngest/trigger/setup/sidecar-<name>/pr-review).',
    inputSchema: {
      repo: z.string(), name: z.string(),
      type: z.string().optional().describe('log type, default "dev"'),
      lines: z.number().int().positive().optional().describe('max lines, default 150'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ repo, name, type, lines }) => {
    const res = deps.tailLog(repo, name, type ?? 'dev', lines ?? 150);
    return text(res.lines?.join('\n') ?? '');
  });

  server.registerTool('list_ports', {
    title: 'List active ports',
    description: 'List processes currently listening on Setu\'s port range (3000-3999) and which worktree, if any, each belongs to.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    return text(deps.listPorts());
  });

  server.registerTool('list_projects', {
    title: 'List registered projects',
    description: 'List every project registered with Setu (name, label, GitHub repo if any).',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    return text(deps.listProjects());
  });

  server.registerTool('list_repo_prs', {
    title: 'List open PRs on a repo',
    description: 'List every open GitHub PR on a registered project\'s repo, whether or not a Setu worktree exists for it yet.',
    inputSchema: { repo: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ repo }) => {
    return text(await deps.fetchRepoPRs(repo));
  });

  server.registerTool('get_pr_review_status', {
    title: 'Get PR review status',
    description: 'Check whether the pr-walkthrough Claude Code plugin is installed for a worktree, whether a deep review is currently running, and the latest review/brief artifact info (findings count, staleness vs. current HEAD) if one exists.',
    inputSchema: { repo: z.string(), name: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ repo, name }) => {
    return text(await deps.prReviewStatus(repo, name));
  });

  server.registerTool('run_pr_review', {
    title: 'Run a deep PR review',
    description: 'Start a headless deep PR review (pr-walkthrough) or product brief (pr-brief) against a worktree\'s PR via the installed Claude Code plugin. Fire-and-forget: returns immediately once the run starts, real API budget is spent on Claude\'s account, and the run takes several minutes. Call get_pr_review_status separately to poll progress and get the result.',
    inputSchema: {
      repo: z.string(), name: z.string(),
      skill: z.enum(['pr-walkthrough', 'pr-brief']),
    },
  }, async ({ repo, name, skill }) => {
    return text(await deps.prReviewRun(repo, name, skill));
  });
}

function buildServer() {
  const server = new McpServer({ name: 'setu', version: '1.0.0' });
  registerTools(server);
  return server;
}

// Bound to the same host/port set the portal itself already claims to be
// safe on (see portal.js's own /mcp mount comment for why this matters —
// Bun.serve defaults to 0.0.0.0, so this is LAN-reachable, not just
// loopback, and the SDK's DNS-rebinding check is off and inert by default
// unless allowedHosts is set explicitly).
const ALLOWED_HOSTS = [`localhost:${PORTAL_PORT}`, `127.0.0.1:${PORTAL_PORT}`];

export async function handleMcpRequest(req) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableDnsRebindingProtection: true,
    allowedHosts: ALLOWED_HOSTS,
  });
  const server = buildServer();
  await server.connect(transport);
  return transport.handleRequest(req);
}
