import type { SpansPhase } from './spans-types';

const PHASES = new Set(['all', 'past', 'live', 'planned']);
const TABS = new Set([
  'Plan',
  'Agents',
  'Conversation',
  'Evidence',
  'Recovery',
  'Resources',
  'Usage',
]);
const ARTIFACT = /^sha256:[a-f0-9]{64}$/;
const OFFSET = /^\d{1,16}$/;

export function parseSpansLocation(search: string) {
  const params = new URLSearchParams(search);
  const phase = params.get('phase') ?? 'all';
  const tab = params.get('tab') ?? 'Plan';
  const artifactId = params.get('artifact') ?? '';
  const rawAfter = params.get('after') ?? '0';
  const after = Number(rawAfter);
  return {
    after: OFFSET.test(rawAfter) && Number.isSafeInteger(after) ? after : 0,
    artifactId: ARTIFACT.test(artifactId) ? artifactId : '',
    phase: (PHASES.has(phase) ? phase : 'all') as SpansPhase,
    query: (params.get('query') ?? '').slice(0, 256),
    tab: TABS.has(tab) ? tab : 'Plan',
  };
}

export function spansLocationSearch(
  search: string,
  changes: Record<string, string | number | null>
) {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') {
      params.delete(key);
    } else {
      params.set(key, String(value));
    }
  }
  const next = params.toString();
  return next ? `?${next}` : '';
}
