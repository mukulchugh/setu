// Thin wrapper around the Setu portal's HTTP API — the same one the web UI
// (portal/app.tsx) calls. Deliberately no independent logic here: every
// mutation (start/stop/sync/create/remove) is a plain POST to an endpoint
// that already exists in portal.js, so behavior never drifts between the
// portal and this extension.
import { getPreferenceValues } from "@raycast/api";

// The "which worktree" shape shared by every mutation tool (start/stop/sync)
// whose entire input is a repo+name pair. Declared once so their AI-tool
// argument schemas, and the JSDoc descriptions Raycast surfaces to the model,
// can't drift apart between the three files.
export type WorktreeRef = {
  /** The repo/project the worktree belongs to, e.g. "quivly-app". */
  repo: string;
  /** The worktree's name — usually its branch name. */
  name: string;
};

// Only the fields this extension actually reads. The portal's own JSON
// response has more (see portal/app.tsx's Worktree type) but there's no
// shared schema to derive from, so this is trimmed to real usage rather than
// mirrored 1:1 with the backend or the portal frontend.
export type Worktree = {
  key: string;
  repo: string;
  name: string;
  label: string;
  domain: string;
  active: boolean;
  starting?: boolean;
  stopping?: boolean;
  queued?: boolean;
  queuePosition?: number | null;
  container: string | null;
  nextStartMode: "container" | "bare";
  dirty: number | null;
  ahead: number;
  behind: number;
};

export type Project = { name: string; label: string; github?: string | null };
export type Agent = { id: string; label: string };

// A process listening in Setu's tracked port range (3000-3999). `worktree`
// is the owning `repo/name` key when the port is a registered worktree's
// dev server, `null` for anything else listening in-range (an orphaned or
// manually-started process — `setu prune`'s case).
export type Port = {
  port: number;
  pid: string;
  cmd: string;
  worktree: string | null;
};

export type ActionResult = {
  ok: boolean;
  error?: string;
  conflicts?: string[];
  code?: string;
  removed?: boolean | null;
  operationId?: string;
  pendingSteps?: string[];
  completed?: string[];
  networkUncertain?: boolean;
  [key: string]: unknown;
};

export type PendingRemoval = {
  operationId: string;
  repo: string;
  name: string;
  removed: boolean | null;
  pendingSteps: string[];
  error?: string;
};
export type PortalStatus = { pendingRemovals?: PendingRemoval[] };

function portalUrl(): string {
  const { portalUrl: pref } = getPreferenceValues<{ portalUrl?: string }>();
  return (pref || "http://localhost:2999").replace(/\/$/, "");
}

// Reads can offer a portal recovery action. A failed mutation response is
// uncertain: the request may already have reached the portal.
export class PortalUnreachableError extends Error {
  constructor() {
    super("Setu portal isn't reachable");
    this.name = "PortalUnreachableError";
  }
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${portalUrl()}${path}`);
  } catch {
    throw new PortalUnreachableError();
  }
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<ActionResult> {
  const uncertain = (): ActionResult => ({
    ok: false,
    code:
      path === "/api/remove"
        ? "REMOVAL_OUTCOME_UNKNOWN"
        : "ACTION_OUTCOME_UNKNOWN",
    networkUncertain: true,
    ...(path === "/api/remove" ? { removed: null } : {}),
    ...(typeof body.operationId === "string"
      ? { operationId: body.operationId }
      : {}),
    error: "Outcome not confirmed. Refresh status before trying again.",
  });
  let res: Response;
  try {
    res = await fetch(`${portalUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-setu-source": "raycast" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
  } catch {
    return uncertain();
  }
  try {
    const result = (await res.json()) as ActionResult;
    if (!result || typeof result.ok !== "boolean" || (!res.ok && result.ok))
      return uncertain();
    return result;
  } catch {
    return uncertain();
  }
}

export const listWorktrees = () => get<Worktree[]>("/api/worktrees");
export const listProjects = () => get<Project[]>("/api/projects");
export const listAgents = () => get<Agent[]>("/api/agents");
export const listPorts = () => get<Port[]>("/api/ports");
export const getStatus = () => get<PortalStatus>("/api/status");

// Kills whatever's listening on the port directly (or, for a container-
// backed worktree, routes through the real container stop path — same
// portal-side logic /api/ports/kill already uses for the web UI's own Kill
// button). Irreversible: callers must confirm before calling this, same as
// removeWorktree.
export const killPort = (port: number) => post("/api/ports/kill", { port });

export const startWorktree = (
  repo: string,
  name: string,
  container?: boolean,
) =>
  post("/api/start", {
    repo,
    name,
    ...(container === undefined ? {} : { container }),
  });

export const stopWorktree = (repo: string, name: string) =>
  post("/api/stop", { repo, name });

export const syncWorktree = (repo: string, name: string) =>
  post("/api/sync", { repo, name });

export const createWorktree = (repo: string, name: string, tunnel = false) =>
  post("/api/create", { repo, name, tunnel });

export const removeWorktree = (
  repo: string,
  name: string,
  operationId?: string,
) =>
  post("/api/remove", {
    repo,
    name,
    ...(operationId === undefined ? {} : { operationId }),
  });

export const portalRecoveryUrl = () => `${portalUrl()}/#pending-cleanup`;

export const openTool = (repo: string, name: string, tool: string) =>
  post("/api/open", { repo, name, tool });

// The portal web UI's per-worktree deep link. Used by both list-worktrees
// and quick-open's "Open in Setu Portal" action.
export const portalWebUrl = (w: WorktreeRef) =>
  `${portalUrl()}/worktree/${encodeURIComponent(w.repo)}/${encodeURIComponent(w.name)}`;
