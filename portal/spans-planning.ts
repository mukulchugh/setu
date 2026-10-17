export interface SpansWorkflowPlaceholder {
  description: string;
  maxLength: number;
  name: string;
}

export interface SpansWorkflowTemplate {
  id: string;
  kind: string;
  placeholders: SpansWorkflowPlaceholder[];
  spanCount: number;
  summary: string;
  title: string;
  version: number;
}

export interface SpansWorkflowInput {
  owner: string;
  project?: string;
  runId: string;
  substitutions: Record<string, string>;
  templateId: string;
  templateVersion: number;
  worktree?: string;
}

export interface SpansWorkflowPreview {
  acceptance: { requirements: string[]; spanId: string }[];
  digest: string;
  draft: {
    goal: string;
    owner: string;
    project: string | null;
    runId: string;
    spans: { dependencies: string[]; spanId: string; title: string }[];
    worktree: string | null;
  };
  ok: true;
  previewOnly: true;
  template: { id: string; kind: string; title: string; version: number };
}

export interface SpansPlanningCreated {
  generation: number;
  replayed: boolean;
  revision: number;
  runId: string;
}

const MAX_RESPONSE_BYTES = 128 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLACEHOLDER_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const RUN_STATES = new Set([
  'planned',
  'ready',
  'running',
  'waiting_for_you',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'recovery_required',
]);
const fail = (message: string): Error => new Error(message);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const boundedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
const boundedIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && IDENTIFIER.test(value);
const boundedCount = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw fail('The Spans planning request could not be completed. Try again.');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw fail('The Spans planning response was too large. Try again.');
  }
  if (!response.body) {
    throw fail('The Spans planning response was unavailable. Try again.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Read chunks sequentially to enforce the cumulative byte limit.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw fail('The Spans planning response was too large. Try again.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'The Spans planning response was too large. Try again.'
    ) {
      throw error;
    }
    await reader.cancel().catch(() => undefined);
    throw fail('The Spans planning response was unavailable. Try again.');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    // biome-ignore lint/style/useErrorCause: Parser and transport details may contain private plan text.
    throw fail('The Spans planning response was unavailable. Try again.');
  }
}

export function decodeSpansWorkflowList(
  value: unknown
): SpansWorkflowTemplate[] {
  if (
    !isObject(value) ||
    value.ok !== true ||
    !onlyKeys(value, ['ok', 'templates']) ||
    !Array.isArray(value.templates) ||
    value.templates.length > 100
  ) {
    throw fail('Spans workflows are unavailable. Try again.');
  }
  const ids = new Set<string>();
  const templates: SpansWorkflowTemplate[] = [];
  for (const raw of value.templates) {
    if (
      !(
        isObject(raw) &&
        onlyKeys(raw, [
          'id',
          'kind',
          'placeholders',
          'spanCount',
          'summary',
          'title',
          'version',
        ]) &&
        boundedIdentifier(raw.id)
      ) ||
      ids.has(raw.id) ||
      !boundedText(raw.kind, 80) ||
      !boundedText(raw.title, 160) ||
      !boundedText(raw.summary, 1000) ||
      !boundedCount(raw.version, 100_000) ||
      raw.version < 1 ||
      !boundedCount(raw.spanCount, 200) ||
      !Array.isArray(raw.placeholders) ||
      raw.placeholders.length > 100
    ) {
      throw fail('Spans workflows are unavailable. Try again.');
    }
    const names = new Set<string>();
    const placeholders: SpansWorkflowPlaceholder[] = [];
    for (const rawPlaceholder of raw.placeholders) {
      if (
        !(
          isObject(rawPlaceholder) &&
          onlyKeys(rawPlaceholder, ['description', 'maxLength', 'name'])
        ) ||
        typeof rawPlaceholder.name !== 'string' ||
        !PLACEHOLDER_NAME.test(rawPlaceholder.name) ||
        names.has(rawPlaceholder.name) ||
        !boundedText(rawPlaceholder.description, 1000) ||
        !boundedCount(rawPlaceholder.maxLength, 8000) ||
        rawPlaceholder.maxLength < 1
      ) {
        throw fail('Spans workflows are unavailable. Try again.');
      }
      names.add(rawPlaceholder.name);
      placeholders.push({
        description: rawPlaceholder.description,
        maxLength: rawPlaceholder.maxLength,
        name: rawPlaceholder.name,
      });
    }
    ids.add(raw.id);
    templates.push({
      id: raw.id,
      kind: raw.kind,
      placeholders,
      spanCount: raw.spanCount,
      summary: raw.summary,
      title: raw.title,
      version: raw.version,
    });
  }
  return templates;
}

function validatePreviewDependencies(
  dependenciesBySpan: Map<string, string[]>,
  spanIds: Set<string>
) {
  for (const [spanId, dependencies] of dependenciesBySpan) {
    if (
      new Set(dependencies).size !== dependencies.length ||
      dependencies.some(
        (dependency) => dependency === spanId || !spanIds.has(dependency)
      )
    ) {
      throw fail(
        'Spans preview is unavailable. Review the fields and try again.'
      );
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (spanId: string): boolean => {
    if (visiting.has(spanId)) {
      return true;
    }
    if (visited.has(spanId)) {
      return false;
    }
    visiting.add(spanId);
    for (const dependency of dependenciesBySpan.get(spanId) ?? []) {
      if (hasCycle(dependency)) {
        return true;
      }
    }
    visiting.delete(spanId);
    visited.add(spanId);
    return false;
  };
  if ([...spanIds].some(hasCycle)) {
    throw fail(
      'Spans preview is unavailable. Review the fields and try again.'
    );
  }
}

export function decodeSpansWorkflowPreview(
  value: unknown,
  input: SpansWorkflowInput
): SpansWorkflowPreview {
  if (
    !isObject(value) ||
    value.ok !== true ||
    value.previewOnly !== true ||
    !onlyKeys(value, [
      'acceptance',
      'digest',
      'draft',
      'ok',
      'previewOnly',
      'template',
    ]) ||
    typeof value.digest !== 'string' ||
    !DIGEST.test(value.digest) ||
    !isObject(value.draft) ||
    !onlyKeys(value.draft, [
      'goal',
      'owner',
      'project',
      'runId',
      'spans',
      'worktree',
    ]) ||
    value.draft.runId !== input.runId ||
    !boundedText(value.draft.goal, 8000) ||
    !boundedText(value.draft.owner, 64) ||
    !(value.draft.project === null || boundedText(value.draft.project, 128)) ||
    !(
      value.draft.worktree === null || boundedText(value.draft.worktree, 1024)
    ) ||
    !Array.isArray(value.draft.spans) ||
    value.draft.spans.length > 200 ||
    !Array.isArray(value.acceptance) ||
    value.acceptance.length > 200 ||
    !isObject(value.template) ||
    !onlyKeys(value.template, ['id', 'kind', 'title', 'version']) ||
    value.template.id !== input.templateId ||
    value.template.version !== input.templateVersion ||
    !boundedText(value.template.kind, 80) ||
    !boundedText(value.template.title, 160)
  ) {
    throw fail(
      'Spans preview is unavailable. Review the fields and try again.'
    );
  }
  const spanIds = new Set<string>();
  const dependenciesBySpan = new Map<string, string[]>();
  const spans: SpansWorkflowPreview['draft']['spans'] = [];
  for (const rawSpan of value.draft.spans) {
    if (
      !(
        isObject(rawSpan) &&
        onlyKeys(rawSpan, ['dependencies', 'spanId', 'title']) &&
        boundedIdentifier(rawSpan.spanId)
      ) ||
      spanIds.has(rawSpan.spanId) ||
      !boundedText(rawSpan.title, 1000) ||
      !Array.isArray(rawSpan.dependencies) ||
      rawSpan.dependencies.length > 200 ||
      !rawSpan.dependencies.every(boundedIdentifier)
    ) {
      throw fail(
        'Spans preview is unavailable. Review the fields and try again.'
      );
    }
    spanIds.add(rawSpan.spanId);
    dependenciesBySpan.set(rawSpan.spanId, [...rawSpan.dependencies]);
    spans.push({
      dependencies: [...rawSpan.dependencies],
      spanId: rawSpan.spanId,
      title: rawSpan.title,
    });
  }
  validatePreviewDependencies(dependenciesBySpan, spanIds);
  const acceptance: SpansWorkflowPreview['acceptance'] = [];
  const acceptedSpanIds = new Set<string>();
  for (const rawAcceptance of value.acceptance) {
    if (
      !(
        isObject(rawAcceptance) &&
        onlyKeys(rawAcceptance, ['requirements', 'spanId']) &&
        boundedIdentifier(rawAcceptance.spanId) &&
        spanIds.has(rawAcceptance.spanId)
      ) ||
      acceptedSpanIds.has(rawAcceptance.spanId) ||
      !Array.isArray(rawAcceptance.requirements) ||
      rawAcceptance.requirements.length > 100 ||
      !rawAcceptance.requirements.every((item) => boundedText(item, 4000))
    ) {
      throw fail(
        'Spans preview is unavailable. Review the fields and try again.'
      );
    }
    acceptedSpanIds.add(rawAcceptance.spanId);
    acceptance.push({
      requirements: [...rawAcceptance.requirements],
      spanId: rawAcceptance.spanId,
    });
  }
  if (
    acceptance.length !== spans.length ||
    acceptedSpanIds.size !== spanIds.size
  ) {
    throw fail(
      'Spans preview is unavailable. Review the fields and try again.'
    );
  }
  return {
    acceptance,
    digest: value.digest,
    draft: {
      goal: value.draft.goal,
      owner: value.draft.owner,
      project: value.draft.project,
      runId: value.draft.runId,
      spans,
      worktree: value.draft.worktree,
    },
    ok: true,
    previewOnly: true,
    template: {
      id: value.template.id,
      kind: value.template.kind,
      title: value.template.title,
      version: value.template.version,
    },
  };
}

export function decodeSpansPlanningCreated(
  value: unknown,
  runId: string
): SpansPlanningCreated {
  if (
    !isObject(value) ||
    value.ok !== true ||
    !onlyKeys(value, ['generation', 'ok', 'replayed', 'revision', 'run']) ||
    (value.generation !== undefined &&
      !boundedCount(value.generation, Number.MAX_SAFE_INTEGER)) ||
    !boundedCount(value.revision, Number.MAX_SAFE_INTEGER) ||
    value.revision < 1 ||
    typeof value.replayed !== 'boolean' ||
    !isObject(value.run) ||
    value.run.runId !== runId ||
    !boundedCount(value.run.generation, Number.MAX_SAFE_INTEGER) ||
    typeof value.run.state !== 'string' ||
    !RUN_STATES.has(value.run.state) ||
    !boundedCount(value.run.planVersion, Number.MAX_SAFE_INTEGER) ||
    value.run.planVersion < 1 ||
    (!value.replayed &&
      (value.run.state !== 'planned' || value.run.planVersion !== 1)) ||
    (value.generation !== undefined &&
      value.run.generation !== value.generation)
  ) {
    throw fail(
      'The planned draft could not be confirmed. Retry this exact save.'
    );
  }
  return {
    generation: value.run.generation,
    replayed: value.replayed,
    revision: value.revision,
    runId,
  };
}

// Captures the accepted fields once. Empty optional targets are omitted, as
// required by the API; preview output never participates in request creation.
export function serializeSpansWorkflowInput(
  input: SpansWorkflowInput
): SpansWorkflowInput {
  return {
    owner: input.owner,
    ...(input.project ? { project: input.project } : {}),
    runId: input.runId,
    substitutions: { ...input.substitutions },
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    ...(input.worktree ? { worktree: input.worktree } : {}),
  };
}

export function serializeSpansWorkflowCreate(
  input: SpansWorkflowInput,
  digest: string
): string {
  return JSON.stringify({ ...serializeSpansWorkflowInput(input), digest });
}

async function post(
  path: string,
  body: string,
  signal?: AbortSignal
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      body,
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    });
  } catch {
    // biome-ignore lint/style/useErrorCause: Parser and transport details may contain private plan text.
    throw fail('The Spans planning request may not have completed. Try again.');
  }
  return readJson(response);
}

export async function listSpansPlanningWorkflows(
  signal?: AbortSignal
): Promise<SpansWorkflowTemplate[]> {
  let response: Response;
  try {
    response = await fetch('/api/spans/workflows', { signal });
  } catch {
    // biome-ignore lint/style/useErrorCause: Parser and transport details may contain private plan text.
    throw fail('Spans workflows are unavailable. Try again.');
  }
  return decodeSpansWorkflowList(await readJson(response));
}

export async function previewSpansPlanningWorkflow(
  input: SpansWorkflowInput,
  signal?: AbortSignal
): Promise<SpansWorkflowPreview> {
  return decodeSpansWorkflowPreview(
    await post('/api/spans/workflows/preview', JSON.stringify(input), signal),
    input
  );
}

export async function createSpansPlanningDraft(
  input: SpansWorkflowInput,
  digest: string
): Promise<SpansPlanningCreated> {
  const value = await post(
    '/api/spans/workflows/create',
    serializeSpansWorkflowCreate(input, digest)
  );
  return decodeSpansPlanningCreated(value, input.runId);
}

// Every newer request aborts its predecessor. Tickets also fence responses
// from transports that ignore AbortSignal or settle after cancellation.
export function createSpansRequestGuard() {
  let generation = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      generation += 1;
      const ticket = generation;
      return { signal: controller.signal, ticket };
    },
    invalidate() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
    isCurrent(ticket: number) {
      return ticket === generation && controller !== null;
    },
  };
}
