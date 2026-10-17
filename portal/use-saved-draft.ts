import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { post } from './api';
import { reconcileExplicitDraft } from './settings-draft';

// Explicit-save sections retain edits made after the submitted version.
export function useSavedDraft<T>(
  key: string,
  empty: T,
  read: (signal: AbortSignal) => Promise<T>,
  endpoint: string,
  body: (draft: T) => unknown,
  validate?: (draft: T) => string | null,
  serialize: (value: T) => string = JSON.stringify
) {
  const [draft, setDraft] = useState(empty);
  const current = useRef(empty),
    saved = useRef(empty),
    generation = useRef(0),
    editing = useRef(0);
  const inFlight = useRef(false),
    abort = useRef<AbortController | null>(null);
  const [loaded, setLoaded] = useState(false),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [message, setMessage] = useState<string | null>(null);
  const reconcileFirst = useRef(false);
  const hasLoaded = useRef(false);
  const reader = useRef(read);
  reader.current = read;
  const writer = useRef(body);
  writer.current = body;
  const validator = useRef(validate);
  validator.current = validate;
  const isDirty = () => serialize(current.current) !== serialize(saved.current);
  const update = (next: T | ((value: T) => T)) => {
    current.current =
      typeof next === 'function'
        ? (next as (value: T) => T)(current.current)
        : next;
    editing.current += 1;
    setDraft(current.current);
    setMessage(null);
  };
  const reload = useCallback(async (replace = false) => {
    if (abort.current) {
      return false;
    }
    const own = generation.current,
      version = editing.current;
    const controller = new AbortController();
    abort.current = controller;
    try {
      const value = await reader.current(controller.signal);
      if (generation.current !== own) {
        return false;
      }
      const reconciled = reconcileExplicitDraft(
        current.current,
        saved.current,
        value,
        version,
        editing.current,
        replace || !hasLoaded.current,
        serialize
      );
      saved.current = value;
      setLoaded(true);
      hasLoaded.current = true;
      setError(null);
      reconcileFirst.current = false;
      current.current = reconciled;
      setDraft(reconciled);
      return true;
    } catch {
      if (generation.current === own) {
        setLoaded(false);
        setError('Could not load saved values. Your draft is kept.');
      }
      return false;
    } finally {
      if (abort.current === controller) {
        abort.current = null;
      }
    }
  }, []);
  useEffect(() => {
    generation.current += 1;
    editing.current = 0;
    inFlight.current = false;
    setSaving(false);
    current.current = empty;
    saved.current = empty;
    setDraft(empty);
    setLoaded(false);
    hasLoaded.current = false;
    setError(null);
    setMessage(null);
    reconcileFirst.current = false;
    abort.current?.abort();
    abort.current = null;
    reload(true);
    return () => {
      generation.current += 1;
      abort.current?.abort();
      abort.current = null;
    };
  }, [key]);
  async function refreshBeforeSaveRetry() {
    await reload();
    setMessage(
      'Saved values refreshed. Review your draft before saving again.'
    );
    return false;
  }
  function rejectSave(result: Awaited<ReturnType<typeof post>>) {
    reconcileFirst.current = !!(result.networkUncertain || result.committed);
    setError(
      reconcileFirst.current
        ? 'Outcome not confirmed. Refresh saved values before trying again.'
        : result.error || 'Could not save. Your draft is kept.'
    );
    return false;
  }
  async function confirmSaved(
    submitted: T,
    version: number,
    result: Awaited<ReturnType<typeof post>>
  ) {
    saved.current = submitted;
    // A failed readback cannot erase the confirmed saved draft.
    const refreshed = await reload(editing.current === version);
    if (!refreshed) {
      reconcileFirst.current = true;
    }
    let savedMessage = 'Saved; refresh is still needed.';
    if (refreshed) {
      savedMessage = 'Saved';
    }
    if (result.warning) {
      savedMessage = 'Saved; durability could not be confirmed.';
    }
    setMessage(savedMessage);
    return !isDirty();
  }
  async function save() {
    if (inFlight.current || !loaded) {
      return false;
    }
    if (reconcileFirst.current) {
      return await refreshBeforeSaveRetry();
    }
    const invalid = validator.current?.(current.current);
    if (invalid) {
      setError(invalid);
      return false;
    }
    if (!isDirty()) {
      return true;
    }
    const own = generation.current,
      version = editing.current,
      submitted = current.current;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await post(endpoint, writer.current(submitted));
      if (generation.current !== own) {
        return false;
      }
      if (!result.ok || result.reconciled === false) {
        return rejectSave(result);
      }
      return await confirmSaved(submitted, version, result);
    } finally {
      if (generation.current === own) {
        inFlight.current = false;
        setSaving(false);
      }
    }
  }
  return {
    dirty: isDirty(),
    discard() {
      editing.current += 1;
      current.current = saved.current;
      setDraft(saved.current);
      setError(null);
    },
    draft,
    error,
    isDirty,
    loaded,
    message,
    reload: () => reload(),
    save,
    saving,
    update,
  };
}
