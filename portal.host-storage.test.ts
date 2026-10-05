import { expect, test } from 'bun:test';
import { post } from './portal/api';
import {
  acceptHostStorage,
  formatStorageBytes,
  type HostHealthObservation,
  hostStorageView,
  initialHostStorageRead,
} from './portal/host-storage';

const GiB = 1024 ** 3;
function observation(
  availableBytes: number,
  observedAt = 1
): HostHealthObservation {
  return {
    availableBytes,
    critical: availableBytes < 10 * GiB,
    dockerVm: { state: 'unknown' },
    low: availableBytes < 20 * GiB,
    lowThresholdBytes: 20 * GiB,
    minimumAvailableBytes: 10 * GiB,
    observedAt,
    state: 'ready',
    workspacePath: '/workspace',
  };
}

test('normal space hides the warning without claiming that Docker storage or a new action is safe', () => {
  const view = hostStorageView(
    acceptHostStorage(initialHostStorageRead, observation(55 * GiB))
  );
  expect(view).toMatchObject({ summary: '55 GiB free', title: '', tone: null });
  expect(view.detail).toBe('');
});

test('warning and critical observations explain the server minimum while retaining recovery actions', () => {
  const warning = hostStorageView(
    acceptHostStorage(initialHostStorageRead, observation(15 * GiB))
  );
  const critical = hostStorageView(
    acceptHostStorage(initialHostStorageRead, observation(116 * 1024 ** 2))
  );
  expect(warning.tone).toBe('amber');
  expect(warning.title).toContain('15 GiB free');
  expect(critical.tone).toBe('red');
  expect(critical.title).toContain('116 MiB free');
  expect(critical.detail).toContain(
    'fresh storage check and at least 10 GiB free'
  );
  expect(critical.detail).toContain('Stop and Remove remain available');
  expect(formatStorageBytes(10 * GiB - 1)).toBe('9.9 GiB');
});

test('an unknown observation retains the last measurement without calling it current or healthy', () => {
  const previous = acceptHostStorage(
    initialHostStorageRead,
    observation(55 * GiB)
  );
  const unknown = acceptHostStorage(previous, {
    ...observation(0, 2),
    availableBytes: undefined,
    state: 'unknown',
  });
  const view = hostStorageView(unknown);
  expect(view.tone).toBe('amber');
  expect(view.summary).toBe('Unknown now · last check: 55 GiB free');
  expect(view.lastChecked).toBe(1);
  expect(view.title).toBe('Workspace storage could not be checked.');
});

test('failed refresh retains a critical reading and never clears the warning; newer success recovers', () => {
  const previous = acceptHostStorage(initialHostStorageRead, observation(GiB));
  const failed = acceptHostStorage(previous);
  expect(failed.refreshFailed).toBe(true);
  expect(hostStorageView(failed)).toMatchObject({
    summary: 'Unknown now · last check: 1 GiB free',
    tone: 'red',
  });
  expect(acceptHostStorage(failed, observation(55 * GiB, 0))).toBe(failed);
  expect(acceptHostStorage(failed, observation(GiB, 1))).toBe(failed);
  const recovered = acceptHostStorage(failed, observation(55 * GiB, 2));
  expect(recovered.refreshFailed).toBe(false);
  expect(hostStorageView(recovered).tone).toBeNull();
});

test('a malformed observation time cannot replace or certify the retained measurement', () => {
  const previous = acceptHostStorage(initialHostStorageRead, observation(GiB));
  const malformed = acceptHostStorage(
    previous,
    observation(55 * GiB, Number.NaN)
  );
  expect(malformed.observation).toBe(previous.observation);
  expect(malformed.refreshFailed).toBe(true);
  expect(hostStorageView(malformed).summary).toBe(
    'Unknown now · last check: 1 GiB free'
  );
});

test('missing or invalid observations are unknown rather than zero free space', () => {
  for (const snapshot of [
    undefined,
    observation(Number.NaN),
    observation(-1),
  ]) {
    const view = hostStorageView(
      acceptHostStorage(initialHostStorageRead, snapshot)
    );
    expect(view.summary).toBe('Unknown');
    expect(view.tone).toBe('amber');
  }
});

test('legacy warnings do not invent an admission policy unavailable from that server', () => {
  const legacy = {
    ...observation(GiB),
    critical: undefined,
    lowThresholdBytes: 2 * GiB,
    minimumAvailableBytes: undefined,
  };
  const view = hostStorageView(
    acceptHostStorage(initialHostStorageRead, legacy)
  );
  expect(view.tone).toBe('amber');
  expect(view.detail).not.toContain('10 GiB');
  expect(view.detail).not.toContain('blocked');
});

test('storage admission errors preserve the server explanation without replaying the action', async () => {
  const original = globalThis.fetch;
  const refusals = ['STORAGE_LOW', 'STORAGE_UNKNOWN'].map((code) => ({
    code,
    committed: false,
    error: `${code}: new work was not started`,
    ok: false,
  }));
  let requests = 0;
  try {
    globalThis.fetch = (() => {
      const refusal = refusals[requests];
      requests += 1;
      return Promise.resolve(Response.json(refusal, { status: 409 }));
    }) as typeof fetch;
    const results = await Promise.all(
      refusals.map(() =>
        post('/api/create', { name: 'example', repo: 'owned' })
      )
    );
    expect(results).toEqual(refusals);
    expect(requests).toBe(2);
  } finally {
    globalThis.fetch = original;
  }
});
