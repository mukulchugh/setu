export const SPANS_INTEGRATION_CLIENTS = ['claude', 'codex', 'cursor'] as const;

export type SpansIntegrationClient = (typeof SPANS_INTEGRATION_CLIENTS)[number];
export type SpansIntegrationEvidence = boolean | 'unknown';

export interface SpansIntegrationOperation {
  client: SpansIntegrationClient;
  consumers?: SpansIntegrationClient[];
  digest?: string;
  kind: 'install' | 'update' | 'remove' | 'no-op';
  path: string;
  version?: string;
}

export interface SpansIntegrationConflict {
  client?: SpansIntegrationClient;
  code: string;
  path?: string;
}

export interface SpansIntegrationClientStatus {
  client: SpansIntegrationClient;
  connected: SpansIntegrationEvidence;
  freshSession: SpansIntegrationEvidence;
  installed: SpansIntegrationEvidence;
  ownership?: string | null;
  skillActivated: SpansIntegrationEvidence;
}

export interface SpansClientIntegrationsSummary {
  clients: SpansIntegrationClient[];
  conflicts: SpansIntegrationConflict[];
  groupDigest: string;
  operations: SpansIntegrationOperation[];
  previewDigest: string;
  ready: boolean;
  sharedArtifactRemoval?: {
    affectedClients: SpansIntegrationClient[];
    path: string;
  };
  sourceDigest: string;
  statuses: SpansIntegrationClientStatus[];
}

export interface SpansClientIntegrationsReview {
  expiresAt?: string;
  phrase?: string;
  reviewId?: string;
  summary: SpansClientIntegrationsSummary;
}

export interface SpansClientIntegrationsAppliedOperation {
  client: SpansIntegrationClient;
  digest?: string;
  operationId?: string;
  path: string;
  status: string;
}

export interface SpansClientIntegrationsApplyResult {
  applied: SpansClientIntegrationsAppliedOperation[];
  idempotent: boolean;
}

export interface SpansClientIntegrationsReconciledOperation {
  operationId: string;
  status: 'already-settled' | 'applied' | 'conflict' | 'removed' | 'unknown';
}

export interface SpansClientIntegrationsReconcileResult {
  reconciled: SpansClientIntegrationsReconciledOperation[];
  summary: SpansClientIntegrationsSummary;
}

export interface SpansClientIntegrationsFailure {
  code: string;
  kind: 'server' | 'transport';
  ok: false;
  unknown: boolean;
}

export type SpansClientIntegrationsResult<T> =
  | ({ ok: true } & T)
  | SpansClientIntegrationsFailure;

export type SpansClientIntegrationsReviewSelection =
  | Record<string, never>
  | {
      clients: readonly ['codex', 'cursor'];
      removeSharedArtifact: true;
    };

export interface SpansClientIntegrationsTransport {
  apply: (input: {
    response: string;
    reviewId: string;
  }) => Promise<
    SpansClientIntegrationsResult<SpansClientIntegrationsApplyResult>
  >;
  getStatus: () => Promise<
    SpansClientIntegrationsResult<{
      summary: SpansClientIntegrationsSummary;
    }>
  >;
  reconcile: () => Promise<
    SpansClientIntegrationsResult<{
      reconciled: SpansClientIntegrationsReconciledOperation[];
      summary: SpansClientIntegrationsSummary;
    }>
  >;
  review: (
    selection?: SpansClientIntegrationsReviewSelection
  ) => Promise<SpansClientIntegrationsResult<SpansClientIntegrationsReview>>;
}

type JsonRecord = Record<string, unknown>;
type FetchLike = typeof fetch;
type ResponseParser<T> = (value: JsonRecord) => T | null;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REVIEW_ID_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,128}$/;
const RECONCILIATION_STATUSES = [
  'already-settled',
  'applied',
  'conflict',
  'removed',
  'unknown',
] as const;
const MAX_PATH_LENGTH = 4096;
const MAX_TEXT_LENGTH = 1024;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isClient(value: unknown): value is SpansIntegrationClient {
  return (
    typeof value === 'string' &&
    SPANS_INTEGRATION_CLIENTS.includes(value as SpansIntegrationClient)
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function isEvidence(value: unknown): value is SpansIntegrationEvidence {
  return typeof value === 'boolean' || value === 'unknown';
}

function boundedString(
  value: unknown,
  maxLength = MAX_TEXT_LENGTH
): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maxLength
  );
}

function isReconciliationStatus(
  value: unknown
): value is SpansClientIntegrationsReconciledOperation['status'] {
  return (
    typeof value === 'string' &&
    RECONCILIATION_STATUSES.includes(
      value as SpansClientIntegrationsReconciledOperation['status']
    )
  );
}

function parseOperation(value: unknown): SpansIntegrationOperation | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !(
      isClient(value.client) &&
      ['install', 'update', 'remove', 'no-op'].includes(String(value.kind)) &&
      boundedString(value.path, MAX_PATH_LENGTH)
    ) ||
    (value.digest !== undefined && !isDigest(value.digest)) ||
    (value.version !== undefined && !boundedString(value.version, 128)) ||
    (value.consumers !== undefined &&
      (!Array.isArray(value.consumers) ||
        value.consumers.length > SPANS_INTEGRATION_CLIENTS.length ||
        !value.consumers.every(isClient)))
  ) {
    return null;
  }
  return {
    client: value.client,
    ...(value.consumers
      ? { consumers: [...value.consumers] as SpansIntegrationClient[] }
      : {}),
    ...(value.digest ? { digest: value.digest } : {}),
    kind: value.kind as SpansIntegrationOperation['kind'],
    path: value.path,
    ...(value.version ? { version: value.version } : {}),
  };
}

function parseConflict(value: unknown): SpansIntegrationConflict | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !boundedString(value.code, 128) ||
    (value.client !== undefined && !isClient(value.client)) ||
    (value.path !== undefined && !boundedString(value.path, MAX_PATH_LENGTH))
  ) {
    return null;
  }
  return {
    ...(value.client ? { client: value.client } : {}),
    code: value.code,
    ...(value.path ? { path: value.path } : {}),
  };
}

function parseClientStatus(
  value: unknown
): SpansIntegrationClientStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !(
      isClient(value.client) &&
      isEvidence(value.installed) &&
      isEvidence(value.connected) &&
      isEvidence(value.freshSession) &&
      isEvidence(value.skillActivated)
    ) ||
    (value.ownership !== undefined &&
      value.ownership !== null &&
      !boundedString(value.ownership, 128))
  ) {
    return null;
  }
  return {
    client: value.client,
    connected: value.connected,
    freshSession: value.freshSession,
    installed: value.installed,
    ...(value.ownership === undefined
      ? {}
      : { ownership: value.ownership as string | null }),
    skillActivated: value.skillActivated,
  };
}

function parseSharedArtifactRemoval(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !(
      boundedString(value.path, MAX_PATH_LENGTH) &&
      Array.isArray(value.affectedClients)
    ) ||
    value.affectedClients.length > SPANS_INTEGRATION_CLIENTS.length ||
    !value.affectedClients.every(isClient)
  ) {
    return null;
  }
  return {
    affectedClients: [...value.affectedClients] as SpansIntegrationClient[],
    path: value.path,
  };
}

export function parseSpansClientIntegrationsSummary(
  value: unknown
): SpansClientIntegrationsSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const sharedArtifactRemoval =
    value.sharedArtifactRemoval === undefined
      ? undefined
      : parseSharedArtifactRemoval(value.sharedArtifactRemoval);
  if (
    typeof value.ready !== 'boolean' ||
    !isDigest(value.groupDigest) ||
    !isDigest(value.previewDigest) ||
    !isDigest(value.sourceDigest) ||
    !Array.isArray(value.clients) ||
    value.clients.length < 1 ||
    value.clients.length > SPANS_INTEGRATION_CLIENTS.length ||
    !value.clients.every(isClient) ||
    new Set(value.clients).size !== value.clients.length ||
    !Array.isArray(value.operations) ||
    value.operations.length > 64 ||
    !Array.isArray(value.conflicts) ||
    value.conflicts.length > 64 ||
    !Array.isArray(value.statuses) ||
    value.statuses.length > SPANS_INTEGRATION_CLIENTS.length ||
    (value.sharedArtifactRemoval !== undefined && !sharedArtifactRemoval)
  ) {
    return null;
  }
  const operations = value.operations.map(parseOperation);
  const conflicts = value.conflicts.map(parseConflict);
  const statuses = value.statuses.map(parseClientStatus);
  if (
    operations.some((row) => row === null) ||
    conflicts.some((row) => row === null) ||
    statuses.some((row) => row === null)
  ) {
    return null;
  }
  return {
    clients: [...value.clients] as SpansIntegrationClient[],
    conflicts: conflicts as SpansIntegrationConflict[],
    groupDigest: value.groupDigest,
    operations: operations as SpansIntegrationOperation[],
    previewDigest: value.previewDigest,
    ready: value.ready,
    ...(sharedArtifactRemoval ? { sharedArtifactRemoval } : {}),
    sourceDigest: value.sourceDigest,
    statuses: statuses as SpansIntegrationClientStatus[],
  };
}

function parseSummaryEnvelope(value: JsonRecord) {
  const summary = parseSpansClientIntegrationsSummary(value.summary);
  return value.ok === true && summary ? { summary } : null;
}

function parseReviewEnvelope(
  value: JsonRecord
): SpansClientIntegrationsReview | null {
  if (value.ok !== true) {
    return null;
  }
  const summary = parseSpansClientIntegrationsSummary(value.summary);
  if (!summary) {
    return null;
  }
  const hasChallenge =
    value.reviewId !== undefined ||
    value.phrase !== undefined ||
    value.expiresAt !== undefined;
  if (!hasChallenge) {
    return summary.ready ? null : { summary };
  }
  const { expiresAt, phrase, reviewId } = value;
  if (
    typeof reviewId !== 'string' ||
    !REVIEW_ID_PATTERN.test(reviewId) ||
    !boundedString(phrase, 256) ||
    !boundedString(expiresAt, 64) ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    return null;
  }
  return {
    expiresAt,
    phrase,
    reviewId,
    summary,
  };
}

function parseApplyEnvelope(
  value: JsonRecord
): SpansClientIntegrationsApplyResult | null {
  if (
    value.ok !== true ||
    typeof value.idempotent !== 'boolean' ||
    !Array.isArray(value.applied) ||
    value.applied.length > 64
  ) {
    return null;
  }
  const applied: SpansClientIntegrationsAppliedOperation[] = [];
  for (const row of value.applied) {
    if (!isRecord(row)) {
      return null;
    }
    if (
      !(
        isClient(row.client) &&
        boundedString(row.path, MAX_PATH_LENGTH) &&
        boundedString(row.status, 64)
      ) ||
      (row.digest !== undefined && !isDigest(row.digest)) ||
      (row.operationId !== undefined && !boundedString(row.operationId, 128))
    ) {
      return null;
    }
    applied.push({
      client: row.client,
      ...(row.digest ? { digest: row.digest } : {}),
      ...(row.operationId ? { operationId: row.operationId } : {}),
      path: row.path,
      status: row.status,
    });
  }
  return { applied, idempotent: value.idempotent };
}

function parseReconcileEnvelope(
  value: JsonRecord
): Pick<SpansClientIntegrationsReconcileResult, 'reconciled'> | null {
  if (
    value.ok !== true ||
    !Array.isArray(value.reconciled) ||
    value.reconciled.length > 4096
  ) {
    return null;
  }
  const reconciled: SpansClientIntegrationsReconciledOperation[] = [];
  for (const row of value.reconciled) {
    if (!isRecord(row)) {
      return null;
    }
    if (!boundedString(row.operationId, 128)) {
      return null;
    }
    if (!isReconciliationStatus(row.status)) {
      return null;
    }
    reconciled.push({ operationId: row.operationId, status: row.status });
  }
  return { reconciled };
}

function readFailure(
  value: unknown,
  status: number,
  effectMayHaveOccurred: boolean
): SpansClientIntegrationsFailure | null {
  if (!isRecord(value) || value.ok !== false) {
    return null;
  }
  return {
    code:
      boundedString(value.code, 128) && SAFE_CODE_PATTERN.test(value.code)
        ? value.code
        : 'UNKNOWN_ERROR',
    kind: 'server',
    ok: false,
    unknown: value.unknown === true || (effectMayHaveOccurred && status >= 500),
  };
}

function transportFailure(
  effectMayHaveOccurred: boolean
): SpansClientIntegrationsFailure {
  return {
    code: 'TRANSPORT_UNCERTAIN',
    kind: 'transport',
    ok: false,
    unknown: effectMayHaveOccurred,
  };
}

export function createSpansClientIntegrationsTransport(
  fetcher: FetchLike = fetch
): SpansClientIntegrationsTransport {
  async function request<T>(
    path: string,
    body: unknown,
    parser: ResponseParser<T>,
    effectMayHaveOccurred: boolean
  ): Promise<SpansClientIntegrationsResult<T>> {
    let response: Response;
    let payload: unknown;
    try {
      response = await fetcher(path, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'x-setu-source': 'ui',
        },
        method: body === undefined ? 'GET' : 'POST',
      });
      payload = await response.json();
    } catch {
      return transportFailure(effectMayHaveOccurred);
    }
    const failure = readFailure(
      payload,
      response.status,
      effectMayHaveOccurred
    );
    if (failure) {
      return failure;
    }
    if (!(response.ok && isRecord(payload))) {
      return transportFailure(effectMayHaveOccurred);
    }
    const result = parser(payload);
    return result
      ? { ok: true, ...result }
      : transportFailure(effectMayHaveOccurred);
  }

  async function reconcile() {
    const reconciliation = await request(
      '/api/spans/integrations/reconcile',
      {},
      parseReconcileEnvelope,
      true
    );
    if (!reconciliation.ok) {
      return reconciliation;
    }
    if (reconciliation.reconciled.some((row) => row.status === 'unknown')) {
      return transportFailure(true);
    }
    const statusResult = await request(
      '/api/spans/integrations',
      undefined,
      parseSummaryEnvelope,
      false
    );
    if (!statusResult.ok) {
      return { ...statusResult, unknown: true };
    }
    return {
      ok: true as const,
      reconciled: reconciliation.reconciled,
      summary: statusResult.summary,
    };
  }

  return {
    apply: ({ reviewId, response }) =>
      request(
        '/api/spans/integrations/apply',
        { response, reviewId },
        parseApplyEnvelope,
        true
      ),
    getStatus: () =>
      request(
        '/api/spans/integrations',
        undefined,
        parseSummaryEnvelope,
        false
      ),
    reconcile,
    review: (selection = {}) => {
      const body =
        'removeSharedArtifact' in selection
          ? {
              clients: ['codex', 'cursor'],
              removeSharedArtifact: true,
            }
          : {};
      return request(
        '/api/spans/integrations/review',
        body,
        parseReviewEnvelope,
        false
      );
    },
  };
}

export function isCurrentSpansIntegrationRevision(
  requestedRevision: number,
  currentRevision: number
) {
  return requestedRevision === currentRevision;
}

export function isCurrentSpansIntegrationReview(
  submittedReviewId: string,
  currentReviewId: string | null
) {
  return submittedReviewId === currentReviewId;
}

export function needsSpansIntegrationReconciliation(
  summary: SpansClientIntegrationsSummary
) {
  return summary.conflicts.some(
    ({ code }) =>
      code === 'RECONCILIATION_REQUIRED' ||
      code === 'INTEGRATION_RECONCILIATION_REQUIRED'
  );
}

export function hasUnknownSpansIntegrationApplyOutcome(
  result: SpansClientIntegrationsResult<SpansClientIntegrationsApplyResult>
) {
  return (
    !result.ok &&
    (result.unknown ||
      result.code === 'INTEGRATION_RECONCILIATION_REQUIRED' ||
      result.code === 'INTEGRATION_STATE_WRITE_UNKNOWN')
  );
}
