// Evidence pane for one Setu Spans run. It lists artifact references found in
// the events already loaded for this page and opens one artifact at a time
// through the shared reader. Artifact bodies are inert text in a <pre>: never
// HTML, never markdown, never a link. Fetches nothing on its own.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  SpansArtifactResult,
  SpansEvent,
  SpansJson,
} from '../spans-types';
import { Section } from '../ui';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

type Role = 'source' | 'outcome';
type FailureKind =
  | 'corrupt'
  | 'missing'
  | 'mismatch'
  | 'refused'
  | 'unavailable';
type ReadArtifact = (input: {
  runId: string;
  artifactId: string;
}) => Promise<SpansArtifactResult>;

interface Reference {
  id: string | null;
  role: Role;
}

interface EvidenceItem {
  artifactId: string;
  citations: { sequence: number; type: string }[];
  roles: Role[];
}

interface EvidenceIndex {
  eventCount: number;
  gaps: SpansEvent[];
  groups: [string, EvidenceItem[]][];
  invalid: number;
  items: number;
  references: number;
}

type ViewerState =
  | { status: 'loading' }
  | { kind: FailureKind; status: 'failed' }
  | { body: string; label: string; note: string | null; status: 'ready' };
type Viewer = ViewerState & { artifactId: string; runId: string };

// Canonical artifact ids only: sha256 plus 64 lowercase hex digits.
const ARTIFACT_ID = /^sha256:[0-9a-f]{64}$/;
const SOURCE_GAP = 'source.gap';
const ROLE_LABEL: Record<Role, string> = {
  outcome: 'Outcome',
  source: 'Source',
};
// Fixed copy only. The reader's own error message is never shown.
const FAILURE_COPY: Record<FailureKind, string> = {
  corrupt: 'This artifact failed its integrity check, so nothing was shown.',
  mismatch:
    'The reader returned a different run or artifact, so nothing was shown.',
  missing: 'This artifact is missing from the archive, so nothing was shown.',
  refused: 'The reader refused this artifact, so nothing was shown.',
  unavailable:
    'This evidence could not be read. Select View evidence to try again.',
};

function isRecord(
  value: SpansJson | undefined
): value is { [key: string]: SpansJson } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validArtifactId(value: SpansJson | undefined): string | null {
  return typeof value === 'string' && ARTIFACT_ID.test(value) ? value : null;
}

// Source artifact at payload.artifactId; outcome artifacts at
// payload.artifactIds. `id: null` marks a present but malformed value.
function referencesIn(event: SpansEvent): Reference[] {
  const { payload } = event;
  if (!isRecord(payload)) {
    return [];
  }
  const found: Reference[] = [];
  if (payload.artifactId !== undefined) {
    found.push({ id: validArtifactId(payload.artifactId), role: 'source' });
  }
  if (Array.isArray(payload.artifactIds)) {
    for (const id of payload.artifactIds) {
      found.push({ id: validArtifactId(id), role: 'outcome' });
    }
  }
  return found;
}

// The first event type citing an artifact owns its group.
function cite(
  items: Map<string, EvidenceItem>,
  groups: Map<string, EvidenceItem[]>,
  event: SpansEvent,
  artifactId: string,
  role: Role
) {
  let item = items.get(artifactId);
  if (!item) {
    item = { artifactId, citations: [], roles: [] };
    items.set(artifactId, item);
    const group = groups.get(event.type) ?? [];
    group.push(item);
    groups.set(event.type, group);
  }
  if (!item.roles.includes(role)) {
    item.roles.push(role);
  }
  const seen = item.citations.some(
    (c) => c.sequence === event.sequence && c.type === event.type
  );
  if (!seen) {
    item.citations.push({ sequence: event.sequence, type: event.type });
  }
}

function indexEvidence(events: SpansEvent[]): EvidenceIndex {
  const items = new Map<string, EvidenceItem>();
  const groups = new Map<string, EvidenceItem[]>();
  let eventCount = 0;
  let invalid = 0;
  let references = 0;
  // Ascending sequence keeps each citation list and each group in event order.
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  for (const event of ordered) {
    let cited = false;
    for (const { id, role } of referencesIn(event)) {
      if (id === null) {
        invalid += 1;
        continue;
      }
      references += 1;
      cited = true;
      cite(items, groups, event, id, role);
    }
    if (cited) {
      eventCount += 1;
    }
  }
  return {
    eventCount,
    gaps: ordered.filter((event) => event.type === SOURCE_GAP),
    groups: [...groups],
    invalid,
    items: items.size,
    references,
  };
}

function citedBy(item: EvidenceItem, groupType: string): string {
  return item.citations
    .map((c) =>
      c.type === groupType ? `#${c.sequence}` : `${c.type} #${c.sequence}`
    )
    .join(', ');
}

function sourceNameOf(event: SpansEvent): string {
  return isRecord(event.payload) && typeof event.payload.sourceId === 'string'
    ? event.payload.sourceId
    : '';
}

// A reader code is matched by keyword and mapped to fixed copy. Unknown codes
// fall back to "unavailable" rather than being displayed.
function failureKind(code: unknown): FailureKind {
  const normalized = String(code ?? '').toLowerCase();
  if (normalized.includes('missing') || normalized.includes('not_found')) {
    return 'missing';
  }
  if (normalized.includes('corrupt')) {
    return 'corrupt';
  }
  if (normalized.includes('refus')) {
    return 'refused';
  }
  return 'unavailable';
}

// application/json is pretty-printed when it parses; otherwise the raw text is
// shown with a note.
function readableBody(artifact: Extract<SpansArtifactResult, { ok: true }>): {
  body: string;
  label: string;
  note: string | null;
} {
  if (artifact.mediaType !== 'application/json') {
    return { body: artifact.text, label: 'Text', note: null };
  }
  try {
    return {
      body: JSON.stringify(JSON.parse(artifact.text), null, 2),
      label: 'JSON',
      note: null,
    };
  } catch {
    return {
      body: artifact.text,
      label: 'JSON',
      note: 'This artifact is not valid JSON, so the raw text is shown.',
    };
  }
}

function stateFor(
  result: SpansArtifactResult | null,
  runId: string,
  artifactId: string
): ViewerState {
  if (!result) {
    return { kind: 'unavailable', status: 'failed' };
  }
  if (!result.ok) {
    return { kind: failureKind(result.code), status: 'failed' };
  }
  // Only a reply that names this exact run and artifact may be displayed.
  if (result.runId !== runId || result.artifactId !== artifactId) {
    return { kind: 'mismatch', status: 'failed' };
  }
  return { ...readableBody(result), status: 'ready' };
}

// A thrown reader error becomes "unavailable" copy; its message is dropped.
async function loadArtifact(
  readArtifact: ReadArtifact,
  input: { runId: string; artifactId: string }
): Promise<SpansArtifactResult | null> {
  try {
    return await readArtifact(input);
  } catch {
    return null;
  }
}

export function SpansEvidence({
  runId,
  events,
  readArtifact,
  artifactId: selectedArtifactId,
  onArtifactChange,
}: {
  runId: string;
  events: SpansEvent[];
  readArtifact: ReadArtifact;
  artifactId: string | null;
  onArtifactChange: (artifactId: string | null) => void;
}) {
  // Events from any other run never contribute evidence to this one.
  const runEvents = useMemo(
    () => events.filter((event) => event.runId === runId),
    [events, runId]
  );
  const index = useMemo(() => indexEvidence(runEvents), [runEvents]);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  // Late-reply guard: only the newest request, for the run on screen, may
  // settle. `mounted` stops replies after unmount.
  const generation = useRef(0);
  const currentRun = useRef(runId);
  currentRun.current = runId;
  const mounted = useRef(true);

  useEffect(() => {
    currentRun.current = runId;
    generation.current += 1;
    setViewer(null);
  }, [runId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function settle(
    request: number,
    requestRun: string,
    artifactId: string,
    result: SpansArtifactResult | null
  ) {
    if (
      !mounted.current ||
      generation.current !== request ||
      currentRun.current !== requestRun
    ) {
      return;
    }
    setViewer({
      ...stateFor(result, requestRun, artifactId),
      artifactId,
      runId: requestRun,
    });
  }

  function view(artifactId: string) {
    if (!ARTIFACT_ID.test(artifactId)) {
      return;
    }
    generation.current += 1;
    const request = generation.current;
    setViewer({ artifactId, runId, status: 'loading' });
    loadArtifact(readArtifact, { artifactId, runId }).then((result) =>
      settle(request, runId, artifactId, result)
    );
  }

  useEffect(() => {
    if (selectedArtifactId) {
      view(selectedArtifactId);
    } else {
      generation.current += 1;
      setViewer(null);
    }
  }, [runId, selectedArtifactId]);

  function close() {
    onArtifactChange(null);
    generation.current += 1;
    setViewer(null);
  }

  // Defensive: a viewer left over from a previous run is never shown.
  const shown =
    viewer && viewer.runId === runId && viewer.artifactId === selectedArtifactId
      ? viewer
      : null;

  return (
    <Section title="Evidence">
      <p class="mb-3 text-xs text-zinc-600 dark:text-zinc-300">
        Loaded events only: {index.references} references to {index.items}{' '}
        unique artifacts across {index.eventCount} events. The full archive is
        not counted here.
      </p>
      {index.invalid > 0 && (
        <p class="mb-3 text-xs text-zinc-600 dark:text-zinc-300">
          {index.invalid} reference
          {index.invalid === 1 ? '' : 's'} did not use the sha256 artifact
          format and cannot be opened.
        </p>
      )}
      {index.gaps.length > 0 ? (
        <div class="read-notice" role="status">
          <p>
            Source coverage is unavailable for {index.gaps.length} loaded{' '}
            {index.gaps.length === 1 ? 'event' : 'events'}. Evidence from those
            sources may be incomplete.
          </p>
          <ul class="mt-1 list-disc pl-5">
            {index.gaps.map((event) => {
              const name = sourceNameOf(event);
              return (
                <li key={event.eventId}>
                  {`Event #${event.sequence}${name ? `: ${name}` : ''}`}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p class="mb-3 text-xs text-zinc-600 dark:text-zinc-300">
          No source gaps appear in the loaded events. This does not confirm the
          full archive is complete.
        </p>
      )}

      {index.groups.length > 0 ? (
        index.groups.map(([type, items]) => (
          <section class="mb-4 min-w-0" key={type}>
            <h3 class="board-mono mb-1 font-bold text-[11px] text-zinc-600 dark:text-zinc-300">
              {type}
            </h3>
            <ul class="glass-panel text-sm">
              {items.map((item) => (
                <li
                  class="flex min-w-0 flex-wrap items-center gap-2 border-zinc-200/60 border-b px-4 py-3 last:border-0 dark:border-white/10"
                  key={item.artifactId}
                >
                  <span class="min-w-0 flex-1 break-all font-mono text-xs text-zinc-700 dark:text-zinc-300">
                    {item.artifactId}
                  </span>
                  {item.roles.map((role) => (
                    <Badge key={role} tone="zinc">
                      {ROLE_LABEL[role]}
                    </Badge>
                  ))}
                  <span class="text-xs text-zinc-600 dark:text-zinc-300">
                    Cited by {citedBy(item, type)}
                  </span>
                  <Button
                    aria-label={`View evidence ${item.artifactId}`}
                    compact
                    onClick={() => {
                      if (selectedArtifactId === item.artifactId) {
                        view(item.artifactId);
                      } else {
                        onArtifactChange(item.artifactId);
                      }
                    }}
                    variant="secondary"
                  >
                    View evidence
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))
      ) : (
        <p class="empty-state">
          {runEvents.length > 0
            ? 'No evidence references in the loaded events.'
            : 'No events are loaded for this run.'}
        </p>
      )}

      {shown && (
        <div class="mt-4 min-w-0 border-zinc-200/60 border-t pt-4 dark:border-white/10">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p class="min-w-0 break-all font-mono text-xs text-zinc-700 dark:text-zinc-300">
              {shown.artifactId}
            </p>
            <Button compact onClick={close} variant="secondary">
              Close evidence
            </Button>
          </div>
          {shown.status === 'loading' && (
            <p class="empty-state" role="status">
              Loading evidence…
            </p>
          )}
          {shown.status === 'failed' && (
            <p class="read-notice" role="status">
              {FAILURE_COPY[shown.kind]}
            </p>
          )}
          {shown.status === 'ready' && (
            <>
              {shown.note && (
                <p class="mb-2 text-xs text-zinc-600 dark:text-zinc-300">
                  {shown.note}
                </p>
              )}
              <div class="mb-2">
                <Badge tone="zinc">{shown.label}</Badge>
              </div>
              <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words border border-zinc-200/60 p-3 font-mono text-xs text-zinc-800 dark:border-white/10 dark:text-zinc-200">
                {shown.body}
              </pre>
            </>
          )}
        </div>
      )}
    </Section>
  );
}
