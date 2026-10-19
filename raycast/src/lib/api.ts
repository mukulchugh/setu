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
  /** The repo/project the worktree belongs to, e.g. "my-app". */
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

export type LinksTarget = { repo: string; name: string; sessionId: string };

export type ManagedSession = {
  id: string;
  name: string;
  repo: string;
  nativeConversation?: { provider?: string; state?: string } | null;
  ownership?: string;
  state?: string;
  tool?: string;
};

export type LinksMessage = {
  attemptId: string | null;
  attempts: number;
  body?: string;
  createdAt: number;
  expiresAt: number;
  messageId: string;
  reason: string | null;
  recipient: {
    currentSessionId: string;
    nativeId: string;
    provider: string;
    sessionId: string;
  };
  redeliveries: number;
  replyTo: string | null;
  sender: { id?: string; kind: string };
  size: number;
  state: string;
  storedState: string;
  updatedAt: number;
  observed?: boolean;
  runHint?: string | null;
};

export type LinksDirectoryEntry = {
  activityAt: number | null;
  observedAt: number;
  owner: string;
  project: string;
  reachability: { reason?: string | null; state: string };
  sessionId: string;
  stale: boolean;
  task: string | null;
  taskAt: number | null;
  taskStale: boolean;
};

export type LinksPolicy = {
  attention: boolean;
  interrupt: boolean;
  owner: string;
  receive: boolean;
  visibility: boolean;
};

export type LinksConfirmation = {
  fields?: { field: string; keys: string[]; meaning: string }[];
  never?: string[];
  owner?: string;
  permissions?: Record<string, boolean>;
  project?: string;
  effect?: string;
  token?: string;
};

export type LinksInboxResult = LinksResult & {
  messages?: LinksMessage[];
  observed?: boolean;
};

export type LinksDirectoryResult = LinksResult & {
  entries?: LinksDirectoryEntry[];
  problems?: { code: string; project: string; reason: string; recovery?: string }[];
  staleAfterMs?: number;
};

export type LinksShareStatusResult = LinksResult & {
  projects?: (LinksResult & { registered?: boolean; shared?: boolean })[];
  registered?: boolean;
  shared?: boolean;
};

export type LinksResult = ActionResult & {
  confirmation?: LinksConfirmation;
  messageId?: string;
  policy?: LinksPolicy;
  project?: string;
  state?: string;
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

// Links mutations are never replayed by Raycast. A lost response has the
// service's stable unknown-outcome code, so the caller can preserve a send's
// exact idempotency key or inspect the current message before deciding.
async function postLinks<T extends LinksResult>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const uncertain = (): T =>
    ({
      code: "LINKS_OUTCOME_UNKNOWN",
      error: "Outcome not confirmed. Refresh before deciding whether to retry.",
      networkUncertain: true,
      ok: false,
    }) as T;
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
    const result = await res.json();
    if (!isLinksResult(result) || (!res.ok && result.ok))
      return uncertain();
    return result as T;
  } catch {
    return uncertain();
  }
}

function linksQuery(path: string, values: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, value);
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function invalidLinksResponse(): LinksResult {
  return {
    code: "LINKS_RESPONSE_INVALID",
    error: "The local Links response was malformed. Refresh before acting.",
    ok: false,
  };
}

function isPolicy(value: unknown): value is LinksPolicy {
  return (
    isRecord(value) &&
    isText(value.owner) &&
    ["attention", "interrupt", "receive", "visibility"].every(
      (key) => typeof value[key] === "boolean",
    )
  );
}

function isConfirmation(value: unknown): value is LinksConfirmation {
  if (!isRecord(value)) return false;
  return (
    (value.token === undefined || isText(value.token)) &&
    (value.project === undefined || isText(value.project)) &&
    (value.owner === undefined || isText(value.owner)) &&
    (value.effect === undefined || isText(value.effect)) &&
    (value.never === undefined || Array.isArray(value.never)) &&
    (value.fields === undefined || Array.isArray(value.fields)) &&
    (value.permissions === undefined || isRecord(value.permissions))
  );
}

function isLinksResult(value: unknown): value is LinksResult {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    (value.code === undefined || isText(value.code)) &&
    (value.error === undefined || isText(value.error)) &&
    (value.project === undefined || isText(value.project)) &&
    (value.state === undefined || isText(value.state)) &&
    (value.messageId === undefined || isText(value.messageId)) &&
    (value.policy === undefined || isPolicy(value.policy)) &&
    (value.confirmation === undefined || isConfirmation(value.confirmation))
  );
}

function isMessage(value: unknown): value is LinksMessage & LinksResult {
  if (!isLinksResult(value) || !value.ok) return isLinksResult(value);
  const recipient = value.recipient;
  const sender = value.sender;
  if (!isRecord(recipient) || !isRecord(sender)) return false;
  return (
    [
      "attempts",
      "createdAt",
      "expiresAt",
      "redeliveries",
      "size",
      "updatedAt",
    ].every((key) => isNumber(value[key])) &&
    ["messageId", "state", "storedState"].every((key) => isText(value[key])) &&
    (value.attemptId === null || isText(value.attemptId)) &&
    (value.reason === null || isText(value.reason)) &&
    (value.replyTo === null || isText(value.replyTo)) &&
    (value.body === undefined || isText(value.body)) &&
    (value.runHint === undefined || value.runHint === null || isText(value.runHint)) &&
    (value.observed === undefined || typeof value.observed === "boolean") &&
    isText(sender.kind) &&
    (sender.id === undefined || isText(sender.id)) &&
    ["currentSessionId", "nativeId", "provider", "sessionId"].every((key) =>
      isText(recipient[key]),
    )
  );
}

function isDirectoryEntry(value: unknown): value is LinksDirectoryEntry {
  return (
    isRecord(value) &&
    isRecord(value.reachability) &&
    ["owner", "project", "sessionId"].every((key) => isText(value[key])) &&
    ["observedAt"].every((key) => isNumber(value[key])) &&
    (value.activityAt === null || isNumber(value.activityAt)) &&
    (value.task === null || isText(value.task)) &&
    (value.taskAt === null || isNumber(value.taskAt)) &&
    typeof value.stale === "boolean" &&
    typeof value.taskStale === "boolean" &&
    isText(value.reachability.state) &&
    (value.reachability.reason === undefined || value.reachability.reason === null || isText(value.reachability.reason))
  );
}

function isInbox(value: unknown): value is LinksInboxResult {
  return (
    isLinksResult(value) &&
    (!value.ok ||
      ((value.messages === undefined || (Array.isArray(value.messages) && value.messages.every(isMessage))) &&
        (value.observed === undefined || typeof value.observed === "boolean")))
  );
}

function isDirectory(value: unknown): value is LinksDirectoryResult {
  return (
    isLinksResult(value) &&
    (!value.ok ||
      ((value.entries === undefined || (Array.isArray(value.entries) && value.entries.every(isDirectoryEntry))) &&
        (value.problems === undefined ||
          (Array.isArray(value.problems) &&
            value.problems.every(
              (problem) =>
                isRecord(problem) &&
                ["code", "project", "reason"].every((key) => isText(problem[key])) &&
                (problem.recovery === undefined || isText(problem.recovery)),
            ))) &&
        (value.staleAfterMs === undefined || isNumber(value.staleAfterMs))))
  );
}

function isManagedSession(value: unknown): value is ManagedSession {
  return (
    isRecord(value) &&
    ["id", "name", "repo"].every((key) => isText(value[key])) &&
    (value.tool === undefined || isText(value.tool)) &&
    (value.state === undefined || isText(value.state)) &&
    (value.ownership === undefined || isText(value.ownership)) &&
    (value.nativeConversation === undefined ||
      value.nativeConversation === null ||
      (isRecord(value.nativeConversation) &&
        (value.nativeConversation.provider === undefined || isText(value.nativeConversation.provider)) &&
        (value.nativeConversation.state === undefined || isText(value.nativeConversation.state))))
  );
}

function isShareStatus(value: unknown): value is LinksShareStatusResult {
  const project = (entry: unknown) =>
    isLinksResult(entry) &&
    isRecord(entry) &&
    (entry.shared === undefined || typeof entry.shared === "boolean") &&
    (entry.registered === undefined || typeof entry.registered === "boolean");
  return (
    isLinksResult(value) &&
    (!value.ok || value.projects === undefined || (Array.isArray(value.projects) && value.projects.every(project)))
  );
}

async function getLinks<T extends LinksResult>(
  path: string,
  valid: (value: unknown) => value is T,
): Promise<T> {
  const value = await get<unknown>(path);
  return valid(value) ? value : (invalidLinksResponse() as T);
}

export const listWorktrees = () => get<Worktree[]>("/api/worktrees");
export const listProjects = () => get<Project[]>("/api/projects");
export const listAgents = () => get<Agent[]>("/api/agents");
export const listPorts = () => get<Port[]>("/api/ports");
export const getStatus = () => get<PortalStatus>("/api/status");
export const listManagedSessions = () =>
  getLinks(
    "/api/agent-sessions",
    (value): value is LinksResult & { sessions?: ManagedSession[] } =>
      isLinksResult(value) &&
      (!value.ok || value.sessions === undefined || (Array.isArray(value.sessions) && value.sessions.every(isManagedSession))),
  );
export const linksDirectory = () =>
  getLinks("/api/links/directory", isDirectory);
export const linksInbox = (target: LinksTarget, state?: string) =>
  getLinks(
    linksQuery("/api/links/inbox", { ...target, state }),
    isInbox,
  );
export const linksMessage = (messageId: string) =>
  getLinks<LinksMessage & LinksResult>(
    linksQuery("/api/links/message", { messageId }),
    isMessage,
  );
export const linksStatus = (messageId: string) =>
  getLinks<LinksMessage & LinksResult>(
    linksQuery("/api/links/status", { messageId }),
    isMessage,
  );
export const linksCapabilities = () =>
  getLinks(
    "/api/links/capabilities",
    (value): value is LinksResult & {
    attention?: { notification?: string };
    wake?: { available: boolean; code?: string; error?: string; reason?: string };
  } =>
      isLinksResult(value) && (() => {
        const attention = value.attention;
        const wake = value.wake;
        return !value.ok ||
          ((attention === undefined ||
            (isRecord(attention) &&
              (attention.notification === undefined || isText(attention.notification)))) &&
            (wake === undefined ||
              (isRecord(wake) &&
                typeof wake.available === "boolean" &&
                ["code", "error", "reason"].every(
                  (key) => wake[key] === undefined || isText(wake[key]),
                ))));
      })(),
  );
export const linksShareStatus = (repo?: string) =>
  getLinks(linksQuery("/api/links/share/status", { repo }), isShareStatus);
export const linksSend = (input: LinksTarget & {
  body: string;
  idempotencyKey: string;
  replyTo?: string;
}) => postLinks<LinksResult>("/api/links/send", input);
export const linksAck = (input: LinksTarget & { messageId: string }) =>
  postLinks<LinksResult>("/api/links/ack", input);
export const linksCancel = (messageId: string) =>
  postLinks<LinksResult>("/api/links/cancel", { messageId });
export const linksRedeliver = (input: LinksTarget & {
  attemptId: string;
  messageId: string;
  confirmation?: string;
}) => postLinks<LinksResult>("/api/links/redeliver", input);
export const linksSendNow = (input: LinksTarget & { messageId: string }) =>
  postLinks<LinksResult>("/api/links/send-now", input);
export const linksShareEnable = (input: {
  repo: string;
  owner?: string;
  confirmation?: string;
}) => postLinks<LinksResult>("/api/links/share/enable", input);
export const linksShareDisable = (repo: string) =>
  postLinks<LinksResult>("/api/links/share/disable", { repo });
export const linksShareAttention = (input: {
  repo: string;
  enabled: boolean;
  confirmation?: string;
}) => postLinks<LinksResult>("/api/links/share/attention", input);

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
export const portalLinksUrl = () => `${portalUrl()}/links`;

export const openTool = (repo: string, name: string, tool: string) =>
  post("/api/open", { repo, name, tool });

// The portal web UI's per-worktree deep link. Used by both list-worktrees
// and quick-open's "Open in Setu Portal" action.
export const portalWebUrl = (w: WorktreeRef) =>
  `${portalUrl()}/worktree/${encodeURIComponent(w.repo)}/${encodeURIComponent(w.name)}`;
