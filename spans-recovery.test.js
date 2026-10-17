import { expect, test } from 'bun:test';
import {
  digestSpansRecoveryReceipt,
  reconcileSpansRecovery,
} from './spans-recovery.js';

const checkout = {
  admin: { birthtimeNs: '1100', dev: '1', ino: '21' },
  adminPath: '/workspace/r.git/worktrees/topic',
  checkout: { birthtimeNs: '1000', dev: '1', ino: '22' },
  checkoutPath: '/workspace/r/topic',
  known: true,
  repository: { birthtimeNs: '1200', dev: '1', ino: '23' },
  repositoryPath: '/workspace/r.git',
};
const otherCheckout = {
  admin: { birthtimeNs: '2100', dev: '1', ino: '31' },
  adminPath: '/workspace/other.git/worktrees/topic',
  checkout: { birthtimeNs: '1000', dev: '1', ino: '32' },
  checkoutPath: '/workspace/other/topic',
  known: true,
  repository: { birthtimeNs: '2200', dev: '1', ino: '33' },
  repositoryPath: '/workspace/other.git',
};
const worker = {
  processId: 4421,
  processStartIdentity: 'Fri Oct 16 09:10:11 2026',
};

function base(overrides = {}) {
  return {
    actionId: 'action-a',
    attemptId: 'attempt-a1',
    checkoutIdentity: checkout,
    generation: 4,
    nativeSessionId: 'native-session-9',
    runId: 'run-a',
    spanId: 'span-a',
    worker,
    ...overrides,
  };
}

function attemptReceipt(overrides = {}) {
  return {
    ...base(),
    deadlineAtMs: 20_000,
    lastObservedWallTimeMs: 10_000,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    ownerIdentity: base(),
    processId: worker.processId,
    processStartIdentity: worker.processStartIdentity,
    state: 'alive',
    ...overrides,
  };
}

function clock(overrides = {}) {
  return { sleepWakeGap: false, wallTimeMs: 12_000, ...overrides };
}

function receipt(outcome = 'completed', overrides = {}) {
  const value = {
    ...base(),
    outcome,
    receiptId: `receipt-${outcome}`,
    ...overrides,
  };
  return {
    digest: digestSpansRecoveryReceipt(value).receiptDigest,
    value,
  };
}

function verification(receiptDigest, evidenceId = 'evidence-a') {
  return { evidenceId, receiptDigest, verified: true };
}

function request(overrides = {}) {
  return {
    attemptReceipt: attemptReceipt(),
    clock: clock(),
    currentCheckoutIdentity: checkout,
    currentGeneration: 4,
    processObservation: observation(),
    ...overrides,
  };
}

test('reattaches after a portal restart only for the exact live worker identity', () => {
  const result = reconcileSpansRecovery(request());

  expect(result).toMatchObject({
    commitMode: 'cas',
    decision: 'reattach-worker',
    ok: true,
    status: 'worker-alive',
    workerState: 'alive',
  });
  expect(result.events).toHaveLength(1);
  expect(reconcileSpansRecovery(request()).events[0].eventId).toBe(
    result.events[0].eventId
  );
  expect(result).not.toHaveProperty('proposal');
});

test('event IDs are deterministic and unique across runs that reuse action IDs', () => {
  const otherRun = base({ runId: 'run-b' });
  const result = reconcileSpansRecovery(
    request({
      attemptReceipt: attemptReceipt({ ...otherRun }),
      processObservation: observation({ ownerIdentity: otherRun }),
    })
  );

  expect(result.ok).toBe(true);
  expect(result.events[0].eventId).not.toBe(
    reconcileSpansRecovery(request()).events[0].eventId
  );
});

test('a reused PID with a different process start is orphaned', () => {
  for (const observedClock of [clock(), clock({ sleepWakeGap: true })]) {
    const result = reconcileSpansRecovery(
      request({
        clock: observedClock,
        processObservation: observation({
          processStartIdentity: 'Fri Oct 16 11:12:13 2026',
        }),
      })
    );

    expect(result).toMatchObject({
      decision: 'manual-review',
      reason: 'pid-reused-or-process-replaced',
      status: 'orphaned',
    });
  }
});

test('matching PID and start still require matching action, generation, checkout, and session', () => {
  for (const changed of [
    { actionId: 'different-action' },
    { generation: 5 },
    { nativeSessionId: 'different-session' },
  ]) {
    const result = reconcileSpansRecovery(
      request({
        processObservation: observation({
          ownerIdentity: base(changed),
        }),
      })
    );

    expect(result).toMatchObject({
      decision: 'manual-review',
      reason: 'process-owner-identity-mismatch',
      status: 'orphaned',
    });
  }
});

test('missing persisted process identity stays unknown instead of matching by PID', () => {
  const result = reconcileSpansRecovery(
    request({
      attemptReceipt: attemptReceipt({
        worker: { processId: null, processStartIdentity: null },
      }),
      processObservation: observation({
        ownerIdentity: base({
          worker: { processId: null, processStartIdentity: null },
        }),
      }),
    })
  );

  expect(result).toMatchObject({
    decision: 'hold-pending',
    reason: 'persisted-process-identity-missing',
    status: 'unknown',
  });
});

test('an alive observation without a complete PID/start pair remains unknown', () => {
  for (const processObservation of [
    { ownerIdentity: base(), state: 'alive' },
    { ownerIdentity: base(), processId: worker.processId, state: 'alive' },
  ]) {
    const result = reconcileSpansRecovery(request({ processObservation }));

    expect(result).toMatchObject({
      decision: 'hold-pending',
      reason: 'process-observation-identity-missing',
      status: 'unknown',
    });
  }
});

test('worker death does not complete an action without a terminal receipt', () => {
  const result = reconcileSpansRecovery(
    request({ processObservation: { state: 'absent' } })
  );

  expect(result).toMatchObject({
    decision: 'hold-pending',
    reason: 'worker-absent-without-terminal-receipt',
    status: 'worker-dead',
  });
  expect(result).not.toHaveProperty('proposal');
});

test('an older attempt generation is historical against the current run', () => {
  const result = reconcileSpansRecovery(request({ currentGeneration: 5 }));

  expect(result).toMatchObject({
    commitMode: 'historical',
    decision: 'retain-historical',
    status: 'stale',
  });
  expect(result).not.toHaveProperty('proposal');
});

test('an attempt generation ahead of the durable run refuses without creating an event', () => {
  const result = reconcileSpansRecovery(request({ currentGeneration: 3 }));

  expect(result).toEqual({
    code: 'ATTEMPT_GENERATION_AHEAD',
    error:
      'The attempt generation is ahead of the current durable run generation.',
    ok: false,
  });
  expect(result).not.toHaveProperty('events');
  expect(result).not.toHaveProperty('proposal');
});

test('a replaced checkout is orphaned even when the worker appears alive', () => {
  const result = reconcileSpansRecovery(
    request({ currentCheckoutIdentity: otherCheckout })
  );

  expect(result).toMatchObject({
    decision: 'manual-review',
    reason: 'checkout-mismatch',
    status: 'orphaned',
  });
});

test('malformed known checkout identities are rejected and unknown identities stay pending', () => {
  const malformed = [
    { anything: 1, known: true },
    { ...checkout, adminPath: 'workspace/r.git/worktrees/topic' },
    { ...checkout, repository: { dev: '1', ino: '23' } },
    { ...checkout, extra: true },
  ];
  for (const identity of malformed) {
    expect(
      reconcileSpansRecovery(request({ currentCheckoutIdentity: identity }))
    ).toMatchObject({ code: 'INPUT_INVALID', ok: false });
  }

  const unknown = { known: false, reason: 'Checkout could not be inspected' };
  for (const overrides of [
    { currentCheckoutIdentity: unknown },
    { attemptReceipt: attemptReceipt({ checkoutIdentity: unknown }) },
  ]) {
    const result = reconcileSpansRecovery(request(overrides));
    expect(result).toMatchObject({
      decision: 'hold-pending',
      reason: 'checkout-identity-missing',
      status: 'unknown',
    });
    expect(result).not.toHaveProperty('proposal');
  }
});

test('non-code identity must match its run and exact scope owner', () => {
  const nonCode = { kind: 'non-code', runId: 'run-a', scopeId: 'research-a' };
  const result = reconcileSpansRecovery(
    request({
      attemptReceipt: attemptReceipt({ checkoutIdentity: nonCode }),
      currentCheckoutIdentity: nonCode,
      processObservation: observation({
        ownerIdentity: base({ checkoutIdentity: nonCode }),
      }),
    })
  );
  expect(result).toMatchObject({
    decision: 'reattach-worker',
    status: 'worker-alive',
  });

  const wrongScope = { ...nonCode, scopeId: 'research-b' };
  expect(
    reconcileSpansRecovery(
      request({
        attemptReceipt: attemptReceipt({ checkoutIdentity: nonCode }),
        currentCheckoutIdentity: nonCode,
        processObservation: observation({
          ownerIdentity: base({ checkoutIdentity: wrongScope }),
        }),
      })
    )
  ).toMatchObject({
    decision: 'manual-review',
    reason: 'process-owner-identity-mismatch',
    status: 'orphaned',
  });

  expect(
    reconcileSpansRecovery(
      request({
        attemptReceipt: attemptReceipt({ checkoutIdentity: nonCode }),
        currentCheckoutIdentity: wrongScope,
      })
    )
  ).toMatchObject({
    decision: 'manual-review',
    reason: 'checkout-mismatch',
    status: 'orphaned',
  });

  expect(
    reconcileSpansRecovery(
      request({
        attemptReceipt: attemptReceipt({
          checkoutIdentity: { ...nonCode, runId: 'run-b' },
        }),
      })
    )
  ).toMatchObject({ code: 'INPUT_INVALID', ok: false });
});

test('JSON bounds include property names and the total request size', () => {
  const longKey = { ...request(), ['k'.repeat(4097)]: 'value' };
  expect(reconcileSpansRecovery(longKey)).toMatchObject({
    code: 'INPUT_INVALID',
    ok: false,
  });

  const longPath = `/${'x'.repeat(2999)}`;
  const largeIdentity = {
    ...checkout,
    adminPath: longPath,
    checkoutPath: longPath,
    repositoryPath: longPath,
  };
  expect(
    reconcileSpansRecovery(
      request({
        attemptReceipt: attemptReceipt({ checkoutIdentity: largeIdentity }),
        currentCheckoutIdentity: largeIdentity,
        processObservation: observation({
          ownerIdentity: base({ checkoutIdentity: largeIdentity }),
        }),
      })
    )
  ).toMatchObject({ code: 'INPUT_INVALID', ok: false });
});

test('wall-clock rollback does not expire the deadline or reattach automatically', () => {
  const result = reconcileSpansRecovery(
    request({ clock: clock({ wallTimeMs: 9999 }) })
  );

  expect(result).toMatchObject({
    decision: 'hold-pending',
    reason: 'wall-clock-rollback',
    status: 'unknown',
  });
});

test('a deadline without a saved clock baseline remains unknown', () => {
  const result = reconcileSpansRecovery(
    request({
      attemptReceipt: attemptReceipt({ lastObservedWallTimeMs: null }),
    })
  );

  expect(result).toMatchObject({
    decision: 'hold-pending',
    reason: 'clock-baseline-missing',
    status: 'unknown',
  });
});

test('omitting the caller supplied runtime limit is rejected instead of defaulted', () => {
  const missingLimit = attemptReceipt();
  missingLimit.deadlineAtMs = undefined;

  expect(
    reconcileSpansRecovery(request({ attemptReceipt: missingLimit }))
  ).toEqual({
    code: 'INPUT_INVALID',
    error: 'Recovery input is malformed or exceeds its bounds.',
    ok: false,
  });
});

test('a sleep/wake gap past the supplied deadline stays pending', () => {
  const result = reconcileSpansRecovery(
    request({ clock: clock({ sleepWakeGap: true, wallTimeMs: 21_000 }) })
  );

  expect(result).toMatchObject({
    deadlineElapsed: true,
    decision: 'hold-pending',
    reason: 'sleep-wake-gap',
    status: 'sleep-wake-gap',
  });
  expect(result).not.toHaveProperty('proposal');
});

test('an elapsed explicit deadline holds a live worker without stopping it', () => {
  const result = reconcileSpansRecovery(
    request({
      attemptReceipt: attemptReceipt({ deadlineAtMs: 11_999 }),
    })
  );

  expect(result).toMatchObject({
    deadlineElapsed: true,
    decision: 'hold-pending',
    reason: 'deadline-elapsed-worker-still-owned',
    status: 'deadline-elapsed',
    workerState: 'alive',
  });
  expect(result).not.toHaveProperty('proposal');
});

test('a verified exact terminal receipt proposes one terminal CAS transition', () => {
  const terminal = receipt('completed');
  expect(digestSpansRecoveryReceipt(terminal.value)).toEqual({
    ok: true,
    receiptDigest: terminal.digest,
  });
  const result = reconcileSpansRecovery(
    request({
      processObservation: observation({
        terminalReceipt: terminal.value,
        terminalVerification: verification(terminal.digest),
      }),
    })
  );

  expect(result).toMatchObject({
    decision: 'record-terminal',
    ok: true,
    proposal: {
      actionId: 'action-a',
      attemptId: 'attempt-a1',
      evidenceId: 'evidence-a',
      outcome: 'completed',
      receiptDigest: terminal.digest,
    },
    status: 'terminal-recorded',
  });
});

test('a verified unknown receipt remains pending', () => {
  const terminal = receipt('unknown');
  const result = reconcileSpansRecovery(
    request({
      processObservation: observation({
        terminalReceipt: terminal.value,
        terminalVerification: verification(terminal.digest),
      }),
    })
  );

  expect(result).toMatchObject({
    decision: 'hold-pending',
    outcome: 'unknown',
    reason: 'terminal-receipt-reports-unknown',
    status: 'unknown',
  });
  expect(result).not.toHaveProperty('proposal');
});

test('replaying an already persisted terminal receipt is idempotent', () => {
  const terminal = receipt('completed');
  const result = reconcileSpansRecovery(
    request({
      attemptReceipt: attemptReceipt({
        terminalReceipt: terminal.value,
        terminalVerification: verification(terminal.digest),
      }),
      processObservation: observation({
        terminalReceipt: terminal.value,
        terminalVerification: verification(terminal.digest),
      }),
    })
  );

  expect(result).toMatchObject({
    decision: 'replay-terminal',
    duplicate: true,
    outcome: 'completed',
    status: 'terminal-recorded',
  });
  expect(result).not.toHaveProperty('proposal');
});

test('contradictory terminal receipts fail with a bounded refusal', () => {
  const persisted = receipt('completed');
  const reported = receipt('failed', { receiptId: 'receipt-failed' });
  const result = reconcileSpansRecovery(
    request({
      attemptReceipt: attemptReceipt({
        terminalReceipt: persisted.value,
        terminalVerification: verification(persisted.digest),
      }),
      processObservation: observation({
        terminalReceipt: reported.value,
        terminalVerification: verification(reported.digest, 'evidence-b'),
      }),
    })
  );

  expect(result).toEqual({
    code: 'RECEIPT_CONFLICT',
    error: 'The persisted and observed terminal receipts contradict.',
    ok: false,
  });
});

test('unverified terminal data remains pending and output events stay redacted', () => {
  const terminal = receipt('completed');
  const result = reconcileSpansRecovery(
    request({
      processObservation: observation({ terminalReceipt: terminal.value }),
    })
  );

  expect(result).toMatchObject({
    decision: 'hold-pending',
    reason: 'terminal-receipt-unverified',
    status: 'unknown',
  });
  expect(JSON.stringify(result)).not.toContain('processStartIdentity');
  expect(JSON.stringify(result)).not.toContain('checkoutPath');
});

test('terminal verification digest mismatches cannot propose a result', () => {
  const terminal = receipt('completed');
  const mismatchedVerification = verification('0'.repeat(64));
  for (const overrides of [
    {
      processObservation: observation({
        terminalReceipt: terminal.value,
        terminalVerification: mismatchedVerification,
      }),
    },
    {
      attemptReceipt: attemptReceipt({
        terminalReceipt: terminal.value,
        terminalVerification: mismatchedVerification,
      }),
    },
  ]) {
    const result = reconcileSpansRecovery(request(overrides));
    expect(result).toMatchObject({
      decision: 'hold-pending',
      reason: 'terminal-receipt-unverified',
      status: 'unknown',
    });
    expect(result).not.toHaveProperty('proposal');
  }
});

test('an unverified persisted terminal receipt cannot turn into a live reattach', () => {
  const terminal = receipt('completed');
  const result = reconcileSpansRecovery(
    request({
      attemptReceipt: attemptReceipt({ terminalReceipt: terminal.value }),
    })
  );

  expect(result).toMatchObject({
    decision: 'hold-pending',
    reason: 'terminal-receipt-unverified',
    status: 'unknown',
  });
  expect(result.events[0].payload.reason).toBe('terminal-receipt-unverified');
  expect(result).not.toHaveProperty('proposal');
});

test('hostile getter input fails closed with a fixed response', () => {
  const hostile = request();
  Object.defineProperty(hostile, 'currentGeneration', {
    enumerable: true,
    get() {
      throw new Error('do not expose');
    },
  });

  expect(reconcileSpansRecovery(hostile)).toEqual({
    code: 'INPUT_INVALID',
    error: 'Recovery input is malformed or exceeds its bounds.',
    ok: false,
  });
});
