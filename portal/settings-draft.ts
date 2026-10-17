export type ResourceField =
  | 'maxConcurrentDevServers'
  | 'containerMemoryLimit'
  | 'containerCpuLimit';
export type ResourceValues = Record<ResourceField, number | string>;
interface Outcome {
  committed?: boolean;
  error?: string;
  networkUncertain?: boolean;
  ok: boolean;
  reconciled?: boolean;
  warning?: unknown;
}
interface FieldState {
  message?: string;
  state: 'saved' | 'dirty' | 'saving' | 'error';
  text: string;
  version: number;
}
interface QueuedResource {
  text: string;
  value: number | string;
  version: number;
}
export type ResourceDraft = Record<ResourceField, FieldState>;
const fields: ResourceField[] = [
  'maxConcurrentDevServers',
  'containerMemoryLimit',
  'containerCpuLimit',
];
const MEMORY_LIMIT_PATTERN = /^(\d+(?:\.\d+)?)\s*(m|g)$/i;

function invalidValueMessage(field: ResourceField) {
  if (field === 'containerMemoryLimit') {
    return 'Enter a memory limit from 64m to 1024g.';
  }
  if (field === 'maxConcurrentDevServers') {
    return 'Enter a whole number of server slots from 1 to 64.';
  }
  return 'Enter a CPU limit from 0.01 to 1024.';
}

function unsuccessfulSaveMessage(
  uncertain: boolean | undefined,
  installed: boolean,
  error: string | undefined
) {
  if (uncertain) {
    return 'Outcome not confirmed. Settings were refreshed if available; check the saved value before retrying.';
  }
  if (installed) {
    return 'Saved, but readback failed. Retry to reconcile before another save.';
  }
  return error || 'Could not save. Your draft is kept.';
}

export function reconcileExplicitDraft<T>(
  current: T,
  saved: T,
  readback: T,
  versionAtRead: number,
  currentVersion: number,
  replace: boolean,
  serialize: (value: T) => string = JSON.stringify
): T {
  return currentVersion === versionAtRead &&
    (replace || serialize(current) === serialize(saved))
    ? readback
    : current;
}

export function validateResource(
  field: ResourceField,
  text: string
): number | string | null {
  if (field === 'containerMemoryLimit') {
    const match = text.trim().match(MEMORY_LIMIT_PATTERN);
    const mb = match
      ? Number(match[1]) * (match[2].toLowerCase() === 'g' ? 1024 : 1)
      : 0;
    return mb >= 64 && mb <= 1024 * 1024 ? text.trim() : null;
  }
  const value = Number(text);
  if (!(text.trim() && Number.isFinite(value)) || value <= 0) {
    return null;
  }
  if (field === 'maxConcurrentDevServers') {
    return Number.isInteger(value) && value <= 64 ? value : null;
  }
  return value >= 0.01 && value <= 1024 ? value : null;
}

// One settings request at a time; response reconciliation owns only the
// submitted versions. A newer edit remains a draft through readback.
export function createResourceDraft(
  initial: ResourceValues,
  io: {
    write: (patch: Partial<ResourceValues>) => Promise<Outcome>;
    read: () => Promise<ResourceValues>;
    publish: (draft: ResourceDraft, saved: ResourceValues) => void;
  }
) {
  let saved = { ...initial },
    busy = false,
    stopped = false,
    needsReconcile = false;
  const active = new Set<ResourceField>();
  const idle: (() => void)[] = [];
  const draft = Object.fromEntries(
    fields.map((key) => [
      key,
      { state: 'saved', text: String(initial[key]), version: 0 },
    ])
  ) as ResourceDraft;
  const queued = new Map<ResourceField, QueuedResource>();
  const emit = () => {
    if (!stopped) {
      io.publish({ ...draft }, { ...saved });
    }
  };
  function queue(field: ResourceField) {
    if (needsReconcile) {
      reconcile();
      return;
    }
    const row = draft[field],
      value = validateResource(field, row.text);
    if (value === null) {
      queued.delete(field);
      draft[field] = {
        ...row,
        message: invalidValueMessage(field),
        state: 'error',
      };
      emit();
      return;
    }
    if (
      row.state === 'saving' ||
      (!active.has(field) &&
        row.state === 'saved' &&
        String(saved[field]) === row.text)
    ) {
      return;
    }
    queued.set(field, { text: row.text, value, version: row.version });
    flush();
  }
  async function reconcile() {
    if (busy || stopped) {
      return;
    }
    busy = true;
    try {
      saved = { ...(await io.read()) };
      needsReconcile = false;
      for (const field of fields) {
        if (draft[field].state === 'error') {
          draft[field] = {
            ...draft[field],
            message: `Saved value: ${saved[field]}. Review your draft before saving again.`,
            state: 'dirty',
          };
        }
      }
    } catch {
      /* Keep the existing uncertainty and draft until a read succeeds. */
    } finally {
      busy = false;
      emit();
      for (const done of idle.splice(0)) {
        done();
      }
    }
  }
  const resolveIdle = () => {
    for (const done of idle.splice(0)) {
      done();
    }
  };
  function beginBatch() {
    const batch = new Map(queued);
    queued.clear();
    for (const [key] of batch) {
      active.add(key);
      draft[key] = { ...draft[key], message: undefined, state: 'saving' };
    }
    emit();
    return batch;
  }
  async function writeBatch(batch: Map<ResourceField, QueuedResource>) {
    try {
      return await io.write(
        Object.fromEntries([...batch].map(([key, row]) => [key, row.value]))
      );
    } catch {
      return { networkUncertain: true, ok: false };
    }
  }
  async function readSavedValues() {
    try {
      return await io.read();
    } catch {
      // Keep the draft unresolved until a later read confirms saved values.
    }
  }
  function reconcileNewerDraft(
    key: ResourceField,
    row: FieldState,
    installed: boolean,
    uncertain: boolean | undefined,
    current: ResourceValues | undefined
  ) {
    if (uncertain || (installed && !current)) {
      draft[key] = {
        ...row,
        message:
          'The earlier save needs reconciliation. Your newer draft is kept; refresh saved values before retrying.',
        state: 'error',
      };
    }
  }
  function applySubmittedDraft(
    key: ResourceField,
    row: FieldState,
    outcome: Outcome,
    installed: boolean,
    uncertain: boolean | undefined,
    current: ResourceValues | undefined
  ) {
    if (installed && current && !uncertain) {
      draft[key] = {
        ...row,
        message: outcome.warning
          ? 'Saved; durability could not be confirmed.'
          : undefined,
        state: 'saved',
        text: String(current[key]),
      };
    } else {
      draft[key] = {
        ...row,
        message: unsuccessfulSaveMessage(uncertain, installed, outcome.error),
        state: 'error',
      };
    }
  }
  function applyBatchOutcome(
    batch: Map<ResourceField, QueuedResource>,
    outcome: Outcome,
    installed: boolean,
    uncertain: boolean | undefined,
    current: ResourceValues | undefined
  ) {
    if (current) {
      saved = { ...current };
    }
    for (const [key, submitted] of batch) {
      const row = draft[key];
      if (row.version !== submitted.version) {
        reconcileNewerDraft(key, row, installed, uncertain, current);
        continue;
      }
      applySubmittedDraft(key, row, outcome, installed, uncertain, current);
    }
  }
  function finishFlush(needsRefresh: boolean | undefined) {
    if (needsRefresh) {
      queued.clear();
      needsReconcile = true;
    }
    active.clear();
    busy = false;
    emit();
    if (queued.size) {
      flush();
    } else {
      resolveIdle();
    }
  }
  async function flush() {
    if (busy || stopped || !queued.size) {
      return;
    }
    busy = true;
    const batch = beginBatch();
    const outcome = await writeBatch(batch);
    if (stopped) {
      busy = false;
      resolveIdle();
      return;
    }
    const installed = outcome.ok || outcome.committed === true;
    const uncertain =
      outcome.networkUncertain ||
      (outcome.committed === true &&
        (!outcome.ok || outcome.reconciled === false));
    let current: ResourceValues | undefined;
    if (installed || uncertain) {
      current = await readSavedValues();
    }
    applyBatchOutcome(batch, outcome, installed, uncertain, current);
    finishFlush(uncertain || (installed && !current));
  }
  return {
    discard() {
      if (busy) {
        return;
      }
      queued.clear();
      for (const field of fields) {
        draft[field] = {
          state: 'saved',
          text: String(saved[field]),
          version: draft[field].version + 1,
        };
      }
      emit();
    },
    edit(field: ResourceField, text: string) {
      const wasSaving = busy && active.has(field);
      draft[field] = {
        state: text === String(saved[field]) ? 'saved' : 'dirty',
        text,
        version: draft[field].version + 1,
      };
      emit();
      if (wasSaving) {
        queue(field);
      }
    },
    get: () => draft,
    save: queue,
    async saveAll() {
      if (needsReconcile) {
        await reconcile();
        return false;
      }
      for (const field of fields) {
        queue(field);
      }
      if (busy) {
        await new Promise<void>((resolve) => idle.push(resolve));
      }
      return (
        !needsReconcile &&
        fields.every((field) => draft[field].state === 'saved')
      );
    },
    stop() {
      stopped = true;
      queued.clear();
    },
  };
}
