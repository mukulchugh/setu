// GET /api/workspace-inventory (read-only). Unknown values stay unknown: a failed
// discovery, missing count or unobserved runtime is never shown as zero or stopped.
export interface InventoryRow {
  active: boolean | null;
  branch: string | null;
  detached: boolean;
  discovery: 'ready' | 'unknown';
  head: string | null;
  id: string;
  key: string | null;
  lastPortalActivityAt: number | null;
  linked: boolean | null;
  locked: boolean;
  name: string | null;
  operation: { kind: string; phase: string } | null;
  path: string;
  port: number | null;
  presence: 'present' | 'missing' | 'unknown';
  prunable: boolean;
  registered: boolean;
  repo: string;
  review: { reasons: string[]; requiredGates: string[] };
}
export interface WorkspaceInventory {
  checkedAt: number;
  counts: {
    linked: number | null;
    missing: number;
    observedLinked: number;
    registered: number;
    unregistered: number;
  };
  repositories: {
    checkedAt: number;
    error: string | null;
    repo: string;
    state: 'ready' | 'unknown';
  }[];
  reviewGates: { id: string; label: string }[];
  rows: InventoryRow[];
  state: 'ready' | 'partial';
}
export type InventoryRead =
  | { kind: 'ready'; inventory: WorkspaceInventory }
  | { kind: 'unavailable' };

const isString = (value: unknown) => typeof value === 'string';
const isBoolean = (value: unknown) => typeof value === 'boolean';
const isCount = (value: unknown) =>
  Number.isInteger(value) && (value as number) >= 0;
const orNull =
  (check: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    value === null || check(value);
const isStringList = (value: unknown) =>
  Array.isArray(value) && value.every(isString);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const ROW_FIELDS: Record<string, (value: unknown) => boolean> = {
  active: orNull(isBoolean),
  branch: orNull(isString),
  detached: isBoolean,
  discovery: (value) => value === 'ready' || value === 'unknown',
  head: orNull(isString),
  id: isString,
  key: orNull(isString),
  lastPortalActivityAt: orNull(Number.isFinite),
  linked: orNull(isBoolean),
  locked: isBoolean,
  name: orNull(isString),
  operation: orNull(
    (value) => isRecord(value) && isString(value.kind) && isString(value.phase)
  ),
  path: isString,
  port: orNull(Number.isFinite),
  presence: (value) =>
    value === 'present' || value === 'missing' || value === 'unknown',
  prunable: isBoolean,
  registered: isBoolean,
  repo: isString,
  review: (value) =>
    isRecord(value) &&
    isStringList(value.reasons) &&
    isStringList(value.requiredGates),
};

export function parseWorkspaceInventory(value: unknown): WorkspaceInventory {
  if (!isRecord(value)) {
    throw new Error('Inventory unavailable');
  }
  const { checkedAt, counts, repositories, reviewGates, rows, state } = value;
  if (
    !(
      Number.isFinite(checkedAt) &&
      (state === 'ready' || state === 'partial') &&
      isRecord(counts) &&
      orNull(isCount)(counts.linked) &&
      ['missing', 'observedLinked', 'registered', 'unregistered'].every(
        (field) => isCount(counts[field])
      )
    )
  ) {
    throw new Error('Invalid inventory summary');
  }
  if (
    !(
      Array.isArray(repositories) &&
      repositories.every(
        (repo) =>
          isRecord(repo) &&
          isString(repo.repo) &&
          (repo.state === 'ready' || repo.state === 'unknown') &&
          Number.isFinite(repo.checkedAt) &&
          orNull(isString)(repo.error)
      )
    )
  ) {
    throw new Error('Invalid repository discovery');
  }
  if (
    !(
      Array.isArray(reviewGates) &&
      reviewGates.every(
        (gate) => isRecord(gate) && isString(gate.id) && isString(gate.label)
      )
    )
  ) {
    throw new Error('Invalid review gates');
  }
  if (
    !(
      Array.isArray(rows) &&
      rows.every(
        (row) =>
          isRecord(row) &&
          Object.entries(ROW_FIELDS).every(([field, check]) =>
            check(row[field])
          )
      )
    )
  ) {
    throw new Error('Invalid inventory rows');
  }
  return value as unknown as WorkspaceInventory;
}

// An older running portal answers 404: that needs a restart, not a retry.
export function inventoryResponse(
  status: number,
  body: unknown
): InventoryRead {
  if (status === 404) {
    return { kind: 'unavailable' };
  }
  if (status < 200 || status >= 300) {
    throw new Error('Inventory read failed');
  }
  return { inventory: parseWorkspaceInventory(body), kind: 'ready' };
}

export async function readInventory(
  signal: AbortSignal
): Promise<InventoryRead> {
  const response = await fetch('/api/workspace-inventory', { signal });
  return inventoryResponse(
    response.status,
    response.status === 404 ? null : await response.json()
  );
}
