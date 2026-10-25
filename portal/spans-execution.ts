import type { SpansRecord } from './spans-types';

export const SPANS_EXECUTION_PROFILE = 'claude-code-sonnet';
export const SPANS_EXECUTION_MAX_INSTRUCTIONS = 8000;
export const SPANS_EXECUTION_MAX_CRITERIA = 10;
export const SPANS_EXECUTION_MAX_CRITERION_CHARS = 300;
export const SPANS_EXECUTION_MAX_MINUTES = 60;

const CLIENT_HEADERS = { 'x-setu-source': 'ui' } as const;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_STATE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CRITERIA_LINE_BREAKS = /\r?\n/;
const UNKNOWN_CODE_PATTERN =
  /UNKNOWN|OUTCOME|UNAVAILABLE|STORAGE|ACTION_EXISTS|ACTION_OPEN|SPAN_BUSY|OWNED_ELSEWHERE/;
const RECOVERY_KEY_PREFIX = 'setu.spans-execution.recovery.v1:';
const CANCEL_RECOVERY_KEY_PREFIX = 'setu.spans-execution.cancel.v1:';

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  max = 4096,
  allowEmpty = false
): value is string {
  if (typeof value !== 'string' || value.length > max) {
    return false;
  }
  if (!allowEmpty && value.length === 0) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return true;
}

function boundedInstructions(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length > max || value.length === 0) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    ) {
      return false;
    }
  }
  return true;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function isAbsolutePath(value: unknown): value is string {
  return (
    boundedString(value, 4096) &&
    value.startsWith('/') &&
    !value.split('/').some((part) => part === '.' || part === '..')
  );
}

export type SpansExecutionErrorKind =
  | 'invalid'
  | 'refused'
  | 'unavailable'
  | 'unknown';

const SAFE_MESSAGES: Record<string, string> = {
  SPANS_EXEC_CAPABILITY_UNVERIFIED:
    'This profile has no fresh local probe that allows a launch.',
  SPANS_EXEC_CONFIRMATION_REQUIRED:
    'A human confirmation is required before this action.',
  SPANS_EXEC_DEPENDENCIES_INCOMPLETE:
    'Accept every dependency before starting this span.',
  SPANS_EXEC_PROFILE_UNKNOWN: 'This provider profile is not configured.',
  SPANS_EXEC_RUN_READ_ONLY: 'This run is read-only.',
  SPANS_EXEC_SPAN_COMPLETED: 'This span is already complete.',
  SPANS_EXECUTION_DISABLED: 'Spans execution is unavailable.',
  SPANS_EXECUTION_REVIEW_CHANGED:
    'The execution binding changed. Prepare a new review.',
  SPANS_EXECUTION_REVIEW_NOT_FOUND: 'The saved review was not found.',
  SPANS_EXECUTION_REVIEW_REVOKED: 'This review approval was revoked.',
  SPANS_EXECUTION_REVIEW_UNAPPROVED: 'This review has no current approval.',
};

export class SpansExecutionRequestError extends Error {
  readonly code?: string;
  readonly kind: SpansExecutionErrorKind;

  constructor(
    kind: SpansExecutionErrorKind,
    code?: string,
    options?: ErrorOptions
  ) {
    const safeMessage = code ? SAFE_MESSAGES[code] : undefined;
    let fallback = 'Spans execution is unavailable.';
    if (kind === 'unknown') {
      fallback =
        'The outcome is unknown. Inspect the saved review and execution status before acting again.';
    } else if (kind === 'refused') {
      fallback = 'Setu refused this execution request.';
    }
    super(safeMessage ?? fallback, options);
    this.name = 'SpansExecutionRequestError';
    this.code = code;
    this.kind = kind;
  }
}

export function spansExecutionErrorMessage(
  error: unknown,
  fallback = 'Spans execution is unavailable.'
): string {
  if (error instanceof SpansExecutionRequestError) {
    return error.message;
  }
  return fallback;
}

function errorKindForCode(code: string): SpansExecutionErrorKind {
  return UNKNOWN_CODE_PATTERN.test(code) ? 'unknown' : 'refused';
}

async function responseJson(response: Response): Promise<unknown | null> {
  if (!response.body) {
    return null;
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Read sequentially to enforce the cumulative response limit.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
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
    return null;
  }
}

async function requestJson(
  path: string,
  init: RequestInit,
  effect: 'read' | 'write'
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { ...CLIENT_HEADERS, ...init.headers },
    });
  } catch (cause) {
    const failure = new SpansExecutionRequestError(
      effect === 'write' ? 'unknown' : 'unavailable'
    );
    Object.defineProperty(failure, 'cause', { value: cause });
    throw failure;
  }

  const value = await responseJson(response);
  if (isRecord(value) && value.ok === false && boundedString(value.code, 128)) {
    throw new SpansExecutionRequestError(
      effect === 'write' ? errorKindForCode(value.code) : 'unavailable',
      value.code
    );
  }
  if (!response.ok || value === null) {
    throw new SpansExecutionRequestError(
      effect === 'write' ? 'unknown' : 'unavailable'
    );
  }
  return value;
}

function invalidResult(effect: 'read' | 'write'): never {
  throw new SpansExecutionRequestError(
    effect === 'write' ? 'unknown' : 'unavailable'
  );
}

function postJson(value: object): RequestInit {
  return {
    body: JSON.stringify(value),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  };
}

export interface RegisteredSpansTarget {
  branch: string | null;
  dirty: number | null;
  key: string;
  label: string;
  name: string;
  repo: string;
  wtDir: string;
}

export function decodeRegisteredSpansTargets(
  value: unknown
): RegisteredSpansTarget[] {
  if (!Array.isArray(value) || value.length > 1000) {
    throw new SpansExecutionRequestError('unavailable');
  }
  const seen = new Set<string>();
  const targets: RegisteredSpansTarget[] = [];
  for (const row of value) {
    if (
      !(
        isRecord(row) &&
        boundedString(row.repo, 256) &&
        boundedString(row.name, 256) &&
        isAbsolutePath(row.wtDir)
      )
    ) {
      throw new SpansExecutionRequestError('unavailable');
    }
    const key = `${row.repo}/${row.name}`;
    if (seen.has(key)) {
      throw new SpansExecutionRequestError('unavailable');
    }
    seen.add(key);
    targets.push({
      branch: boundedString(row.branch, 256) ? row.branch : null,
      dirty:
        Number.isSafeInteger(row.dirty) && Number(row.dirty) >= 0
          ? Number(row.dirty)
          : null,
      key,
      label: boundedString(row.label, 256) ? row.label : row.repo,
      name: row.name,
      repo: row.repo,
      wtDir: row.wtDir,
    });
  }
  return targets.sort(
    (left, right) =>
      left.repo.localeCompare(right.repo) || left.name.localeCompare(right.name)
  );
}

export async function readRegisteredSpansTargets(
  signal?: AbortSignal
): Promise<RegisteredSpansTarget[]> {
  const value = await requestJson('/api/worktrees', { signal }, 'read');
  try {
    return decodeRegisteredSpansTargets(value);
  } catch {
    return invalidResult('read');
  }
}

export interface SpansExecutionCapabilities {
  launch: {
    allowed: boolean;
    blockedBy: string[];
    unverified: string[];
  };
  observations: JsonObject | null;
  profile: string;
  reason: string | null;
}

function decodeCapabilities(
  value: unknown,
  profile: string
): SpansExecutionCapabilities {
  const launch = isRecord(value) ? value.launch : null;
  if (
    !(
      isRecord(value) &&
      value.ok === true &&
      value.profile === profile &&
      isRecord(launch) &&
      typeof launch.allowed === 'boolean' &&
      Array.isArray(launch.blockedBy) &&
      launch.blockedBy.every((item) => boundedString(item, 128)) &&
      (launch.unverified === undefined ||
        (Array.isArray(launch.unverified) &&
          launch.unverified.every((item) => boundedString(item, 128)))) &&
      (value.reason === undefined || boundedString(value.reason, 128))
    )
  ) {
    throw new SpansExecutionRequestError('unavailable');
  }
  return {
    launch: {
      allowed: launch.allowed,
      blockedBy: [...launch.blockedBy] as string[],
      unverified: Array.isArray(launch.unverified)
        ? ([...launch.unverified] as string[])
        : [],
    },
    observations: isRecord(value.observations) ? value.observations : null,
    profile,
    reason: boundedString(value.reason, 128) ? value.reason : null,
  };
}

export async function readSpansExecutionCapabilities(
  profile = SPANS_EXECUTION_PROFILE,
  signal?: AbortSignal
): Promise<SpansExecutionCapabilities> {
  const query = new URLSearchParams({ profile });
  const value = await requestJson(
    `/api/spans/execution/capabilities?${query}`,
    { signal },
    'read'
  );
  try {
    return decodeCapabilities(value, profile);
  } catch {
    return invalidResult('read');
  }
}

export interface SpansExecutionInput {
  criteria: string[];
  instructions: string;
  profile: string;
  requireChange: boolean;
  runId: string;
  spanId: string;
  target: { name: string; repo: string };
  wallClockMs: number;
}

export interface SpansExecutionSpanChoice {
  dependencies: string[];
  spanId: string;
  state: string;
  title: string;
}

export function spansExecutionRecordIsEligible(record: SpansRecord): boolean {
  const { view } = record;
  return !(
    view.readOnly === true ||
    view.imported === true ||
    view.sourceId !== undefined ||
    view.kind === 'imported' ||
    view.state === 'imported' ||
    view.state === 'completed'
  );
}

export function spansExecutionSpanChoices(
  record: SpansRecord
): SpansExecutionSpanChoice[] {
  const { view } = record;
  if (!(spansExecutionRecordIsEligible(record) && isRecord(view.spans))) {
    return [];
  }
  return Object.entries(view.spans).flatMap(([key, raw]) => {
    if (
      !(
        isRecord(raw) &&
        boundedString(raw.spanId, 128) &&
        raw.spanId === key &&
        boundedString(raw.title, 512)
      )
    ) {
      return [];
    }
    const state = boundedString(raw.state, 128) ? raw.state : 'unknown';
    if (state === 'completed') {
      return [];
    }
    return [
      {
        dependencies: Array.isArray(raw.dependencies)
          ? raw.dependencies.filter((item): item is string =>
              boundedString(item, 128)
            )
          : [],
        spanId: raw.spanId,
        state,
        title: raw.title,
      },
    ];
  });
}

export function parseSpansExecutionCriteria(
  value: string
): { error: string; criteria: [] } | { criteria: string[]; error: null } {
  const criteria = value
    .split(CRITERIA_LINE_BREAKS)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (criteria.length > SPANS_EXECUTION_MAX_CRITERIA) {
    return {
      criteria: [],
      error: `Use at most ${SPANS_EXECUTION_MAX_CRITERIA} acceptance criteria.`,
    };
  }
  if (
    criteria.some((line) => line.length > SPANS_EXECUTION_MAX_CRITERION_CHARS)
  ) {
    return {
      criteria: [],
      error: `Each acceptance criterion must be ${SPANS_EXECUTION_MAX_CRITERION_CHARS} characters or fewer.`,
    };
  }
  return { criteria, error: null };
}

export interface SpansExecutionPreview {
  confirmation: string;
  review: JsonObject;
}

function decodeReviewSummary(
  value: unknown,
  expected: Pick<SpansExecutionInput, 'runId' | 'spanId' | 'target'>
): JsonObject {
  const target = isRecord(value) ? value.target : null;
  if (
    !(
      isRecord(value) &&
      value.runId === expected.runId &&
      value.spanId === expected.spanId &&
      isRecord(target) &&
      target.repo === expected.target.repo &&
      target.name === expected.target.name
    )
  ) {
    throw new SpansExecutionRequestError('unavailable');
  }
  return value;
}

function decodePreview(
  value: unknown,
  input: SpansExecutionInput
): SpansExecutionPreview {
  if (
    !(
      isRecord(value) &&
      value.ok === true &&
      value.status === 'review' &&
      boundedString(value.confirmation, 256)
    )
  ) {
    throw new SpansExecutionRequestError('unavailable');
  }
  return {
    confirmation: value.confirmation,
    review: decodeReviewSummary(value.review, input),
  };
}

export interface SpansExecutionPreparedReview {
  binding: JsonObject;
  confirmation: string;
  executionVersion: 1;
  preview: JsonObject | null;
  reviewDigest: string;
}

export function hasReceiptDependencyBinding(
  review: SpansExecutionPreparedReview
): boolean {
  const checkout = isRecord(review.binding.checkout)
    ? review.binding.checkout
    : null;
  const expected = isRecord(checkout?.expected) ? checkout.expected : null;
  const dependency = isRecord(expected?.dependency)
    ? expected.dependency
    : null;
  return (
    dependency !== null &&
    dependency.version === 2 &&
    Object.keys(dependency).length === 3 &&
    isDigest(dependency.inputDigest) &&
    isDigest(dependency.receiptDigest)
  );
}

function decodeBinding(
  value: unknown,
  runId: string,
  reviewDigest: string,
  expected?: SpansExecutionInput,
  expectedTargetPath?: string
): JsonObject {
  const target = isRecord(value) ? value.target : null;
  const inputArtifact = isRecord(value) ? value.inputArtifact : null;
  const profile = isRecord(value) ? value.profile : null;
  const checkout = isRecord(value) ? value.checkout : null;
  const expectedCheckout = isRecord(checkout) ? checkout.expected : null;
  const expectedIdentity = isRecord(expectedCheckout)
    ? expectedCheckout.identity
    : null;
  const identity = isRecord(checkout)
    ? (checkout.wtDir ??
      (isRecord(expectedIdentity) ? expectedIdentity.checkoutPath : null))
    : null;
  if (
    !(
      isRecord(value) &&
      value.executionVersion === 1 &&
      value.runId === runId &&
      isId(value.spanId) &&
      isId(value.actionId) &&
      isId(value.attemptId) &&
      Number.isSafeInteger(value.generation) &&
      Number(value.generation) >= 0 &&
      Number.isSafeInteger(value.planVersion) &&
      Number(value.planVersion) >= 1 &&
      isRecord(target) &&
      boundedString(target.repo, 256) &&
      boundedString(target.name, 256) &&
      isRecord(inputArtifact) &&
      boundedString(inputArtifact.id, 80) &&
      inputArtifact.id === `sha256:${inputArtifact.digest}` &&
      isDigest(inputArtifact.digest) &&
      isRecord(profile) &&
      isId(profile.id) &&
      isDigest(profile.digest) &&
      isDigest(reviewDigest) &&
      (!expectedTargetPath || identity === expectedTargetPath) &&
      (!expected ||
        (value.spanId === expected.spanId &&
          target.repo === expected.target.repo &&
          target.name === expected.target.name &&
          profile.id === expected.profile))
    )
  ) {
    throw new SpansExecutionRequestError('unavailable');
  }
  return value;
}

function decodePreparedReview(
  value: unknown,
  input: SpansExecutionInput,
  expectedTargetPath?: string
): SpansExecutionPreparedReview {
  const review = isRecord(value) ? value.review : null;
  if (
    !(
      isRecord(value) &&
      value.ok === true &&
      value.status === 'prepared' &&
      isRecord(review) &&
      review.executionVersion === 1 &&
      isDigest(review.reviewDigest) &&
      boundedString(value.confirmation, 256)
    )
  ) {
    throw new SpansExecutionRequestError('unknown');
  }
  const binding = decodeBinding(
    review.binding,
    input.runId,
    review.reviewDigest,
    input,
    expectedTargetPath
  );
  const preview = decodeReviewSummary(value.preview, input);
  if (
    preview.runId !== binding.runId ||
    preview.spanId !== binding.spanId ||
    preview.generation !== binding.generation ||
    preview.planVersion !== binding.planVersion
  ) {
    throw new SpansExecutionRequestError('unknown');
  }
  return {
    binding,
    confirmation: value.confirmation,
    executionVersion: 1,
    preview,
    reviewDigest: review.reviewDigest,
  };
}

export async function readSpansExecutionSavedReview(
  runId: string,
  reviewDigest: string,
  expectedTargetPath?: string
): Promise<SpansExecutionPreparedReview> {
  const query = new URLSearchParams({ reviewDigest, runId });
  const value = await requestJson(
    `/api/spans/execution/saved-review?${query}`,
    {},
    'read'
  );
  try {
    const responseReview = isRecord(value) ? value.review : null;
    if (
      !(
        isRecord(value) &&
        value.ok === true &&
        isRecord(responseReview) &&
        responseReview.reviewDigest === reviewDigest &&
        responseReview.executionVersion === 1
      )
    ) {
      throw new SpansExecutionRequestError('unavailable');
    }
    return {
      binding: decodeBinding(
        responseReview.binding,
        runId,
        reviewDigest,
        undefined,
        expectedTargetPath
      ),
      confirmation: '',
      executionVersion: 1,
      preview: null,
      reviewDigest,
    };
  } catch {
    return invalidResult('read');
  }
}

const RETAINED_REQUEST_KEYS = [
  'criteria',
  'instructions',
  'profile',
  'requireChange',
  'runId',
  'spanId',
  'target',
  'wallClockMs',
] as const;

export function decodeRetainedSpansExecutionInput(
  text: string,
  binding: JsonObject
): SpansExecutionInput | null {
  if (new TextEncoder().encode(text).byteLength > 65_536) {
    return null;
  }
  try {
    const envelope: unknown = JSON.parse(text);
    const request = isRecord(envelope) ? envelope.request : null;
    const target = isRecord(request) ? request.target : null;
    const { profile, inputArtifact, target: bindingTarget } = binding;
    const keys = isRecord(request) ? Object.keys(request).sort() : [];
    const expectedKeys = [...RETAINED_REQUEST_KEYS].sort();
    if (
      !(
        isRecord(envelope) &&
        envelope.version === 1 &&
        isRecord(request) &&
        keys.length === expectedKeys.length &&
        keys.every((key, index) => key === expectedKeys[index]) &&
        isRecord(target) &&
        isRecord(bindingTarget) &&
        isRecord(profile) &&
        isRecord(inputArtifact) &&
        inputArtifact.id === `sha256:${inputArtifact.digest}` &&
        request.runId === binding.runId &&
        request.spanId === binding.spanId &&
        request.profile === profile.id &&
        target.repo === bindingTarget.repo &&
        target.name === bindingTarget.name &&
        boundedInstructions(
          request.instructions,
          SPANS_EXECUTION_MAX_INSTRUCTIONS
        ) &&
        Array.isArray(request.criteria) &&
        request.criteria.length <= SPANS_EXECUTION_MAX_CRITERIA &&
        request.criteria.every((item) =>
          boundedString(item, SPANS_EXECUTION_MAX_CRITERION_CHARS)
        ) &&
        Number.isSafeInteger(request.wallClockMs) &&
        Number(request.wallClockMs) >= 60_000 &&
        Number(request.wallClockMs) <= SPANS_EXECUTION_MAX_MINUTES * 60_000 &&
        typeof request.requireChange === 'boolean'
      )
    ) {
      return null;
    }
    return {
      criteria: request.criteria as string[],
      instructions: request.instructions as string,
      profile: request.profile as string,
      requireChange: request.requireChange as boolean,
      runId: request.runId as string,
      spanId: request.spanId as string,
      target: { name: target.name as string, repo: target.repo as string },
      wallClockMs: Number(request.wallClockMs),
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    return null;
  }
}

export function sameSpansExecutionInput(
  left: SpansExecutionInput | null,
  right: SpansExecutionInput | null
): boolean {
  return Boolean(
    left &&
      right &&
      left.runId === right.runId &&
      left.spanId === right.spanId &&
      left.profile === right.profile &&
      left.instructions === right.instructions &&
      left.wallClockMs === right.wallClockMs &&
      left.requireChange === right.requireChange &&
      left.target.repo === right.target.repo &&
      left.target.name === right.target.name &&
      left.criteria.length === right.criteria.length &&
      left.criteria.every(
        (criterion, index) => criterion === right.criteria[index]
      )
  );
}

export interface SpansExecutionChallenge {
  challengeId: string;
  expiresAt: string;
  intent: 'approve' | 'revoke';
  phrase: string;
  reviewDigest: string;
  runId: string;
}

function decodeChallenge(
  value: unknown,
  expected: {
    intent: 'approve' | 'revoke';
    reviewDigest: string;
    runId: string;
  }
): SpansExecutionChallenge {
  if (
    !(
      isRecord(value) &&
      value.ok === true &&
      (value.runId === undefined || value.runId === expected.runId) &&
      value.reviewDigest === expected.reviewDigest &&
      value.intent === expected.intent &&
      isDigest(value.challengeId) &&
      boundedString(value.phrase, 256) &&
      value.phrase.trim().length > 0 &&
      boundedString(value.expiresAt, 64) &&
      !Number.isNaN(Date.parse(value.expiresAt))
    )
  ) {
    throw new SpansExecutionRequestError('unknown');
  }
  return {
    challengeId: value.challengeId,
    expiresAt: value.expiresAt,
    intent: expected.intent,
    phrase: value.phrase,
    reviewDigest: expected.reviewDigest,
    runId: expected.runId,
  };
}

export interface SpansExecutionApproval {
  approval: JsonObject;
  replayed: boolean;
}

function decodeApproval(
  value: unknown,
  expected: { challengeId: string; reviewDigest: string }
): SpansExecutionApproval {
  const approval = isRecord(value) ? value.approval : null;
  const proof = isRecord(approval) ? approval.confirmation : null;
  if (
    !(
      isRecord(value) &&
      value.ok === true &&
      isRecord(approval) &&
      approval.executionVersion === 1 &&
      approval.reviewDigest === expected.reviewDigest &&
      isRecord(proof) &&
      proof.reference === expected.challengeId &&
      proof.source === 'portal-human-confirmation' &&
      boundedString(proof.confirmedAt, 64) &&
      !Number.isNaN(Date.parse(proof.confirmedAt)) &&
      typeof value.replayed === 'boolean'
    )
  ) {
    throw new SpansExecutionRequestError('unknown');
  }
  return { approval, replayed: value.replayed };
}

export interface SpansExecutionDispatchResult {
  actionId: string;
  attemptId: string;
  status: 'duplicate' | 'launched';
}

function decodeDispatch(
  value: unknown,
  expected: { actionId: string; attemptId: string }
): SpansExecutionDispatchResult {
  if (
    !(
      isRecord(value) &&
      value.ok === true &&
      (value.status === 'launched' || value.status === 'duplicate') &&
      value.actionId === expected.actionId &&
      value.attemptId === expected.attemptId
    )
  ) {
    throw new SpansExecutionRequestError('unknown');
  }
  return {
    actionId: expected.actionId,
    attemptId: expected.attemptId,
    status: value.status,
  };
}

export interface SpansExecutionStatus {
  attempts: JsonObject[];
  executions: JsonObject[];
  generation: number;
}

export interface SpansExecutionAttemptBinding {
  actionId: string;
  attemptId: string;
  generation: number;
  runId: string;
  spanId: string;
  workerId: string;
}

export type SpansExecutionCancelState =
  | 'requested'
  | 'delivered'
  | 'unknown'
  | 'refused'
  | 'terminal';

export interface SpansExecutionCancelRecovery {
  binding: SpansExecutionAttemptBinding;
  state: SpansExecutionCancelState;
  updatedAt: string;
}

export type SpansExecutionCancelRecoveryRead =
  | { kind: 'empty' }
  | { kind: 'saved'; value: SpansExecutionCancelRecovery }
  | { kind: 'corrupt' }
  | { kind: 'unavailable' };

export type SpansExecutionCancelResult =
  | { attemptId: string; cancel: 'delivered'; terminal: false }
  | { attemptId: string; cancel: 'none'; terminal: true };

function decodeStatus(value: unknown, runId: string): SpansExecutionStatus {
  if (
    !(
      isRecord(value) &&
      value.ok === true &&
      Number.isSafeInteger(value.generation) &&
      Number(value.generation) >= 0 &&
      Array.isArray(value.attempts) &&
      value.attempts.length <= 256 &&
      value.attempts.every(isRecord) &&
      Array.isArray(value.executions) &&
      value.executions.length <= 256 &&
      value.executions.every(isRecord) &&
      (value.runId === undefined || value.runId === runId) &&
      [...value.attempts, ...value.executions].every(
        (entry) => entry.runId === undefined || entry.runId === runId
      )
    )
  ) {
    throw new SpansExecutionRequestError('unavailable');
  }
  return {
    attempts: value.attempts as JsonObject[],
    executions: value.executions as JsonObject[],
    generation: Number(value.generation),
  };
}

export async function readSpansExecutionStatus(
  runId: string
): Promise<SpansExecutionStatus> {
  const query = new URLSearchParams({ runId });
  const value = await requestJson(
    `/api/spans/execution/status?${query}`,
    {},
    'read'
  );
  try {
    return decodeStatus(value, runId);
  } catch {
    return invalidResult('read');
  }
}

function decodeCancellation(
  value: unknown,
  attemptId: string
): SpansExecutionCancelResult {
  if (
    !(
      isRecord(value) &&
      value.ok === true &&
      value.attemptId === attemptId &&
      ((value.cancel === 'delivered' && value.terminal === false) ||
        (value.cancel === 'none' && value.terminal === true))
    )
  ) {
    throw new SpansExecutionRequestError('unknown');
  }
  return value.terminal === true
    ? { attemptId, cancel: 'none', terminal: true }
    : { attemptId, cancel: 'delivered', terminal: false };
}

export async function cancelSpansExecutionAttempt(
  binding: SpansExecutionAttemptBinding
): Promise<SpansExecutionCancelResult> {
  if (
    !(
      isId(binding.runId) &&
      isId(binding.attemptId) &&
      isId(binding.actionId) &&
      isId(binding.spanId) &&
      isId(binding.workerId) &&
      Number.isSafeInteger(binding.generation) &&
      binding.generation >= 0
    )
  ) {
    throw new SpansExecutionRequestError('unknown');
  }
  const value = await requestJson(
    '/api/spans/execution/cancel',
    postJson({ attemptId: binding.attemptId, runId: binding.runId }),
    'write'
  );
  try {
    return decodeCancellation(value, binding.attemptId);
  } catch {
    return invalidResult('write');
  }
}

function cancelRecoveryKey(runId: string, attemptId: string): string {
  return `${CANCEL_RECOVERY_KEY_PREFIX}${encodeURIComponent(runId)}:${encodeURIComponent(attemptId)}`;
}

function sameAttemptBinding(
  left: SpansExecutionAttemptBinding,
  right: SpansExecutionAttemptBinding
): boolean {
  return (
    left.actionId === right.actionId &&
    left.attemptId === right.attemptId &&
    left.generation === right.generation &&
    left.runId === right.runId &&
    left.spanId === right.spanId &&
    left.workerId === right.workerId
  );
}

function decodeCancelRecovery(
  value: unknown,
  runId: string,
  attemptId: string
): SpansExecutionCancelRecovery | null {
  const binding = isRecord(value) ? value.binding : null;
  if (
    !(
      isRecord(value) &&
      value.version === 1 &&
      isRecord(binding) &&
      binding.runId === runId &&
      binding.attemptId === attemptId &&
      isId(binding.actionId) &&
      isId(binding.attemptId) &&
      isId(binding.runId) &&
      isId(binding.spanId) &&
      isId(binding.workerId) &&
      Number.isSafeInteger(binding.generation) &&
      Number(binding.generation) >= 0 &&
      ['requested', 'delivered', 'unknown', 'refused', 'terminal'].includes(
        String(value.state)
      ) &&
      boundedString(value.updatedAt, 64) &&
      !Number.isNaN(Date.parse(value.updatedAt))
    )
  ) {
    return null;
  }
  return {
    binding: {
      actionId: binding.actionId as string,
      attemptId: binding.attemptId as string,
      generation: Number(binding.generation),
      runId: binding.runId as string,
      spanId: binding.spanId as string,
      workerId: binding.workerId as string,
    },
    state: value.state as SpansExecutionCancelState,
    updatedAt: value.updatedAt as string,
  };
}

export function readSpansExecutionCancelRecovery(
  storage: SpansExecutionStorage | null,
  runId: string,
  attemptId: string
): SpansExecutionCancelRecoveryRead {
  if (!storage) {
    return { kind: 'unavailable' };
  }
  let raw: string | null;
  try {
    raw = storage.getItem(cancelRecoveryKey(runId, attemptId));
  } catch {
    return { kind: 'unavailable' };
  }
  if (raw === null) {
    return { kind: 'empty' };
  }
  try {
    const value = decodeCancelRecovery(
      JSON.parse(raw) as unknown,
      runId,
      attemptId
    );
    return value ? { kind: 'saved', value } : { kind: 'corrupt' };
  } catch {
    return { kind: 'corrupt' };
  }
}

export function writeSpansExecutionCancelRecovery(
  storage: SpansExecutionStorage | null,
  binding: SpansExecutionAttemptBinding,
  state: SpansExecutionCancelState,
  updatedAt = new Date().toISOString()
): boolean {
  if (
    !(
      storage &&
      isId(binding.runId) &&
      isId(binding.attemptId) &&
      isId(binding.actionId) &&
      isId(binding.spanId) &&
      isId(binding.workerId) &&
      Number.isSafeInteger(binding.generation)
    ) ||
    binding.generation < 0 ||
    !['requested', 'delivered', 'unknown', 'refused', 'terminal'].includes(
      state
    ) ||
    !boundedString(updatedAt, 64) ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    return false;
  }
  const existing = readSpansExecutionCancelRecovery(
    storage,
    binding.runId,
    binding.attemptId
  );
  if (
    existing.kind !== 'empty' &&
    !(
      existing.kind === 'saved' &&
      sameAttemptBinding(existing.value.binding, binding)
    )
  ) {
    return false;
  }
  try {
    storage.setItem(
      cancelRecoveryKey(binding.runId, binding.attemptId),
      JSON.stringify({ binding, state, updatedAt, version: 1 })
    );
    return true;
  } catch {
    return false;
  }
}

export function persistSpansExecutionCancelState(
  storage: SpansExecutionStorage | null,
  binding: SpansExecutionAttemptBinding,
  state: SpansExecutionCancelState,
  updatedAt = new Date().toISOString()
): boolean {
  const current = readSpansExecutionRecovery(storage, binding.runId);
  if (current.kind === 'corrupt' || current.kind === 'unavailable') {
    return false;
  }
  if (
    current.kind === 'saved' &&
    current.value.runId === binding.runId &&
    current.value.actionId === binding.actionId &&
    current.value.attemptId === binding.attemptId &&
    current.value.spanId === binding.spanId &&
    (current.value.stage === 'dispatched' ||
      current.value.stage === 'dispatch-unknown')
  ) {
    return writeSpansExecutionRecovery(storage, {
      ...current.value,
      status: `cancel-${state}`,
      updatedAt,
    });
  }
  return writeSpansExecutionCancelRecovery(storage, binding, state, updatedAt);
}

export async function reviewSpansExecution(
  input: SpansExecutionInput
): Promise<SpansExecutionPreview> {
  const value = await requestJson(
    '/api/spans/execution/review',
    postJson(input),
    'read'
  );
  try {
    return decodePreview(value, input);
  } catch {
    return invalidResult('read');
  }
}

export async function prepareSpansExecution(
  input: SpansExecutionInput,
  expectedTargetPath?: string
): Promise<SpansExecutionPreparedReview> {
  const value = await requestJson(
    '/api/spans/execution/prepare',
    postJson(input),
    'write'
  );
  try {
    return decodePreparedReview(value, input, expectedTargetPath);
  } catch {
    return invalidResult('write');
  }
}

export async function probeSpansExecutionProfile(
  profile = SPANS_EXECUTION_PROFILE
): Promise<void> {
  const value = await requestJson(
    '/api/spans/execution/probe',
    postJson({ profile }),
    'write'
  );
  if (!(isRecord(value) && value.ok === true)) {
    return invalidResult('write');
  }
}

export async function issueSpansExecutionChallenge(input: {
  intent: 'approve' | 'revoke';
  reviewDigest: string;
  runId: string;
}): Promise<SpansExecutionChallenge> {
  const value = await requestJson(
    '/api/spans/execution/approval-challenge',
    postJson(input),
    'write'
  );
  try {
    return decodeChallenge(value, input);
  } catch {
    return invalidResult('write');
  }
}

async function confirmSpansExecution(
  intent: 'approve' | 'revoke',
  input: {
    confirmation: { challengeId: string; response: string };
    reviewDigest: string;
    runId: string;
  }
): Promise<SpansExecutionApproval | { revoked: true; replayed: boolean }> {
  const route = `/api/spans/execution/${intent === 'approve' ? 'approve' : 'revoke'}`;
  const value = await requestJson(route, postJson(input), 'write');
  if (intent === 'approve') {
    try {
      return decodeApproval(value, {
        challengeId: input.confirmation.challengeId,
        reviewDigest: input.reviewDigest,
      });
    } catch {
      return invalidResult('write');
    }
  }
  if (
    !(
      isRecord(value) &&
      value.ok === true &&
      (value.replayed === undefined || typeof value.replayed === 'boolean')
    )
  ) {
    return invalidResult('write');
  }
  return { replayed: value.replayed === true, revoked: true };
}

export async function approveSpansExecution(input: {
  confirmation: { challengeId: string; response: string };
  reviewDigest: string;
  runId: string;
}): Promise<SpansExecutionApproval> {
  const result = await confirmSpansExecution('approve', input);
  if ('revoked' in result) {
    return invalidResult('write');
  }
  return result;
}

export async function revokeSpansExecution(input: {
  confirmation: { challengeId: string; response: string };
  reviewDigest: string;
  runId: string;
}): Promise<{ revoked: true; replayed: boolean }> {
  const result = await confirmSpansExecution('revoke', input);
  if ('approval' in result) {
    return invalidResult('write');
  }
  return result;
}

export async function dispatchSpansExecution(
  input: SpansExecutionInput,
  binding: { actionId: string; attemptId: string },
  confirmation: string,
  reviewDigest: string
): Promise<SpansExecutionDispatchResult> {
  const value = await requestJson(
    '/api/spans/execution/dispatch',
    postJson({ ...input, confirmation, reviewDigest }),
    'write'
  );
  try {
    return decodeDispatch(value, binding);
  } catch {
    return invalidResult('write');
  }
}

export async function reconcileSpansExecution(): Promise<void> {
  const value = await requestJson(
    '/api/spans/execution/reconcile',
    postJson({}),
    'write'
  );
  if (
    !(
      isRecord(value) &&
      value.ok === true &&
      Array.isArray(value.reconciled) &&
      value.reconciled.length <= 256
    )
  ) {
    return invalidResult('write');
  }
}

export type SpansExecutionRecoveryStage =
  | 'probe-pending'
  | 'probe-unknown'
  | 'prepare-pending'
  | 'prepare-unknown'
  | 'prepared'
  | 'challenge-pending'
  | 'approval-pending'
  | 'approval-unknown'
  | 'approved'
  | 'revocation-pending'
  | 'revocation-unknown'
  | 'revoked'
  | 'dispatch-pending'
  | 'dispatch-unknown'
  | 'dispatched';

export interface SpansExecutionRecovery {
  actionId?: string;
  attemptId?: string;
  confirmation?: string;
  reviewDigest?: string;
  runId: string;
  spanId: string;
  stage: SpansExecutionRecoveryStage;
  status?: string;
  target: { name: string; repo: string };
  updatedAt: string;
}

export interface SpansExecutionStorage {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
}

export type SpansExecutionRecoveryRead =
  | { kind: 'empty' }
  | { kind: 'saved'; value: SpansExecutionRecovery }
  | { kind: 'corrupt' }
  | { kind: 'unavailable' };

const RECOVERY_STAGES: SpansExecutionRecoveryStage[] = [
  'probe-pending',
  'probe-unknown',
  'prepare-pending',
  'prepare-unknown',
  'prepared',
  'challenge-pending',
  'approval-pending',
  'approval-unknown',
  'approved',
  'revocation-pending',
  'revocation-unknown',
  'revoked',
  'dispatch-pending',
  'dispatch-unknown',
  'dispatched',
];

const MUTATION_STAGE_MAP: Record<
  SpansExecutionRecoveryStage,
  SpansExecutionRecoveryStage
> = {
  'approval-pending': 'approval-unknown',
  'approval-unknown': 'approval-unknown',
  approved: 'approved',
  'challenge-pending': 'prepared',
  'dispatch-pending': 'dispatch-unknown',
  'dispatch-unknown': 'dispatch-unknown',
  dispatched: 'dispatched',
  'prepare-pending': 'prepare-unknown',
  'prepare-unknown': 'prepare-unknown',
  prepared: 'prepared',
  'probe-pending': 'probe-unknown',
  'probe-unknown': 'probe-unknown',
  'revocation-pending': 'revocation-unknown',
  'revocation-unknown': 'revocation-unknown',
  revoked: 'revoked',
};

function recoveryKey(runId: string): string {
  return `${RECOVERY_KEY_PREFIX}${encodeURIComponent(runId)}`;
}

function validRecovery(
  value: unknown,
  runId: string
): SpansExecutionRecovery | null {
  if (
    !(
      isRecord(value) &&
      value.version === 1 &&
      value.runId === runId &&
      isId(value.spanId) &&
      RECOVERY_STAGES.includes(value.stage as SpansExecutionRecoveryStage) &&
      isRecord(value.target) &&
      boundedString(value.target.repo, 256) &&
      boundedString(value.target.name, 256) &&
      boundedString(value.updatedAt, 64) &&
      !Number.isNaN(Date.parse(value.updatedAt)) &&
      (value.reviewDigest === undefined || isDigest(value.reviewDigest)) &&
      (value.confirmation === undefined ||
        boundedString(value.confirmation, 256)) &&
      (value.actionId === undefined || isId(value.actionId)) &&
      (value.attemptId === undefined || isId(value.attemptId)) &&
      (value.status === undefined ||
        SAFE_STATE_PATTERN.test(String(value.status)))
    )
  ) {
    return null;
  }
  const stage = value.stage as SpansExecutionRecoveryStage;
  const reviewStages = [
    'prepared',
    'challenge-pending',
    'approval-pending',
    'approval-unknown',
    'approved',
    'revocation-pending',
    'revocation-unknown',
    'revoked',
    'dispatch-pending',
    'dispatch-unknown',
    'dispatched',
  ];
  const requiresConfirmation = [
    'prepared',
    'challenge-pending',
    'approval-pending',
    'approval-unknown',
    'approved',
    'revocation-pending',
    'revocation-unknown',
    'revoked',
    'dispatch-pending',
    'dispatch-unknown',
    'dispatched',
  ];
  if (
    (reviewStages.includes(stage) &&
      !(
        isDigest(value.reviewDigest) &&
        isId(value.actionId) &&
        isId(value.attemptId)
      )) ||
    (requiresConfirmation.includes(stage) &&
      !boundedString(value.confirmation, 256)) ||
    (stage === 'dispatched' && !boundedString(value.status, 64))
  ) {
    return null;
  }
  return {
    ...(typeof value.actionId === 'string' ? { actionId: value.actionId } : {}),
    ...(typeof value.attemptId === 'string'
      ? { attemptId: value.attemptId }
      : {}),
    ...(typeof value.confirmation === 'string'
      ? { confirmation: value.confirmation }
      : {}),
    ...(typeof value.reviewDigest === 'string'
      ? { reviewDigest: value.reviewDigest }
      : {}),
    runId,
    spanId: value.spanId,
    stage: MUTATION_STAGE_MAP[stage],
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    target: { name: value.target.name, repo: value.target.repo },
    updatedAt: value.updatedAt,
  };
}

export function readSpansExecutionRecovery(
  storage: SpansExecutionStorage | null,
  runId: string
): SpansExecutionRecoveryRead {
  if (!storage) {
    return { kind: 'unavailable' };
  }
  let raw: string | null;
  try {
    raw = storage.getItem(recoveryKey(runId));
  } catch {
    return { kind: 'unavailable' };
  }
  if (raw === null) {
    return { kind: 'empty' };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'corrupt' };
  }
  try {
    const recovery = validRecovery(value, runId);
    return recovery ? { kind: 'saved', value: recovery } : { kind: 'corrupt' };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function writeSpansExecutionRecovery(
  storage: SpansExecutionStorage | null,
  recovery: SpansExecutionRecovery
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(
      recoveryKey(recovery.runId),
      JSON.stringify({ ...recovery, version: 1 })
    );
    return true;
  } catch {
    return false;
  }
}

export function clearSpansExecutionRecovery(
  storage: SpansExecutionStorage | null,
  runId: string
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.removeItem(recoveryKey(runId));
    return true;
  } catch {
    return false;
  }
}

export function hasUnresolvedSpansExecutionOutcome(
  stage: SpansExecutionRecoveryStage
): boolean {
  return [
    'probe-pending',
    'probe-unknown',
    'prepare-pending',
    'prepare-unknown',
    'approval-pending',
    'approval-unknown',
    'revocation-pending',
    'revocation-unknown',
    'dispatch-pending',
    'dispatch-unknown',
    'dispatched',
  ].includes(stage);
}

export function findSpansExecutionAttempt(
  status: SpansExecutionStatus,
  recovery: SpansExecutionRecovery
): { acceptance: string; action: string; attempt: string } | null {
  if (!(recovery.actionId && recovery.attemptId)) {
    return null;
  }
  const execution = status.executions.find(
    (item) =>
      item.actionId === recovery.actionId &&
      item.attemptId === recovery.attemptId &&
      item.spanId === recovery.spanId
  );
  const attempt = status.attempts.find(
    (item) =>
      item.actionId === recovery.actionId &&
      item.attemptId === recovery.attemptId &&
      item.spanId === recovery.spanId
  );
  if (!(execution || attempt)) {
    return null;
  }
  const safe = (value: unknown) =>
    boundedString(value, 64) && SAFE_STATE_PATTERN.test(value)
      ? value
      : 'unknown';
  return {
    acceptance: safe(execution?.acceptance),
    action: safe(execution?.action),
    attempt: safe(attempt?.status),
  };
}

export function validSpansExecutionRequest(
  input: SpansExecutionInput,
  record: SpansRecord,
  choices: SpansExecutionSpanChoice[],
  targets: RegisteredSpansTarget[]
): string | null {
  const valid =
    spansExecutionRecordIsEligible(record) &&
    isId(input.runId) &&
    input.runId === record.runId &&
    choices.some((choice) => choice.spanId === input.spanId) &&
    targets.some(
      (target) =>
        target.repo === input.target.repo && target.name === input.target.name
    ) &&
    input.profile === SPANS_EXECUTION_PROFILE &&
    boundedInstructions(input.instructions, SPANS_EXECUTION_MAX_INSTRUCTIONS) &&
    input.instructions.trim().length > 0 &&
    Number.isSafeInteger(input.wallClockMs) &&
    input.wallClockMs >= 60_000 &&
    input.wallClockMs <= SPANS_EXECUTION_MAX_MINUTES * 60_000 &&
    typeof input.requireChange === 'boolean' &&
    input.criteria.length <= SPANS_EXECUTION_MAX_CRITERIA &&
    input.criteria.every(
      (criterion) =>
        boundedString(criterion, SPANS_EXECUTION_MAX_CRITERION_CHARS) &&
        criterion.trim().length > 0
    );
  return valid
    ? null
    : 'Choose an eligible span and registered checkout, then complete the required fields.';
}

const IN_FLIGHT_EXECUTION_RUNS = new Set<string>();

export function spansExecutionOperationInFlight(runId: string): boolean {
  return IN_FLIGHT_EXECUTION_RUNS.has(runId);
}

export type SpansExecutionOperationResult<T> =
  | { kind: 'busy' }
  | { kind: 'recovery-unavailable' }
  | { kind: 'stale' }
  | {
      current: boolean;
      kind: 'success';
      recoverySaved: boolean;
      value: T;
    }
  | {
      current: boolean;
      error: unknown;
      kind: 'refused' | 'unknown';
      recoverySaved: boolean;
    };

export async function runSpansExecutionOperation<T>(options: {
  completed?: (value: T) => SpansExecutionRecovery | null;
  current: () => boolean;
  pending?: SpansExecutionRecovery;
  refused?: (error: unknown) => SpansExecutionRecovery | null;
  request: () => Promise<T>;
  runId: string;
  storage: SpansExecutionStorage | null;
  unknown?: SpansExecutionRecovery;
}): Promise<SpansExecutionOperationResult<T>> {
  if (!options.current()) {
    return { kind: 'stale' };
  }
  if (IN_FLIGHT_EXECUTION_RUNS.has(options.runId)) {
    return { kind: 'busy' };
  }
  IN_FLIGHT_EXECUTION_RUNS.add(options.runId);
  try {
    if (
      options.pending &&
      !writeSpansExecutionRecovery(options.storage, options.pending)
    ) {
      return { kind: 'recovery-unavailable' };
    }
    if (!options.current()) {
      if (options.pending) {
        clearSpansExecutionRecovery(options.storage, options.runId);
      }
      return { kind: 'stale' };
    }
    try {
      const value = await options.request();
      const recovery = options.completed?.(value);
      const recoverySaved =
        recovery === undefined ||
        (recovery === null
          ? clearSpansExecutionRecovery(options.storage, options.runId)
          : writeSpansExecutionRecovery(options.storage, recovery));
      return {
        current: options.current(),
        kind: 'success',
        recoverySaved,
        value,
      };
    } catch (error) {
      const refused =
        error instanceof SpansExecutionRequestError && error.kind === 'refused';
      const recovery = refused ? options.refused?.(error) : options.unknown;
      const recoverySaved =
        recovery === undefined ||
        (recovery === null
          ? clearSpansExecutionRecovery(options.storage, options.runId)
          : writeSpansExecutionRecovery(options.storage, recovery));
      return {
        current: options.current(),
        error,
        kind: refused && recoverySaved ? 'refused' : 'unknown',
        recoverySaved,
      };
    }
  } finally {
    IN_FLIGHT_EXECUTION_RUNS.delete(options.runId);
  }
}

export type SpansExecutionCancelOperationResult =
  | { kind: 'busy' | 'recovery-unavailable' | 'stale' }
  | {
      current: boolean;
      kind: 'success';
      recoverySaved: boolean;
      value: SpansExecutionCancelResult;
    }
  | {
      current: boolean;
      error: unknown;
      kind: 'refused' | 'unknown';
      recoverySaved: boolean;
    };

export async function runSpansExecutionCancelOperation(options: {
  binding: SpansExecutionAttemptBinding;
  current: () => boolean;
  persist: (state: SpansExecutionCancelState) => boolean;
  request: () => Promise<SpansExecutionCancelResult>;
  runId: string;
}): Promise<SpansExecutionCancelOperationResult> {
  if (!options.current()) {
    return { kind: 'stale' };
  }
  if (IN_FLIGHT_EXECUTION_RUNS.has(options.runId)) {
    return { kind: 'busy' };
  }
  IN_FLIGHT_EXECUTION_RUNS.add(options.runId);
  try {
    if (!options.persist('requested')) {
      return { kind: 'recovery-unavailable' };
    }
    if (!options.current()) {
      options.persist('refused');
      return { kind: 'stale' };
    }
    try {
      const value = await options.request();
      return {
        current: options.current(),
        kind: 'success',
        recoverySaved: options.persist(
          value.terminal ? 'terminal' : 'delivered'
        ),
        value,
      };
    } catch (error) {
      const refused =
        error instanceof SpansExecutionRequestError && error.kind === 'refused';
      return {
        current: options.current(),
        error,
        kind: refused ? 'refused' : 'unknown',
        recoverySaved: options.persist(refused ? 'refused' : 'unknown'),
      };
    }
  } finally {
    IN_FLIGHT_EXECUTION_RUNS.delete(options.runId);
  }
}
