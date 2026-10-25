// Small composition facade for durable Spans execution reviews. The parent
// owns archive admission and remains the only owner of execution effects.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createSpansExecutionConfirmation } from './spans-execution-confirmation.js';
import { createSpansExecutionReviews } from './spans-execution-review.js';

const ERRORS = Object.freeze({
  SPANS_EXECUTION_AUTHORITY_CLOSED: 'Execution authority is closed.',
  SPANS_EXECUTION_AUTHORITY_GATE:
    'The parent archive write gate did not run one current effect.',
  SPANS_EXECUTION_AUTHORITY_UNKNOWN:
    'The archive effect ran, but its result could not be confirmed.',
});

const refusal = (code) => ({ code, error: ERRORS[code], ok: false });
const UNCONFIRMABLE_EFFECT_RESULT = Symbol('unconfirmable effect result');

function resultSnapshot(value) {
  try {
    return JSON.stringify(value) ?? UNCONFIRMABLE_EFFECT_RESULT;
  } catch {
    return UNCONFIRMABLE_EFFECT_RESULT;
  }
}

function effectResultMatches(gate, parentResult) {
  if (
    gate.effectResultValue === UNCONFIRMABLE_EFFECT_RESULT ||
    !Object.is(parentResult, gate.effectResult)
  ) {
    return false;
  }
  return resultSnapshot(gate.effectResult) === gate.effectResultValue;
}

/**
 * Compose review and confirmation services around the parent's already-open
 * synchronous Spans store. `writeArchive` must run its one effect under the
 * shared archive admission lock and return that effect's unwrapped result.
 */
export function createSpansExecutionAuthority({
  store,
  resolveBinding,
  writeArchive,
  now,
  randomBytes,
} = {}) {
  const gateStorage = new AsyncLocalStorage();
  const active = new Set();
  let closed = false;
  let closePromise;
  let reviews;
  const authorityMarker = Object.freeze({});

  const confirmationOptions = {
    readReview: (request) => reviews.read(request),
    store,
  };
  if (now !== undefined) {
    confirmationOptions.now = now;
  }
  if (randomBytes !== undefined) {
    confirmationOptions.randomBytes = randomBytes;
  }
  const confirmation = createSpansExecutionConfirmation(confirmationOptions);

  function verifyWritable() {
    const gate = gateStorage.getStore();
    return Boolean(
      gate &&
        gate.authority === authorityMarker &&
        gate.active &&
        gate.invocations === 1 &&
        !gate.invalid
    );
  }

  reviews = createSpansExecutionReviews({
    resolveBinding,
    store,
    verifyConfirmation: (request) => confirmation.verify(request),
    verifyRevocation: (request) => confirmation.verifyRevocation(request),
    verifyWritable,
  });

  function track(operation) {
    if (closed) {
      return Promise.resolve(refusal('SPANS_EXECUTION_AUTHORITY_CLOSED'));
    }
    let tracked;
    const result = Promise.resolve().then(operation);
    tracked = result.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }

  function effectInvocationRefusal(gate) {
    if (closed) {
      gate.invalid = true;
      return refusal('SPANS_EXECUTION_AUTHORITY_CLOSED');
    }
    if (gate.parentReturned || gate.invocations !== 0 || gate.completed) {
      gate.invalid = true;
      return refusal('SPANS_EXECUTION_AUTHORITY_GATE');
    }
    return null;
  }

  function createGateEffect(gate, operation) {
    return () => {
      const rejected = effectInvocationRefusal(gate);
      if (rejected) {
        return Promise.resolve(rejected);
      }
      gate.invocations = 1;
      gate.active = true;
      const pending = gateStorage.run(gate, async () => {
        try {
          const result = await operation();
          gate.effectResult = result;
          gate.effectResultValue = resultSnapshot(result);
          return result;
        } finally {
          gate.active = false;
          gate.completed = true;
        }
      });
      gate.pending = pending;
      return pending;
    };
  }

  async function settleEffect(gate) {
    if (!gate.pending) {
      return true;
    }
    try {
      await gate.pending;
      return true;
    } catch {
      return false;
    }
  }

  async function throughArchive(operation) {
    if (closed) {
      return refusal('SPANS_EXECUTION_AUTHORITY_CLOSED');
    }
    if (typeof writeArchive !== 'function') {
      return refusal('SPANS_EXECUTION_AUTHORITY_GATE');
    }

    const gate = {
      active: false,
      authority: authorityMarker,
      completed: false,
      invalid: false,
      invocations: 0,
      parentReturned: false,
    };

    let parentResult;
    try {
      parentResult = await writeArchive(createGateEffect(gate, operation));
    } catch {
      gate.parentReturned = true;
      await settleEffect(gate);
      return gate.invocations === 0
        ? refusal('SPANS_EXECUTION_AUTHORITY_GATE')
        : refusal('SPANS_EXECUTION_AUTHORITY_UNKNOWN');
    }
    gate.parentReturned = true;
    const settled = await settleEffect(gate);
    if (
      settled &&
      gate.invocations === 0 &&
      parentResult?.ok === false &&
      !gate.invalid
    ) {
      return parentResult;
    }
    if (!settled || gate.invocations === 0 || !gate.completed || gate.invalid) {
      return gate.invocations === 0
        ? refusal('SPANS_EXECUTION_AUTHORITY_GATE')
        : refusal('SPANS_EXECUTION_AUTHORITY_UNKNOWN');
    }
    if (!effectResultMatches(gate, parentResult)) {
      return refusal('SPANS_EXECUTION_AUTHORITY_UNKNOWN');
    }
    return gate.effectResult;
  }

  function gated(operation) {
    return track(() => throughArchive(operation));
  }

  function prepare(selector) {
    return gated(() => reviews.prepare(selector));
  }

  function read(request) {
    return track(() => reviews.read(request));
  }

  function issue(request) {
    return track(() => confirmation.issue(request));
  }

  function approve(request) {
    return gated(() => reviews.approve(request));
  }

  function revoke(request) {
    return gated(() => reviews.revoke(request));
  }

  function authorize(selector) {
    return gated(() => reviews.authorize(selector));
  }

  function checkApprovalCurrent(selector, expectedApproval) {
    if (closed) {
      return refusal('SPANS_EXECUTION_AUTHORITY_CLOSED');
    }
    return reviews.checkApprovalCurrent(selector, expectedApproval);
  }

  function close() {
    if (closePromise) {
      return closePromise;
    }
    closed = true;
    closePromise = Promise.allSettled([...active]).then(() => {
      confirmation.close();
      return { ok: true };
    });
    return closePromise;
  }

  return Object.freeze({
    approve,
    authorize,
    checkApprovalCurrent,
    close,
    issue,
    prepare,
    read,
    revoke,
  });
}
