import { AsyncLocalStorage } from 'node:async_hooks';
import { createSpansExecutionAuthority } from './spans-execution-authority.js';
import {
  buildSpansExecutionEnvelope,
  buildSpansExecutionReviewBinding,
  readSpansExecutionRequest,
} from './spans-execution-binding.js';
import {
  digestOf,
  exactRequest,
  isExplicitId,
} from './spans-execution-core.js';

const DIGEST = /^[a-f0-9]{64}$/;
const SELECTOR_KEYS = [
  'actionId',
  'attemptId',
  'generation',
  'planVersion',
  'runId',
  'spanId',
];
const selectorOf = (binding) =>
  Object.fromEntries(SELECTOR_KEYS.map((key) => [key, binding[key]]));
const invalid = () => ({
  code: 'SPANS_EXECUTION_REVIEW_INVALID',
  error: 'Invalid execution review request or record.',
  ok: false,
});
const changed = () => ({
  code: 'SPANS_EXECUTION_REVIEW_CHANGED',
  error: 'Execution binding changed; prepare a new review.',
  ok: false,
});

function reviewRequest(input, extra = []) {
  const request = exactRequest(input, ['runId', 'reviewDigest', ...extra]);
  return request &&
    isExplicitId(request.runId) &&
    typeof request.reviewDigest === 'string' &&
    DIGEST.test(request.reviewDigest)
    ? request
    : null;
}

// The current coordinator supplies all observations and owns every effect.
// Context is local to one operation; a restart loads the immutable artifact,
// never a process-global pending request or caller-supplied approval.
export function createSpansExecutionReviewFlow({
  admission,
  artifacts,
  buildReview,
  now,
  parseReview,
  profiles,
  store,
  writeArchive,
}) {
  const context = new AsyncLocalStorage();

  async function observe(selector) {
    const scope = context.getStore();
    if (!scope) {
      return null;
    }
    const built = await buildReview(scope.request, selector);
    if (built.refusal) {
      return null;
    }
    const run = store.readRun({ runId: selector.runId });
    const input = buildSpansExecutionEnvelope({ built, run });
    if (!input.ok || input.artifactId !== scope.inputArtifact.id) {
      return null;
    }
    const status = await admission.status();
    if (status?.ok !== true) {
      return null;
    }
    const bound = buildSpansExecutionReviewBinding({
      admissionLimits: status.limits,
      built,
      definition: profiles[built.review.profile],
      inputArtifact: scope.inputArtifact,
    });
    if (!bound.ok) {
      return null;
    }
    scope.built = built;
    return bound.binding;
  }

  const authority = createSpansExecutionAuthority({
    now: () => new Date(now()),
    resolveBinding: observe,
    store,
    writeArchive,
  });

  async function withReview(request, operation) {
    const saved = await authority.read({
      reviewDigest: request.reviewDigest,
      runId: request.runId,
    });
    if (!saved.ok) {
      return saved;
    }
    const { binding } = saved.review;
    const artifact = artifacts.read({ artifactId: binding.inputArtifact.id });
    const retained = readSpansExecutionRequest({ artifact, binding });
    const normalized = retained.ok && parseReview(retained.request);
    if (!normalized) {
      return changed();
    }
    const scope = { inputArtifact: binding.inputArtifact, request: normalized };
    return await context.run(scope, () => operation(saved.review, scope));
  }

  async function prepare(request) {
    const built = await buildReview(request);
    if (built.refusal) {
      return built.refusal;
    }
    const run = store.readRun({ runId: request.runId });
    const input = buildSpansExecutionEnvelope({ built, run });
    if (!input.ok) {
      return input;
    }
    const retained = await writeArchive(() =>
      artifacts.put({ mediaType: input.mediaType, text: input.text })
    );
    if (retained?.ok !== true) {
      return retained;
    }
    if (retained.artifactId !== input.artifactId) {
      return changed();
    }
    const inputArtifact = {
      digest: input.artifactId.slice('sha256:'.length),
      id: input.artifactId,
    };
    const result = await context.run({ inputArtifact, request }, () =>
      authority.prepare(selectorOf(built.dispatchRequest))
    );
    return result.ok
      ? {
          ...result,
          confirmation: built.confirmation,
          preview: built.review,
          status: 'prepared',
        }
      : result;
  }

  async function confirm(input, intent) {
    const request = reviewRequest(input, ['confirmation']);
    if (!request) {
      return invalid();
    }
    return intent === 'revoke'
      ? await authority.revoke(request)
      : await withReview(request, () => authority.approve(request));
  }

  async function authorize(input) {
    const request = reviewRequest(input);
    if (!request) {
      return invalid();
    }
    return await withReview(request, async (review, scope) => {
      const result = await authority.authorize({
        ...selectorOf(review.binding),
        reviewDigest: request.reviewDigest,
      });
      return result.ok ? { ...result, built: scope.built } : result;
    });
  }

  function current(record) {
    if (!(record?.reviewRef && record.approval)) {
      return invalid();
    }
    const result = authority.checkApprovalCurrent(
      { ...record.reviewSelector, ...record.reviewRef },
      record.approval
    );
    return result.ok && digestOf(record.approval) === record.approvalDigest
      ? result
      : changed();
  }

  return Object.freeze({
    approve: (input) => confirm(input, 'approve'),
    authorize,
    close: () => authority.close(),
    current,
    issue: (input) => authority.issue(input),
    prepare,
    read: (input) => authority.read(input),
    revoke: (input) => confirm(input, 'revoke'),
  });
}
