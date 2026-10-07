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
export type ResourceDraft = Record<ResourceField, FieldState>;
const fields: ResourceField[] = [
  'maxConcurrentDevServers',
  'containerMemoryLimit',
  'containerCpuLimit',
];

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
    const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*(m|g)$/i);
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
  const queued = new Map<
    ResourceField,
    { text: string; version: number; value: number | string }
  >();
  const emit = () => {
    if (!stopped) {
      io.publish({ ...draft }, { ...saved });
    }
  };
  function queue(field: ResourceField) {
    if (needsReconcile) {
      void reconcile();
      return;
    }
    const row = draft[field],
      value = validateResource(field, row.text);
    if (value === null) {
      queued.delete(field);
      draft[field] = {
        ...row,
        message:
          field === 'containerMemoryLimit'
            ? 'Enter a memory limit from 64m to 1024g.'
            : field === 'maxConcurrentDevServers'
              ? 'Enter a whole number of server slots from 1 to 64.'
              : 'Enter a CPU limit from 0.01 to 1024.',
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
    void flush();
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
  async function flush() {
    if (busy || stopped || !queued.size) {
      return;
    }
    busy = true;
    const batch = new Map(queued);
    queued.clear();
    for (const [key] of batch) {
      active.add(key);
      draft[key] = { ...draft[key], message: undefined, state: 'saving' };
    }
    emit();
    let outcome: Outcome;
    try {
      outcome = await io.write(
        Object.fromEntries([...batch].map(([key, row]) => [key, row.value]))
      );
    } catch {
      outcome = { networkUncertain: true, ok: false };
    }
    if (stopped) {
      busy = false;
      for (const done of idle.splice(0)) {
        done();
      }
      return;
    }
    const installed = outcome.ok || outcome.committed === true;
    const uncertain =
      outcome.networkUncertain ||
      (outcome.committed === true &&
        (!outcome.ok || outcome.reconciled === false));
    let current: ResourceValues | undefined;
    if (installed || uncertain) {
      try {
        current = await io.read();
      } catch {
        // Keep the draft unresolved until a later read confirms saved values.
      }
    }
    if (current) {
      saved = { ...current };
    }
    for (const [key, submitted] of batch) {
      const row = draft[key];
      if (row.version !== submitted.version) {
        if (uncertain || (installed && !current)) {
          draft[key] = {
            ...row,
            message:
              'The earlier save needs reconciliation. Your newer draft is kept; refresh saved values before retrying.',
            state: 'error',
          };
        }
        continue;
      }
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
          message: uncertain
            ? 'Outcome not confirmed. Settings were refreshed if available; check the saved value before retrying.'
            : installed
              ? 'Saved, but readback failed. Retry to reconcile before another save.'
              : outcome.error || 'Could not save. Your draft is kept.',
          state: 'error',
        };
      }
    }
    if (uncertain || (installed && !current)) {
      queued.clear();
      needsReconcile = true;
    }
    active.clear();
    busy = false;
    emit();
    if (queued.size) {
      void flush();
    } else {
      for (const done of idle.splice(0)) {
        done();
      }
    }
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
