import { useEffect, useRef, useState } from 'preact/hooks';
import {
  groupLinksMessages,
  type SpanChoice,
  WHOLE_RUN_CHOICES,
} from '../links-history';
import type {
  SpansArtifactResult,
  SpansEvent,
  SpansJson,
} from '../spans-types';
import { Section } from '../ui';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  LinksMessageItem,
  LinksProjectionNotice,
  LinksStatusOnlyItem,
} from './links-history';

interface ArtifactSelection {
  artifactId: string;
  request: number;
  result: SpansArtifactResult | null;
  runId: string;
}

const ARTIFACT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

function record(value: SpansJson): Record<string, SpansJson> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function printable(value: SpansJson | undefined): string {
  if (value === undefined) {
    return 'Unknown';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function textValue(value: SpansJson | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readableType(type: string): string {
  return type
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function Coverage({ value }: { value: SpansJson | undefined }) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return (
    <p class="mt-2 break-words text-xs text-zinc-600 dark:text-zinc-300">
      Coverage: {typeof value === 'string' ? value : printable(value)}
    </p>
  );
}

function JsonDisclosure({ label, value }: { label: string; value: SpansJson }) {
  return (
    <details class="mt-2 min-w-0 text-sm">
      <summary class="min-h-11 cursor-pointer py-2 text-zinc-700 dark:text-zinc-200">
        {label}
      </summary>
      <pre class="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-none bg-zinc-100 p-3 text-xs text-zinc-800 dark:bg-black/20 dark:text-zinc-200">
        {printable(value)}
      </pre>
    </details>
  );
}

function MessageArtifact({ text }: { text: string }) {
  let parsed: SpansJson;
  try {
    parsed = JSON.parse(text) as SpansJson;
  } catch {
    return (
      <p class="mt-3 text-signal-red text-sm" role="status">
        The saved message artifact is not valid JSON.
      </p>
    );
  }
  const message = record(parsed);
  if (!message) {
    return (
      <p class="mt-3 text-signal-red text-sm" role="status">
        The saved message artifact has an unsupported shape.
      </p>
    );
  }

  const {
    coverage,
    contentBlocks,
    metadata,
    role: rawRole,
    text: messageText,
  } = message;
  const role = textValue(rawRole, 'Message');
  const blocks = Array.isArray(contentBlocks) ? contentBlocks : null;

  return (
    <div class="mt-3 min-w-0 border-zinc-200 border-t pt-3 dark:border-white/10">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <h4 class="font-semibold text-zinc-900 dark:text-zinc-100">{role}</h4>
        <Coverage value={coverage} />
      </div>
      {(!blocks || blocks.length === 0) &&
        typeof messageText === 'string' &&
        messageText.length > 0 && (
          <pre class="mt-2 max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-words text-sm text-zinc-800 dark:text-zinc-200">
            {messageText}
          </pre>
        )}
      {blocks && (
        <div class="mt-2 space-y-1">
          {blocks.map((rawBlock, index) => {
            const block = record(rawBlock);
            if (!block) {
              return (
                <JsonDisclosure
                  key={index}
                  label={`Content block ${index + 1} (unrecognized)`}
                  value={rawBlock}
                />
              );
            }
            const kind = textValue(block.kind, 'unknown');
            if (kind === 'text') {
              return (
                <div class="min-w-0" key={index}>
                  {typeof block.text === 'string' && (
                    <pre class="max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-words text-sm text-zinc-800 dark:text-zinc-200">
                      {block.text}
                    </pre>
                  )}
                  {block.metadata !== undefined && (
                    <JsonDisclosure
                      label="Text block metadata"
                      value={block.metadata}
                    />
                  )}
                </div>
              );
            }
            const label = contentLabel(kind);
            const detail = block.data ?? block;
            return <JsonDisclosure key={index} label={label} value={detail} />;
          })}
        </div>
      )}
      {(!blocks || blocks.length === 0) && typeof messageText !== 'string' && (
        <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          This message has no displayable text or content blocks.
        </p>
      )}
      {metadata !== undefined && (
        <JsonDisclosure
          label="Citation and message metadata"
          value={metadata}
        />
      )}
    </div>
  );
}

function contentLabel(kind: string): string {
  if (kind === 'tool') {
    return 'Tool details';
  }
  if (kind === 'attachment') {
    return 'Attachment details';
  }
  if (kind === 'opaque') {
    return 'Unparsed content';
  }
  return `${readableType(kind)} details`;
}

function ArtifactContent({
  artifactId,
  result,
  runId,
}: {
  artifactId: string;
  result: SpansArtifactResult | null;
  runId: string;
}) {
  if (result === null) {
    return (
      <p class="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
        Loading saved message…
      </p>
    );
  }
  if (!result.ok) {
    return (
      <p class="mt-3 text-signal-red text-sm" role="status">
        Could not read this message: {result.error}
      </p>
    );
  }
  if (result.runId !== runId || result.artifactId !== artifactId) {
    return (
      <p class="mt-3 text-signal-red text-sm" role="status">
        The returned artifact did not match the selected message.
      </p>
    );
  }
  return <MessageArtifact text={result.text} />;
}

function MessageEventContent({
  artifactId,
  loading,
  onDismissArtifact,
  onOpenArtifact,
  payload,
  runId,
  selection,
}: {
  artifactId: string;
  loading: boolean;
  onDismissArtifact: () => void;
  onOpenArtifact: (artifactId: string) => void;
  payload: Record<string, SpansJson> | null;
  runId: string;
  selection: ArtifactSelection | null;
}) {
  const selected = selection?.artifactId === artifactId;
  const validArtifactId = ARTIFACT_ID_PATTERN.test(artifactId);
  const summary = textValue(payload?.summary);

  return (
    <div class="mt-2 min-w-0">
      <p class="break-words text-sm text-zinc-800 dark:text-zinc-200">
        {summary || 'Message summary unavailable.'}
      </p>
      {typeof payload?.nativeId === 'string' && (
        <p class="mt-1 break-all font-mono text-xs text-zinc-600 dark:text-zinc-300">
          Source message ID: {payload.nativeId}
        </p>
      )}
      <Coverage value={payload?.coverage} />
      {validArtifactId ? (
        <div class="mt-2">
          <Button
            aria-expanded={selected}
            compact
            disabled={loading || (!selected && selection?.result === null)}
            onClick={() => {
              if (selected) {
                onDismissArtifact();
              } else {
                onOpenArtifact(artifactId);
              }
            }}
            variant="secondary"
          >
            {selected ? 'Close full message' : 'View full message'}
          </Button>
          {selected && (
            <div aria-live="polite" class="min-w-0">
              <ArtifactContent
                artifactId={artifactId}
                result={selection?.result ?? null}
                runId={runId}
              />
            </div>
          )}
        </div>
      ) : (
        <p class="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
          Full message unavailable: no valid saved artifact reference.
        </p>
      )}
    </div>
  );
}

function eventReason(payload: Record<string, SpansJson> | null): string {
  const reason =
    payload?.coverageReason ?? payload?.reason ?? payload?.coverage;
  if (reason === undefined) {
    return 'reason not recorded';
  }
  return typeof reason === 'string' ? reason : printable(reason);
}

function CoverageGapContent({
  event,
  payload,
}: {
  event: SpansEvent;
  payload: Record<string, SpansJson> | null;
}) {
  return (
    <div class="mt-2 min-w-0 text-sm text-zinc-800 dark:text-zinc-200">
      <p>Source coverage gap: {eventReason(payload)}.</p>
      {payload && (
        <JsonDisclosure label="Coverage details" value={event.payload} />
      )}
    </div>
  );
}

function OtherEventContent({
  event,
  payload,
}: {
  event: SpansEvent;
  payload: Record<string, SpansJson> | null;
}) {
  const summary = textValue(payload?.summary);
  return (
    <div class="mt-2 min-w-0">
      <p class="text-sm text-zinc-700 dark:text-zinc-300">
        {summary || `${readableType(event.type)} event`}
      </p>
      <JsonDisclosure label="Event details" value={event.payload} />
    </div>
  );
}

function ConversationEvent({
  event,
  loading,
  onDismissArtifact,
  onOpenArtifact,
  runId,
  selection,
}: {
  event: SpansEvent;
  loading: boolean;
  onDismissArtifact: () => void;
  onOpenArtifact: (artifactId: string) => void;
  runId: string;
  selection: ArtifactSelection | null;
}) {
  const payload = record(event.payload);
  const messageEvent = event.type === 'source.message';
  const gapEvent = event.type === 'source.gap';
  let tone: 'amber' | 'emerald' | 'zinc' = 'zinc';
  if (gapEvent) {
    tone = 'amber';
  } else if (messageEvent) {
    tone = 'emerald';
  }
  const artifactId = textValue(payload?.artifactId);

  return (
    <li
      class="min-w-0 py-3 first:pt-0 last:pb-0"
      key={`${event.sequence}:${event.eventId}`}
    >
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <Badge tone={tone}>{readableType(event.type)}</Badge>
        <span class="board-mono text-xs text-zinc-600 dark:text-zinc-300">
          Sequence {event.sequence}
        </span>
      </div>
      {messageEvent && (
        <MessageEventContent
          artifactId={artifactId}
          loading={loading}
          onDismissArtifact={onDismissArtifact}
          onOpenArtifact={onOpenArtifact}
          payload={payload}
          runId={runId}
          selection={selection}
        />
      )}
      {gapEvent && <CoverageGapContent event={event} payload={payload} />}
      {!(messageEvent || gapEvent) && (
        <OtherEventContent event={event} payload={payload} />
      )}
    </li>
  );
}

export function SpansConversation({
  runId,
  events,
  loading,
  error,
  stale,
  hasMore,
  historyMore = false,
  onLinksChanged,
  onLoadMore,
  readArtifact,
  spanChoices = WHOLE_RUN_CHOICES,
}: {
  runId: string;
  events: SpansEvent[];
  loading: boolean;
  error: string | null;
  stale: boolean;
  hasMore: boolean;
  /** More history pages follow this one (separate from the Load more button). */
  historyMore?: boolean;
  onLinksChanged?: () => void;
  onLoadMore: () => void;
  readArtifact: (input: {
    runId: string;
    artifactId: string;
  }) => Promise<SpansArtifactResult>;
  spanChoices?: SpanChoice[];
}) {
  const [selection, setSelection] = useState<ArtifactSelection | null>(null);
  const requestGeneration = useRef(0);
  const currentRun = useRef(runId);
  const mounted = useRef(false);

  // Fence late artifact replies as soon as the selected run changes.
  if (currentRun.current !== runId) {
    currentRun.current = runId;
    requestGeneration.current += 1;
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, []);
  useEffect(() => {
    setSelection(null);
  }, [runId]);

  const runEvents = events.filter((event) => event.runId === runId);
  const items = groupLinksMessages(runEvents, { more: historyMore });
  const now = Date.now();
  const visibleSelection = selection?.runId === runId ? selection : null;
  async function openArtifact(artifactId: string) {
    if (!ARTIFACT_ID_PATTERN.test(artifactId) || loading) {
      return;
    }
    requestGeneration.current += 1;
    const request = requestGeneration.current;
    setSelection({ artifactId, request, result: null, runId });
    try {
      const result = await readArtifact({ artifactId, runId });
      if (
        mounted.current &&
        currentRun.current === runId &&
        requestGeneration.current === request
      ) {
        setSelection({ artifactId, request, result, runId });
      }
    } catch {
      if (
        mounted.current &&
        currentRun.current === runId &&
        requestGeneration.current === request
      ) {
        setSelection({
          artifactId,
          request,
          result: {
            code: 'ARTIFACT_READ_FAILED',
            error: 'Artifact read failed. Try again.',
            ok: false,
          },
          runId,
        });
      }
    }
  }

  function dismissArtifact() {
    requestGeneration.current += 1;
    setSelection(null);
  }

  return (
    <Section title="Conversation and activity">
      <LinksProjectionNotice quiet runId={runId} />
      {error && (
        <p class="mb-3 text-signal-red text-sm" role="status">
          Could not load the latest conversation events.{' '}
          {runEvents.length ? 'Showing the events already received. ' : ''}
          {error}
        </p>
      )}
      {stale && (
        <p class="mb-3 text-signal-amber text-sm" role="status">
          This event history may be out of date.
        </p>
      )}
      {runEvents.length === 0 ? (
        <p class="py-3 text-sm text-zinc-600 dark:text-zinc-300">
          {loading
            ? 'Loading conversation events…'
            : 'No conversation events received.'}
        </p>
      ) : (
        <ol
          aria-label="Conversation events"
          class="max-h-[70vh] min-w-0 divide-y divide-zinc-200 overflow-auto dark:divide-white/10"
        >
          {items.map((item) => {
            if (item.kind === 'links-message') {
              return (
                <LinksMessageItem
                  choices={spanChoices}
                  key={`${item.row.sequence}:${item.row.eventId}`}
                  now={now}
                  onChanged={onLinksChanged ?? (() => undefined)}
                  row={item.row}
                  runId={runId}
                />
              );
            }
            if (item.kind === 'links-status-only') {
              return (
                <LinksStatusOnlyItem
                  entry={item.entry}
                  key={`${item.event.sequence}:${item.event.eventId}`}
                  messageId={item.messageId}
                />
              );
            }
            return (
              <ConversationEvent
                event={item.event}
                key={`${item.event.sequence}:${item.event.eventId}`}
                loading={loading}
                onDismissArtifact={dismissArtifact}
                onOpenArtifact={openArtifact}
                runId={runId}
                selection={visibleSelection}
              />
            );
          })}
        </ol>
      )}
      {hasMore && (
        <div class="mt-4">
          <Button disabled={loading} onClick={onLoadMore} variant="secondary">
            {loading ? 'Loading events…' : 'Load more events'}
          </Button>
        </div>
      )}
    </Section>
  );
}
