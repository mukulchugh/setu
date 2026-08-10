// Thin wrapper around the Setu portal's HTTP API — the same one the web UI
// (portal/app.tsx) calls. Deliberately no independent logic here: every
// mutation (start/stop/sync/create/remove) is a plain POST to an endpoint
// that already exists in portal.js, so behavior never drifts between the
// portal and this extension.
import { getPreferenceValues } from "@raycast/api";

export type Worktree = {
  key: string;
  repo: string;
  name: string;
  slug: string;
  port: number;
  domain: string;
  pubDomain: string;
  tunnelOn: boolean;
  active: boolean;
  container: string | null;
  nextStartMode: "container" | "bare";
  needsMigrationPrompt: boolean;
  tunnelRunning: boolean;
  label: string;
  branchUrl: string | null;
  pr: { url: string; number: number; title: string } | null;
  inngestActive: boolean;
  inngestPort: number;
  triggerActive: boolean;
  queued?: boolean;
  queuePosition?: number | null;
  lastCommitAt: number | null;
  ahead: number;
  behind: number;
  dirty: number;
  memMb: number | null;
  createdAt: number | null;
};

export type Project = { name: string; label: string; github?: string | null };
export type Agent = { id: string; label: string };

export type ActionResult = {
  ok: boolean;
  error?: string;
  conflicts?: string[];
  [key: string]: unknown;
};

function portalUrl(): string {
  const { portalUrl: pref } = getPreferenceValues<{ portalUrl?: string }>();
  return (pref || "http://localhost:2999").replace(/\/$/, "");
}

// Every fetch here can fail the same one way — the portal isn't running.
// Callers surface that specific case distinctly (a "run `setu portal`"
// empty state) rather than a generic error, so this throws a typed error
// the UI layer can check for.
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
  let res: Response;
  try {
    res = await fetch(`${portalUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PortalUnreachableError();
  }
  return (await res.json().catch(() => ({ ok: res.ok }))) as ActionResult;
}

export const listWorktrees = () => get<Worktree[]>("/api/worktrees");
export const listProjects = () => get<Project[]>("/api/projects");
export const listAgents = () => get<Agent[]>("/api/agents");

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

export const removeWorktree = (repo: string, name: string) =>
  post("/api/remove", { repo, name });

export const openTool = (repo: string, name: string, tool: string) =>
  post("/api/open", { repo, name, tool });
