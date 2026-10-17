import { expect, test } from 'bun:test';
import {
  createSpansDispatch,
  SPANS_DISPATCH_ADAPTERS,
  SPANS_DISPATCH_CODES,
  SPANS_DISPATCH_STATUSES,
  targetDigestFor,
} from './spans-dispatch.js';

// Synthetic paths and digests only. Every adapter is an in-memory fake: no
// filesystem, Git, process, store, network or provider is touched.
const HEAD = 'd'.repeat(40);
const INPUT = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const PROFILE_DIGEST = '9'.repeat(64);
const DIGEST_REGEX = /^[0-9a-f]{64}$/;
const WRITER_SESSION_REGEX = /^spans-writer-[0-9a-f]{32}$/;
const WT = '/synthetic/spans/wt';
const REPO = '/synthetic/spans/repo.git';
const SECRET = `ghp_${'a'.repeat(24)}`;

const fingerprint = (n) => ({
  birthtimeNs: `10${n}`,
  dev: '1',
  ino: String(n),
});
const IDENTITY = {
  admin: fingerprint(1),
  adminPath: `${REPO}/worktrees/wt`,
  checkout: fingerprint(2),
  checkoutPath: WT,
  known: true,
  repository: fingerprint(3),
  repositoryPath: REPO,
};
const DEPENDENCY = {
  bunVersion: '1.3.14',
  linkerMode: 'isolated',
  lockfileHash: 'f'.repeat(64),
  platformNamespace: 'darwin-arm64',
};
const DIRTY = { count: 0, hash: 'e'.repeat(64) };
const EXPECTED = {
  dependency: DEPENDENCY,
  dirty: DIRTY,
  head: HEAD,
  identity: IDENTITY,
};

const request = (overrides = {}) => ({
  actionId: 'action-1',
  admissionKind: 'session',
  attemptId: 'attempt-1',
  authorizationId: 'auth-1',
  checkout: { expected: structuredClone(EXPECTED), repoDir: REPO, wtDir: WT },
  generation: 1,
  inputDigest: INPUT,
  planVersion: 1,
  profile: 'profile-1',
  requiredCapabilities: ['edit', 'test'],
  runId: 'run-1',
  spanId: 'span-a',
  target: { name: 'feat/x', repo: 'setu' },
  targetDigest: targetDigestFor(EXPECTED),
  ...overrides,
});

const completionInput = (overrides = {}) => ({
  actionId: 'action-1',
  attemptId: 'attempt-1',
  generation: 1,
  runId: 'run-1',
  spanId: 'span-a',
  workerId: 'worker-1',
  wtDir: WT,
  ...overrides,
});

const reply = (value, fallback, input) =>
  typeof value === 'function' ? value(input) : (value ?? fallback);

// The durable owned-worker receipt for a completed span action. The writer
// owner is the one the coordinator claimed, read back from the claim call.
const receiptFor = (world, input, overrides = {}) => ({
  actionId: input.actionId,
  artifactIds: ['artifact-1'],
  attemptId: input.attemptId,
  checkoutIdentity: structuredClone(IDENTITY),
  evidenceId: 'evidence-1',
  generation: input.generation,
  inputDigest: INPUT,
  ok: true,
  outcome: 'completed',
  planVersion: 1,
  runId: input.runId,
  spanId: input.spanId,
  targetDigest: targetDigestFor(EXPECTED),
  terminal: true,
  verified: true,
  workerId: input.workerId,
  writerSession: world.session,
  ...overrides,
});

// The committed acceptance the action layer would write for this action.
const accept = (h, overrides = {}) => {
  h.world.span = {
    acceptedActionId: 'action-1',
    acceptedEvidenceId: 'acceptance-evidence-1',
    state: 'completed',
    ...overrides,
  };
};

// In-memory stand-ins for the Setu stores and the sibling-lane adapters. The
// world object is mutable so a test can change state while a call is awaited.
function harness() {
  const calls = [];
  const world = {
    actions: new Map(),
    archiveAllowed: true,
    capabilities: ['edit', 'test'],
    claim: null,
    dependency: structuredClone(DEPENDENCY),
    dirty: structuredClone(DIRTY),
    generation: 1,
    head: HEAD,
    identity: structuredClone(IDENTITY),
    lastReleaseBinding: null,
    leases: new Map(),
    on: {},
    planVersion: 1,
    profileDigest: PROFILE_DIGEST,
    reservations: new Map(),
    span: null,
  };
  const record = (name, payload, extra = {}) =>
    calls.push({ name, payload: structuredClone(payload ?? null), ...extra });

  const adapters = {
    actions: {
      async prepareAction(input) {
        record('actions.prepareAction', input);
        const override = reply(world.prepareResult, undefined, input);
        if (override !== undefined) {
          return override;
        }
        if (world.actions.has(input.actionId)) {
          return { created: false, ok: true, status: 'intent' };
        }
        if (input.generation !== world.generation) {
          return { code: 'STALE_GENERATION', ok: false };
        }
        const open = [...world.actions.values()].some(
          (action) =>
            action.spanId === input.spanId && action.state !== 'failed'
        );
        if (open) {
          return { code: 'SPAN_ACTION_OPEN', ok: false };
        }
        world.actions.set(input.actionId, {
          actionId: input.actionId,
          attemptId: input.attemptId,
          inputDigest: input.inputDigest,
          outcomeArtifactIds: [],
          planVersion: input.planVersion,
          spanId: input.spanId,
          state: 'intent',
          targetDigest: input.targetDigest,
        });
        await world.on.intent?.();
        return { created: true, ok: true, status: 'intent' };
      },
      recordOutcome(input) {
        record('actions.recordOutcome', input);
        if (world.recordFails) {
          return { code: 'COMMIT_FAILED', ok: false };
        }
        const action = world.actions.get(input.actionId);
        if (!action) {
          return { code: 'ACTION_NOT_FOUND', ok: false };
        }
        if (input.generation !== world.generation) {
          return { code: 'STALE_GENERATION', historical: false, ok: false };
        }
        action.state = input.outcome;
        action.outcomeArtifactIds = [...input.artifactIds];
        return { created: true, ok: true, status: input.outcome };
      },
    },
    admission: {
      async admit(input) {
        record('admission.admit', input);
        await world.on.admit?.();
        const existing = world.leases.get(input.operationId);
        if (existing) {
          return { existing: true, lease: existing, ok: true };
        }
        if (world.capacityFull) {
          return { code: 'SESSION_CAPACITY_REACHED', error: 'full', ok: false };
        }
        const refusal = reply(world.admitResult, undefined, input);
        if (refusal !== undefined) {
          return refusal;
        }
        const lease = {
          acquiredAt: 1,
          kind: input.kind,
          operationId: input.operationId,
          owner: { pid: 1, processStart: 'start-1' },
          target: input.target,
        };
        world.leases.set(input.operationId, lease);
        return { lease, ok: true };
      },
      release(lease) {
        record('admission.release', lease);
        if (!world.leases.delete(lease.operationId)) {
          return { code: 'LEASE_NOT_FOUND', ok: false };
        }
        return { ok: true };
      },
      status() {
        record('admission.status');
        return { leases: [...world.leases.values()], ok: true };
      },
    },
    archive: {
      capacity() {
        record('archive.capacity');
        return { newLaunchAllowed: world.archiveAllowed, ok: true };
      },
    },
    authorization: {
      verify({ authorizationId, binding }) {
        record('authorization.verify', { authorizationId, binding });
        if (world.authorized === false) {
          return { ok: false, verified: false };
        }
        return {
          authorizationId,
          binding: { ...binding, ...world.bindingOverride },
          ok: true,
          verified: true,
        };
      },
    },
    capabilities: {
      async verify(input) {
        record('capabilities.verify', input);
        await world.on.capabilities?.();
        if (world.capabilityError) {
          throw new Error('capability backend detail');
        }
        return {
          ok: true,
          profile: world.profile ?? {
            digest: world.profileDigest,
            id: input.profile,
          },
          verified: world.capabilities,
        };
      },
    },
    checkout: {
      observe(input) {
        record('checkout.observe', input);
        if (world.checkoutUnknown) {
          return { ok: false };
        }
        return {
          dirty: structuredClone(world.dirty),
          head: world.head,
          identity: structuredClone(world.identity),
          ok: true,
        };
      },
    },
    dependencies: {
      observe(input) {
        record('dependencies.observe', input);
        if (world.dependenciesUnknown) {
          return { ok: false };
        }
        return {
          identity: { ...world.dependency, state: 'installed' },
          ok: true,
        };
      },
    },
    runState: {
      read(input) {
        record('runState.read', input);
        const action = world.actions.get(input.actionId);
        return {
          action: action ? structuredClone(action) : null,
          generation: world.generation,
          ok: true,
          planVersion: world.planVersion,
          // biome-ignore lint/suspicious/noUnnecessaryConditions: Mutable fixture state is replaced by later scenario steps.
          span: world.span ? { ...world.span } : null,
        };
      },
    },
    setup: {
      async ensure(input) {
        record('setup.ensure', input);
        await world.on.setup?.();
        return reply(world.setupResult, { ok: true, state: 'ready' }, input);
      },
    },
    usage: {
      release(input) {
        record('usage.release', input);
        world.reservations.delete(input.actionId);
        return { ok: true };
      },
      async reserve(input) {
        record('usage.reserve', input);
        await world.on.usage?.();
        const answer = reply(
          world.usageResult,
          { cap: 'enforced', ok: true, reservationId: 'reservation-1' },
          input
        );
        if (answer.ok) {
          world.reservations.set(input.actionId, answer);
        }
        return answer;
      },
      async settle(input) {
        record('usage.settle', input);
        await world.on.settle?.();
        return world.settleFails ? { ok: false } : { ok: true };
      },
    },
    worker: {
      // Stands in for a worker that honours the effect-boundary fence: it
      // refuses before dispatch when the generation moved, and echoes the fence.
      async launch(input) {
        record('worker.launch', input, {
          actionState: world.actions.get(input.actionId)?.state,
        });
        await world.on.launch?.();
        if (input.fence.generation !== world.generation) {
          return { code: 'FENCE_STALE', dispatched: false, ok: false };
        }
        return reply(
          world.launchResult,
          {
            dispatched: true,
            fence: input.fence,
            ok: true,
            workerId: 'worker-1',
          },
          input
        );
      },
      verifyCompletion(input) {
        record('worker.verifyCompletion', input);
        return reply(world.completionResult, receiptFor(world, input), input);
      },
    },
    writer: {
      async check({ checkoutPath, session }) {
        record('writer.check', { checkoutPath, session });
        await world.on.writerCheck?.();
        const claim =
          // biome-ignore lint/suspicious/noUnnecessaryConditions: Mutable fixture state is replaced by later scenario steps.
          world.claim && checkoutPath === WT ? { ...world.claim } : null;
        return {
          claim,
          // biome-ignore lint/suspicious/noUnnecessaryConditions: Mutable fixture state is replaced by later scenario steps.
          ok: !claim || claim.session === session,
          wtDir: checkoutPath,
        };
      },
      claim({ owner }) {
        record('writer.claim', owner);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Mutable fixture state is replaced by later scenario steps.
        if (world.claim && world.claim.session !== owner.session) {
          return { code: 'WRITER_BUSY', ok: false };
        }
        world.claim = { session: owner.session };
        world.session = owner.session;
        return {
          claim: { ...world.claim },
          ok: true,
          wtDir: world.claimDir ?? WT,
        };
      },
      release({ binding, checkoutPath, session }) {
        record('writer.release', { binding, checkoutPath, session });
        world.lastReleaseBinding = binding;
        if (checkoutPath === WT && world.claim?.session === session) {
          world.claim = null;
        }
        return { ok: true, released: true };
      },
    },
  };

  const dispatcher = createSpansDispatch({ adapters });
  return {
    adapters,
    calls,
    completeOwned: dispatcher.completeOwned,
    count: (name) => calls.filter((call) => call.name === name).length,
    dispatch: dispatcher.dispatch,
    find: (name) => calls.find((call) => call.name === name),
    names: () => calls.map((call) => call.name),
    world,
  };
}

function expectBounded(result) {
  expect(Object.hasOwn(SPANS_DISPATCH_CODES, result.code)).toBe(true);
  expect(Object.values(SPANS_DISPATCH_STATUSES).includes(result.status)).toBe(
    true
  );
}

function expectNoLaunch(h, result) {
  expectBounded(result);
  expect(result.ok).toBe(false);
  expect(result.launched).toBe(false);
  expect(h.count('worker.launch')).toBe(0);
}

const RELEASE_CALLS = [
  'admission.release',
  'usage.release',
  'usage.settle',
  'writer.release',
];

// ---------------------------------------------------------------------------
// Happy path and ordering
// ---------------------------------------------------------------------------

test('launches in order with the intent durable before the worker call', async () => {
  const h = harness();
  const result = await h.dispatch(request());

  expect(result).toMatchObject({
    accepted: false,
    code: 'LAUNCHED',
    effect: 'launched',
    launched: true,
    ok: true,
    resources: { admission: 'held', usage: 'held', writer: 'held' },
    status: 'launched',
    workerId: 'worker-1',
  });
  const order = h.names();
  const first = (name) => order.indexOf(name);
  expect(first('writer.claim')).toBeGreaterThan(-1);
  expect(first('writer.claim')).toBeLessThan(first('setup.ensure'));
  expect(first('setup.ensure')).toBeLessThan(first('admission.admit'));
  expect(first('admission.admit')).toBeLessThan(first('usage.reserve'));
  expect(first('usage.reserve')).toBeLessThan(first('actions.prepareAction'));
  expect(first('actions.prepareAction')).toBeLessThan(first('worker.launch'));
  expect(h.find('worker.launch').actionState).toBe('intent');
  expect(h.find('worker.launch').payload.usage).toEqual({
    reservationId: 'reservation-1',
  });
  // Authorization and the exact bindings are rechecked before each effect.
  expect(h.count('authorization.verify')).toBe(4);
  expect(h.count('capabilities.verify')).toBe(4);
  expect(h.count('checkout.observe')).toBe(4);
  expect(h.count('dependencies.observe')).toBe(4);
  expect(order.some((name) => RELEASE_CALLS.includes(name))).toBe(false);
  expect(h.world.claim).not.toBeNull();
  expect(h.world.leases.size).toBe(1);
});

test('the writer claim is requested for the exact checkout under a span-scoped owner', async () => {
  const h = harness();
  await h.dispatch(request());
  const owner = h.find('writer.claim').payload;
  expect(owner.agent).toBe('spans');
  expect(owner.session).toMatch(WRITER_SESSION_REGEX);
  // A second attempt of the same span re-claims the same owner.
  await h.dispatch(request({ actionId: 'action-9', attemptId: 'attempt-9' }));
  const owners = h.calls
    .filter((call) => call.name === 'writer.claim')
    .map((call) => call.payload.session);
  expect(new Set(owners).size).toBe(1);
});

test('the sha256: spelling of a digest is the same digest', async () => {
  const h = harness();
  h.world.bindingOverride = { inputDigest: `sha256:${INPUT}` };
  const result = await h.dispatch(
    request({
      inputDigest: `sha256:${INPUT}`,
      targetDigest: `sha256:${targetDigestFor(EXPECTED)}`,
    })
  );
  expect(result.status).toBe('launched');
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

test('construction never throws and an empty coordinator refuses everything', async () => {
  const dispatcher = createSpansDispatch();
  const refused = await dispatcher.dispatch(request());
  expect(refused.code).toBe('ADAPTER_MISSING');
  expect(refused.launched).toBe(false);
  expect(refused.missing).toContain('worker.launch');
  expect((await dispatcher.completeOwned(completionInput())).code).toBe(
    'ADAPTER_MISSING'
  );
});

for (const [name, methods] of Object.entries(SPANS_DISPATCH_ADAPTERS)) {
  test(`a missing ${name} adapter refuses before any other adapter runs`, async () => {
    const h = harness();
    const { [name]: _removed, ...rest } = h.adapters;
    const result = await createSpansDispatch({ adapters: rest }).dispatch(
      request()
    );
    expect(result.code).toBe('ADAPTER_MISSING');
    expect(result.status).toBe('refused');
    expect(result.missing).toEqual(
      methods.map((method) => `${name}.${method}`)
    );
    expect(h.calls).toEqual([]);
  });

  for (const method of methods) {
    test(`${name}.${method} must be a function`, async () => {
      const h = harness();
      const adapters = {
        ...h.adapters,
        [name]: { ...h.adapters[name], [method]: 'not a function' },
      };
      const result = await createSpansDispatch({ adapters }).dispatch(
        request()
      );
      expect(result.code).toBe('ADAPTER_MISSING');
      expect(result.missing).toEqual([`${name}.${method}`]);
      expect(h.calls).toEqual([]);
    });
  }
}

const INVALID_REQUESTS = [
  ['no request', undefined, 'request'],
  ['no authorization id', { authorizationId: undefined }, 'authorizationId'],
  ['a negative generation', { generation: -1 }, 'generation'],
  ['a malformed digest', { inputDigest: 'xyz' }, 'inputDigest'],
  ['an install admission kind', { admissionKind: 'install' }, 'admissionKind'],
  ['no capabilities', { requiredCapabilities: [] }, 'requiredCapabilities'],
  [
    'duplicate capabilities',
    { requiredCapabilities: ['a', 'a'] },
    'requiredCapabilities',
  ],
  ['an unsafe target', { target: { name: '../x', repo: 'setu' } }, 'target'],
  [
    'a relative checkout path',
    { checkout: { ...request().checkout, wtDir: 'relative' } },
    'checkout',
  ],
  [
    'an incomplete expected snapshot',
    { checkout: { ...request().checkout, expected: { head: HEAD } } },
    'checkout.expected',
  ],
  [
    'a non-boolean cap flag',
    { requireEnforcedCap: 'yes' },
    'requireEnforcedCap',
  ],
];

for (const [label, overrides, field] of INVALID_REQUESTS) {
  test(`${label} refuses before any adapter runs`, async () => {
    const h = harness();
    const result = await h.dispatch(
      overrides === undefined ? undefined : request(overrides)
    );
    expect(result).toMatchObject({ code: 'REQUEST_INVALID', field });
    expectNoLaunch(h, result);
    expect(h.calls).toEqual([]);
  });
}

test('a secret-looking identifier is refused and never reflected', async () => {
  const h = harness();
  const result = await h.dispatch(request({ actionId: SECRET }));
  expect(result.code).toBe('SENSITIVE_VALUE');
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(h.calls).toEqual([]);
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test('no generic approval flag substitutes for a verified authorization', async () => {
  const h = harness();
  h.world.authorized = false;
  const result = await h.dispatch(
    request({ approval: { approved: true }, approved: true, authorized: true })
  );
  expect(result.code).toBe('AUTHORIZATION_MISSING');
  expectNoLaunch(h, result);
  expect(h.names()).toEqual(['capabilities.verify', 'authorization.verify']);
});

const EXACT_BINDING = {
  action: 'spans.dispatch',
  actionId: 'action-1',
  admissionKind: 'session',
  attemptId: 'attempt-1',
  generation: 1,
  inputDigest: INPUT,
  planVersion: 1,
  profile: 'profile-1',
  profileDigest: PROFILE_DIGEST,
  repoDir: REPO,
  requiredCapabilities: ['edit', 'test'],
  requireEnforcedCap: false,
  runId: 'run-1',
  spanId: 'span-a',
  targetDigest: targetDigestFor(EXPECTED),
  targetName: 'feat/x',
  targetRepo: 'setu',
  wtDir: WT,
};

test('the authorization adapter is asked for the exact bound dispatch', async () => {
  const h = harness();
  await h.dispatch(request());
  expect(h.find('authorization.verify').payload).toEqual({
    authorizationId: 'auth-1',
    binding: EXACT_BINDING,
  });
});

const BINDING_DRIFT = {
  action: 'spans.other',
  actionId: 'action-other',
  admissionKind: 'headless-run',
  attemptId: 'attempt-other',
  generation: 2,
  inputDigest: OTHER_DIGEST,
  planVersion: 2,
  profile: 'profile-other',
  profileDigest: OTHER_DIGEST,
  repoDir: '/synthetic/spans/other.git',
  requiredCapabilities: ['edit'],
  requireEnforcedCap: true,
  runId: 'run-other',
  spanId: 'span-other',
  targetDigest: 'c'.repeat(64),
  targetName: 'feat/other',
  targetRepo: 'other',
  wtDir: '/synthetic/spans/other',
};

test('every binding field has a drift case', () => {
  expect(Object.keys(BINDING_DRIFT)).toEqual(Object.keys(EXACT_BINDING));
});

for (const [field, value] of Object.entries(BINDING_DRIFT)) {
  test(`an authorization bound to a different ${field} is refused`, async () => {
    const h = harness();
    h.world.bindingOverride = { [field]: value };
    const result = await h.dispatch(request());
    expect(result.code).toBe('AUTHORIZATION_MISMATCH');
    expectNoLaunch(h, result);
    expect(h.count('writer.claim')).toBe(0);
    expect(h.count('actions.prepareAction')).toBe(0);
  });
}

test('an authorization receipt without a binding or for another id is refused', async () => {
  const h = harness();
  h.adapters.authorization.verify = async () => ({
    ok: true,
    verified: true,
  });
  expect((await h.dispatch(request())).code).toBe('AUTHORIZATION_MISMATCH');

  h.adapters.authorization.verify = () => {
    throw new Error('auth backend detail');
  };
  const unavailable = await h.dispatch(request());
  expect(unavailable.code).toBe('AUTHORIZATION_UNAVAILABLE');
  expect(JSON.stringify(unavailable)).not.toContain('backend detail');

  h.adapters.authorization.verify = async ({ binding }) => ({
    authorizationId: 'auth-other',
    binding,
    ok: true,
    verified: true,
  });
  expect((await h.dispatch(request())).code).toBe('AUTHORIZATION_MISMATCH');
  expect(h.count('writer.claim')).toBe(0);
});

test('an authorization withdrawn during setup stops the launch', async () => {
  const h = harness();
  h.world.on.setup = () => {
    h.world.authorized = false;
  };
  const result = await h.dispatch(request());
  expect(result.code).toBe('AUTHORIZATION_MISSING');
  expectNoLaunch(h, result);
  expect(h.count('actions.prepareAction')).toBe(0);
  expect(h.world.leases.size).toBe(0);
  expect(result.resources.admission).toBe('released');
});

test('an edited target no longer matches its target digest', async () => {
  const h = harness();
  const edited = request();
  edited.checkout.expected.head = 'c'.repeat(40);
  const result = await h.dispatch(edited);
  expect(result.code).toBe('TARGET_DIGEST_MISMATCH');
  expect(h.calls).toEqual([]);
});

// A store that holds one approved binding and ignores what is asked, so an
// approval is never satisfied by echoing the request back.
const approvalStore =
  (approved) =>
  async ({ authorizationId }) => ({
    authorizationId,
    binding: structuredClone(approved),
    ok: true,
    verified: true,
  });

async function approvedBinding() {
  const h = harness();
  await h.dispatch(request());
  return h.find('authorization.verify').payload.binding;
}

const REPLAYS = [
  ['another profile', { profile: 'profile-2' }],
  ['other capabilities', { requiredCapabilities: ['edit'] }],
  ['a hard usage cap', { requireEnforcedCap: true }],
  ['another admission kind', { admissionKind: 'headless-run' }],
  [
    'another checkout path',
    {
      checkout: { ...request().checkout, wtDir: '/synthetic/spans/elsewhere' },
    },
  ],
  [
    'another repository path',
    { checkout: { ...request().checkout, repoDir: '/synthetic/spans/o.git' } },
  ],
  ['another admission target', { target: { name: 'feat/y', repo: 'setu' } }],
];

test('the exact approved binding still launches', async () => {
  const approved = await approvedBinding();
  const h = harness();
  h.adapters.authorization.verify = approvalStore(approved);
  expect((await h.dispatch(request())).status).toBe('launched');
});

for (const [label, overrides] of REPLAYS) {
  test(`an approval for one dispatch is not replayed for ${label}`, async () => {
    const approved = await approvedBinding();
    const h = harness();
    h.adapters.authorization.verify = approvalStore(approved);
    const result = await h.dispatch(request(overrides));
    expect(result.code).toBe('AUTHORIZATION_MISMATCH');
    expectNoLaunch(h, result);
    expect(h.count('writer.claim')).toBe(0);
    expect(h.count('actions.prepareAction')).toBe(0);
  });
}

test('an approval for one profile digest is not replayed for a changed profile', async () => {
  const approved = await approvedBinding();
  const h = harness();
  h.world.profileDigest = OTHER_DIGEST;
  h.adapters.authorization.verify = approvalStore(approved);
  const result = await h.dispatch(request());
  expect(result.code).toBe('AUTHORIZATION_MISMATCH');
  expectNoLaunch(h, result);
  expect(h.count('writer.claim')).toBe(0);
});

test('an approval that echoes a profile digest as sha256: is the same digest', async () => {
  const h = harness();
  h.world.profileDigest = `sha256:${PROFILE_DIGEST}`;
  h.world.bindingOverride = { profileDigest: `sha256:${PROFILE_DIGEST}` };
  const result = await h.dispatch(request());
  expect(result.status).toBe('launched');
  expect(h.find('worker.launch').payload.profileDigest).toBe(PROFILE_DIGEST);
});

// ---------------------------------------------------------------------------
// Model profile identity
// ---------------------------------------------------------------------------

const UNTRUSTED_PROFILES = [
  ['another id', { digest: PROFILE_DIGEST, id: 'profile-other' }],
  ['no digest', { id: 'profile-1' }],
  ['a malformed digest', { digest: 'latest', id: 'profile-1' }],
];

for (const [label, profile] of UNTRUSTED_PROFILES) {
  test(`a profile identity with ${label} is not verified and nothing starts`, async () => {
    const h = harness();
    h.world.profile = profile;
    const result = await h.dispatch(request());
    expect(result.code).toBe('PROFILE_UNVERIFIED');
    expectNoLaunch(h, result);
    expect(h.count('authorization.verify')).toBe(0);
    expect(h.count('writer.claim')).toBe(0);
  });
}

test('a profile digest that changes during setup stops before the intent', async () => {
  const h = harness();
  h.world.on.setup = () => {
    h.world.profileDigest = OTHER_DIGEST;
  };
  const result = await h.dispatch(request());
  expect(result.code).toBe('PROFILE_CHANGED');
  expectNoLaunch(h, result);
  expect(h.count('actions.prepareAction')).toBe(0);
  expect(h.world.leases.size).toBe(0);
});

// Capabilities are verified again after every wait, not only at the start.
for (const point of ['setup', 'admit', 'usage', 'intent']) {
  test(`a capability revoked during ${point} stops the launch`, async () => {
    const h = harness();
    h.world.on[point] = () => {
      h.world.capabilities = ['edit'];
    };
    const result = await h.dispatch(request());
    expect(result).toMatchObject({
      code: 'CAPABILITY_MISSING',
      missingCapabilities: ['test'],
    });
    expectNoLaunch(h, result);
    expect(h.world.leases.size).toBe(0);
    if (point === 'intent') {
      expect(h.world.actions.get('action-1').state).toBe('failed');
    } else {
      expect(h.count('actions.prepareAction')).toBe(0);
    }
  });
}

// ---------------------------------------------------------------------------
// Effect-boundary fence
// ---------------------------------------------------------------------------

test('the worker receives the exact verified binding and a mandatory fence', async () => {
  const h = harness();
  await h.dispatch(request());
  const call = h.find('worker.launch').payload;
  expect(call.binding).toEqual(EXACT_BINDING);
  expect(call.profileDigest).toBe(PROFILE_DIGEST);
  expect(call.fence).toMatchObject({
    actionId: 'action-1',
    generation: 1,
    planVersion: 1,
    runId: 'run-1',
    spanId: 'span-a',
    writerSession: h.world.session,
  });
  expect(call.fence.bindingDigest).toMatch(DIGEST_REGEX);
});

test('a generation that moves during the last awaited check never launches', async () => {
  const h = harness();
  // The first writer checks run before the intent exists; only the final one
  // moves the generation, immediately before the run state is read last.
  h.world.on.writerCheck = () => {
    if (h.world.actions.size > 0) {
      h.world.generation = 2;
    }
  };
  const result = await h.dispatch(request());
  expect(result.code).toBe('STALE_GENERATION');
  expectNoLaunch(h, result);
  expect(result.outcomeRecorded).toBe(false);
  expect(h.world.actions.get('action-1').state).toBe('intent');
  expect(h.world.leases.size).toBe(1);
});

test('the final pass ends with the run state read', async () => {
  const h = harness();
  await h.dispatch(request());
  const names = h.names();
  expect(names.slice(names.lastIndexOf('worker.launch') - 2)).toEqual([
    'writer.check',
    'runState.read',
    'worker.launch',
  ]);
});

test('a worker that sees a stale fence refuses before dispatch', async () => {
  const h = harness();
  h.world.on.launch = () => {
    h.world.generation = 2;
  };
  const result = await h.dispatch(request());
  expect(result).toMatchObject({
    code: 'LAUNCH_REFUSED',
    launched: false,
    status: 'refused',
    workerCode: 'FENCE_STALE',
  });
  expect(h.count('worker.launch')).toBe(1);
});

// ---------------------------------------------------------------------------
// Capabilities, archive capacity and the observed checkout
// ---------------------------------------------------------------------------

test('a missing capability refuses before the writer claim', async () => {
  const h = harness();
  h.world.capabilities = ['edit'];
  const result = await h.dispatch(request());
  expect(result).toMatchObject({
    code: 'CAPABILITY_MISSING',
    missingCapabilities: ['test'],
  });
  expectNoLaunch(h, result);
  expect(h.count('writer.claim')).toBe(0);
});

test('an unavailable capability check fails closed without echoing detail', async () => {
  const h = harness();
  h.world.capabilityError = true;
  const result = await h.dispatch(request());
  expect(result.code).toBe('CAPABILITY_UNAVAILABLE');
  expect(JSON.stringify(result)).not.toContain('backend detail');
  expectNoLaunch(h, result);
  expect(h.count('writer.claim')).toBe(0);
});

test('archive capacity at the limit or unknown refuses a new launch', async () => {
  const h = harness();
  h.world.archiveAllowed = false;
  const result = await h.dispatch(request());
  expect(result.code).toBe('ARCHIVE_CAPACITY_BLOCKED');
  expectNoLaunch(h, result);
  expect(h.count('writer.claim')).toBe(0);

  h.adapters.archive.capacity = () => {
    throw new Error('unreadable');
  };
  expect((await h.dispatch(request())).code).toBe('ARCHIVE_CAPACITY_BLOCKED');
});

test('archive capacity that fills during admission releases the new lease', async () => {
  const h = harness();
  h.world.on.admit = () => {
    h.world.archiveAllowed = false;
  };
  const result = await h.dispatch(request());
  expect(result.code).toBe('ARCHIVE_CAPACITY_BLOCKED');
  expectNoLaunch(h, result);
  expect(h.world.leases.size).toBe(0);
});

test('an unobservable checkout or dependency identity fails closed', async () => {
  const h = harness();
  h.world.checkoutUnknown = true;
  expect((await h.dispatch(request())).code).toBe('CHECKOUT_UNKNOWN');
  h.world.checkoutUnknown = false;
  h.world.dependenciesUnknown = true;
  expect((await h.dispatch(request())).code).toBe('DEPENDENCY_UNKNOWN');
  expect(h.count('writer.claim')).toBe(0);
  expect(h.count('worker.launch')).toBe(0);
});

// ---------------------------------------------------------------------------
// Drift: fresh exact HEAD, dirty, lockfile and checkout identity
// ---------------------------------------------------------------------------

const DRIFTS = [
  [
    'HEAD_CHANGED',
    (world) => {
      world.head = 'f'.repeat(40);
    },
  ],
  [
    'DIRTY_CHANGED',
    (world) => {
      world.dirty = { count: 1, hash: '1'.repeat(64) };
    },
  ],
  [
    'LOCKFILE_CHANGED',
    (world) => {
      world.dependency.lockfileHash = '2'.repeat(64);
    },
  ],
  [
    'DEPENDENCY_IDENTITY_CHANGED',
    (world) => {
      world.dependency.linkerMode = 'hoisted';
    },
  ],
  [
    'CHECKOUT_IDENTITY_CHANGED',
    (world) => {
      world.identity.checkout.ino = '99';
    },
  ],
];

for (const [code, drift] of DRIFTS) {
  test(`${code} before the start refuses before the writer claim`, async () => {
    const h = harness();
    drift(h.world);
    const result = await h.dispatch(request());
    expect(result.code).toBe(code);
    expectNoLaunch(h, result);
    expect(h.count('writer.claim')).toBe(0);
  });

  test(`${code} while waiting for admission releases it and never launches`, async () => {
    const h = harness();
    h.world.on.admit = () => drift(h.world);
    const result = await h.dispatch(request());
    expect(result.code).toBe(code);
    expectNoLaunch(h, result);
    expect(h.count('usage.reserve')).toBe(0);
    expect(h.count('actions.prepareAction')).toBe(0);
    expect(h.world.leases.size).toBe(0);
    expect(result.resources).toEqual({
      admission: 'released',
      usage: 'none',
      writer: 'held',
    });
    expect(h.world.claim).not.toBeNull();
  });

  test(`${code} during setup is caught by the recheck`, async () => {
    const h = harness();
    h.world.on.setup = () => drift(h.world);
    const result = await h.dispatch(request());
    expect(result.code).toBe(code);
    expectNoLaunch(h, result);
    expect(h.count('actions.prepareAction')).toBe(0);
    expect(h.world.leases.size).toBe(0);
  });

  test(`${code} during the usage reservation releases both holds`, async () => {
    const h = harness();
    h.world.on.usage = () => drift(h.world);
    const result = await h.dispatch(request());
    expect(result.code).toBe(code);
    expectNoLaunch(h, result);
    expect(h.count('actions.prepareAction')).toBe(0);
    expect(h.count('usage.release')).toBe(1);
    expect(h.world.leases.size).toBe(0);
    expect(result.resources).toMatchObject({
      admission: 'released',
      usage: 'released',
    });
  });

  test(`${code} after the intent marks it failed and never launches`, async () => {
    const h = harness();
    h.world.on.intent = () => drift(h.world);
    const result = await h.dispatch(request());
    expect(result.code).toBe(code);
    expectNoLaunch(h, result);
    expect(result.outcomeRecorded).toBe(true);
    expect(h.world.actions.get('action-1').state).toBe('failed');
    expect(h.world.leases.size).toBe(0);
    expect(h.world.claim).not.toBeNull();
  });
}

test('an intent that cannot be marked failed keeps the resources held', async () => {
  const h = harness();
  h.world.on.intent = () => {
    h.world.head = 'f'.repeat(40);
    h.world.recordFails = true;
  };
  const result = await h.dispatch(request());
  expect(result.code).toBe('HEAD_CHANGED');
  expectNoLaunch(h, result);
  expect(result.outcomeRecorded).toBe(false);
  expect(result.resources).toMatchObject({ admission: 'held', usage: 'held' });
  expect(h.world.leases.size).toBe(1);
  expect(h.world.actions.get('action-1').state).toBe('intent');
});

// ---------------------------------------------------------------------------
// Writer lease
// ---------------------------------------------------------------------------

test('a busy writer refuses before setup, admission or launch', async () => {
  const h = harness();
  h.world.claim = { session: 'someone-else' };
  const result = await h.dispatch(request());
  expect(result.code).toBe('WRITER_BUSY');
  expectNoLaunch(h, result);
  expect(h.count('setup.ensure')).toBe(0);
  expect(h.count('admission.admit')).toBe(0);
  expect(h.world.claim.session).toBe('someone-else');
});

test('a claim for a different checkout is refused before setup', async () => {
  const h = harness();
  h.world.claimDir = '/synthetic/spans/elsewhere';
  const result = await h.dispatch(request());
  expect(result.code).toBe('WRITER_TARGET_MISMATCH');
  expectNoLaunch(h, result);
  expect(h.count('setup.ensure')).toBe(0);
});

test('an unconfirmed writer claim fails closed and is reported as unknown', async () => {
  const h = harness();
  h.adapters.writer.claim = () => {
    throw new Error('claim backend detail');
  };
  const result = await h.dispatch(request());
  expect(result.code).toBe('WRITER_UNAVAILABLE');
  expect(result.resources.writer).toBe('unknown');
  expect(JSON.stringify(result)).not.toContain('backend detail');
  expect(h.count('setup.ensure')).toBe(0);
});

test('a lease taken over during setup is a late lease and stops the launch', async () => {
  const h = harness();
  h.world.on.setup = () => {
    h.world.claim = { session: 'intruder' };
  };
  const result = await h.dispatch(request());
  expect(result.code).toBe('WRITER_LEASE_LOST');
  expectNoLaunch(h, result);
  expect(h.count('actions.prepareAction')).toBe(0);
  expect(h.world.leases.size).toBe(0);
  // The coordinator never releases or overwrites a claim it does not hold.
  expect(h.world.claim.session).toBe('intruder');
  expect(h.count('writer.release')).toBe(0);
});

test('a claim that disappears is not treated as unclaimed', async () => {
  const h = harness();
  h.world.on.setup = () => {
    h.world.claim = null;
  };
  const result = await h.dispatch(request());
  expect(result.code).toBe('WRITER_LEASE_LOST');
  expectNoLaunch(h, result);
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const SETUP_CASES = [
  [
    { code: 'SETUP_PROGRESS_UNAVAILABLE', ok: false },
    'SETUP_FAILED',
    'refused',
  ],
  [{ ok: true, state: 'installing' }, 'SETUP_NOT_READY', 'refused'],
  [
    { code: 'SETUP_ALREADY_RUNNING', ok: false },
    'SETUP_IN_PROGRESS',
    'refused',
  ],
  [{ code: 'OPERATION_UNKNOWN', ok: false }, 'SETUP_UNKNOWN', 'held'],
  [
    () => {
      throw Object.assign(new Error('install detail'), {
        code: 'OPERATION_UNKNOWN',
      });
    },
    'SETUP_UNKNOWN',
    'held',
  ],
  [
    () => {
      throw new Error('install detail');
    },
    'SETUP_FAILED',
    'refused',
  ],
];

for (const [setupResult, code, status] of SETUP_CASES) {
  test(`setup answering ${code} keeps the writer and never admits or launches`, async () => {
    const h = harness();
    h.world.setupResult = setupResult;
    const result = await h.dispatch(request());
    expect(result).toMatchObject({ code, status });
    expectNoLaunch(h, result);
    expect(JSON.stringify(result)).not.toContain('install detail');
    expect(h.count('admission.admit')).toBe(0);
    expect(h.count('actions.prepareAction')).toBe(0);
    expect(result.resources.writer).toBe('held');
    expect(h.world.claim).not.toBeNull();
    expect(h.count('writer.release')).toBe(0);
  });
}

test('only an allow-listed setup code is reported', async () => {
  const h = harness();
  h.world.setupResult = { code: 'DEPENDENCY_VIEW_UNSAFE', ok: false };
  expect(await h.dispatch(request())).toMatchObject({
    code: 'SETUP_FAILED',
    setupCode: 'DEPENDENCY_VIEW_UNSAFE',
  });
  h.world.setupResult = { code: SECRET, ok: false };
  const result = await h.dispatch(request());
  expect(result.code).toBe('SETUP_FAILED');
  expect(result.setupCode).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Capacity wait
// ---------------------------------------------------------------------------

test('capacity waits without a launch, intent, reservation or retry attempt', async () => {
  const h = harness();
  h.world.capacityFull = true;
  const waiting = await h.dispatch(request());
  expect(waiting).toMatchObject({
    code: 'CAPACITY_WAIT',
    effect: 'none',
    launched: false,
    ok: false,
    reason: 'session-capacity',
    retryAllowed: true,
    retryAttemptCreated: false,
    status: 'wait',
  });
  expect(h.count('actions.prepareAction')).toBe(0);
  expect(h.count('usage.reserve')).toBe(0);
  expect(h.count('worker.launch')).toBe(0);
  expect(h.world.actions.size).toBe(0);
  expect(waiting.resources).toEqual({
    admission: 'none',
    usage: 'none',
    writer: 'held',
  });

  // Repeated waits still create nothing; once capacity frees, the same
  // action and attempt launch with exactly one intent.
  await h.dispatch(request());
  h.world.capacityFull = false;
  const launchedResult = await h.dispatch(request());
  expect(launchedResult.status).toBe('launched');
  expect(h.count('actions.prepareAction')).toBe(1);
  expect(h.count('usage.reserve')).toBe(1);
  expect(h.count('worker.launch')).toBe(1);
});

test('the install lane being busy is also a wait, not a retry', async () => {
  const h = harness();
  h.world.admitResult = { code: 'INSTALL_IN_PROGRESS', ok: false };
  const result = await h.dispatch(request());
  expect(result).toMatchObject({
    reason: 'install-lane',
    retryAttemptCreated: false,
    status: 'wait',
  });
});

test('other admission refusals are refusals, not waits, with a bounded code', async () => {
  const h = harness();
  h.world.admitResult = {
    code: 'STORAGE_LOW',
    error: 'disk is nearly full',
    ok: false,
  };
  const low = await h.dispatch(request());
  expect(low).toMatchObject({
    admissionCode: 'STORAGE_LOW',
    code: 'ADMISSION_REFUSED',
    status: 'refused',
  });
  expect(JSON.stringify(low)).not.toContain('nearly full');

  h.world.admitResult = { code: SECRET, error: SECRET, ok: false };
  const odd = await h.dispatch(request());
  expect(odd.code).toBe('ADMISSION_REFUSED');
  expect(odd.admissionCode).toBeUndefined();
  expect(JSON.stringify(odd)).not.toContain(SECRET);

  h.adapters.admission.admit = () => {
    throw new Error('state detail');
  };
  const thrown = await h.dispatch(request());
  expect(thrown.code).toBe('ADMISSION_UNAVAILABLE');
  expect(thrown.resources.admission).toBe('unknown');
  expect(h.count('actions.prepareAction')).toBe(0);
});

// ---------------------------------------------------------------------------
// Generation and plan fencing
// ---------------------------------------------------------------------------

test('a stale generation is refused before any effect', async () => {
  const h = harness();
  h.world.generation = 2;
  const result = await h.dispatch(request({ generation: 1 }));
  expect(result.code).toBe('STALE_GENERATION');
  expectNoLaunch(h, result);
  expect(h.names()).toEqual([
    'capabilities.verify',
    'authorization.verify',
    'runState.read',
  ]);
});

test('a changed plan version is refused', async () => {
  const h = harness();
  h.world.planVersion = 2;
  const result = await h.dispatch(request());
  expect(result.code).toBe('PLAN_CHANGED');
  expectNoLaunch(h, result);
});

test('a generation that advances while admission is awaited releases the late lease', async () => {
  const h = harness();
  h.world.on.admit = () => {
    h.world.generation = 2;
  };
  const result = await h.dispatch(request());
  expect(result.code).toBe('STALE_GENERATION');
  expectNoLaunch(h, result);
  expect(h.world.leases.size).toBe(0);
  expect(h.count('actions.prepareAction')).toBe(0);
});

test('a generation that advances during setup stops before the intent', async () => {
  const h = harness();
  h.world.on.setup = () => {
    h.world.generation = 2;
  };
  const result = await h.dispatch(request());
  expect(result.code).toBe('STALE_GENERATION');
  expectNoLaunch(h, result);
  expect(h.world.actions.size).toBe(0);
});

test('a store-side stale generation on the intent releases and never launches', async () => {
  const h = harness();
  h.world.prepareResult = { code: 'STALE_GENERATION', ok: false };
  const result = await h.dispatch(request());
  expect(result.code).toBe('STALE_GENERATION');
  expectNoLaunch(h, result);
  expect(h.world.leases.size).toBe(0);
});

const UNCONFIRMED_INTENTS = [
  ['a commit failure', { code: 'COMMIT_FAILED', ok: false }],
  [
    'a thrown error',
    () => {
      throw new Error('disk detail');
    },
  ],
];

for (const [label, prepareResult] of UNCONFIRMED_INTENTS) {
  test(`an unconfirmed intent (${label}) never launches and keeps its holdings`, async () => {
    const h = harness();
    h.world.prepareResult = prepareResult;
    const result = await h.dispatch(request());
    expect(result.code).toBe('INTENT_NOT_CONFIRMED');
    expectNoLaunch(h, result);
    expect(JSON.stringify(result)).not.toContain('disk detail');
    expect(h.world.leases.size).toBe(1);
    expect(h.count('admission.release')).toBe(0);
    expect(h.count('usage.release')).toBe(0);
  });
}

test('a refused intent reports a bounded cause and releases its holdings', async () => {
  const h = harness();
  h.world.prepareResult = { code: 'DEPENDENCIES_INCOMPLETE', ok: false };
  const result = await h.dispatch(request());
  expect(result).toMatchObject({
    actionCode: 'DEPENDENCIES_INCOMPLETE',
    code: 'INTENT_REFUSED',
  });
  expectNoLaunch(h, result);
  expect(h.world.leases.size).toBe(0);
  expect(h.count('usage.release')).toBe(1);
});

// ---------------------------------------------------------------------------
// Usage reservation
// ---------------------------------------------------------------------------

test('a usage reservation that cannot be made refuses and frees admission', async () => {
  const h = harness();
  h.world.usageResult = { code: 'PRICE_UNKNOWN', ok: false };
  const result = await h.dispatch(request());
  expect(result).toMatchObject({
    code: 'USAGE_UNAVAILABLE',
    usageCode: 'PRICE_UNKNOWN',
  });
  expectNoLaunch(h, result);
  expect(h.count('actions.prepareAction')).toBe(0);
  expect(h.world.leases.size).toBe(0);
  expect(result.resources.admission).toBe('released');
});

const UNKNOWN_RESERVATIONS = [
  ['no cap', { ok: true, reservationId: 'reservation-1' }],
  ['no reservation id', { cap: 'enforced', ok: true }],
  [
    'a thrown error',
    () => {
      throw new Error('usage detail');
    },
  ],
];

for (const [label, usageResult] of UNKNOWN_RESERVATIONS) {
  test(`a reservation with ${label} is unknown and is not released blindly`, async () => {
    const h = harness();
    h.world.usageResult = usageResult;
    const result = await h.dispatch(request());
    expect(result.code).toBe('USAGE_UNAVAILABLE');
    expect(result.resources.usage).toBe('unknown');
    expectNoLaunch(h, result);
    expect(h.count('usage.release')).toBe(0);
    expect(JSON.stringify(result)).not.toContain('usage detail');
  });
}

test('a hard-cap dispatch refuses a cap that is not enforced', async () => {
  const h = harness();
  h.world.usageResult = { cap: 'estimated', ok: true, reservationId: 'r-1' };
  const refused = await h.dispatch(request({ requireEnforcedCap: true }));
  expect(refused.code).toBe('USAGE_CAP_NOT_ENFORCED');
  expectNoLaunch(h, refused);
  expect(h.count('usage.release')).toBe(1);
  expect(h.world.leases.size).toBe(0);

  const allowed = await h.dispatch(request());
  expect(allowed.status).toBe('launched');
});

// ---------------------------------------------------------------------------
// Uncertain and refused launches
// ---------------------------------------------------------------------------

const UNCERTAIN_LAUNCHES = [
  [
    'a thrown error',
    () => {
      throw new Error(`launch detail ${SECRET}`);
    },
  ],
  ['a process timeout', { ok: false, timedOut: true }],
  ['a receipt without a dispatch flag', { ok: true }],
  [
    'a dispatch without an owned worker identity',
    { dispatched: true, ok: true },
  ],
  [
    'a refusal without the pre-dispatch flag',
    { code: 'WORKER_REFUSED', ok: false },
  ],
  [
    'a dispatch that skipped the effect-boundary fence',
    { dispatched: true, ok: true, workerId: 'worker-1' },
  ],
  [
    'a dispatch that echoes another fence',
    (input) => ({
      dispatched: true,
      fence: { ...input.fence, generation: 9 },
      ok: true,
      workerId: 'worker-1',
    }),
  ],
];

for (const [label, launchResult] of UNCERTAIN_LAUNCHES) {
  test(`an uncertain launch (${label}) holds every resource and is never resent`, async () => {
    const h = harness();
    h.world.launchResult = launchResult;
    const result = await h.dispatch(request());
    expect(result).toMatchObject({
      code: 'LAUNCH_UNKNOWN',
      effect: 'unknown',
      holdRecorded: true,
      launched: false,
      ok: false,
      retryAllowed: false,
      status: 'held',
    });
    expectBounded(result);
    expect(JSON.stringify(result)).not.toContain('launch detail');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(h.world.actions.get('action-1').state).toBe('unknown');
    expect(h.names().some((name) => RELEASE_CALLS.includes(name))).toBe(false);
    expect(h.world.claim).not.toBeNull();
    expect(h.world.leases.size).toBe(1);
    expect(h.world.reservations.size).toBe(1);
    expect(result.resources).toEqual({
      admission: 'held',
      usage: 'held',
      writer: 'held',
    });

    // The same action is returned, never launched again.
    const again = await h.dispatch(request());
    expect(again).toMatchObject({
      actionStatus: 'unknown',
      code: 'ACTION_EXISTS',
      effect: 'unknown',
      retryAllowed: false,
      status: 'duplicate',
    });
    expect(h.count('worker.launch')).toBe(1);
  });
}

test('an unknown launch blocks a new attempt of the span without releasing it', async () => {
  const h = harness();
  h.world.launchResult = () => {
    throw new Error('lost');
  };
  await h.dispatch(request());
  const second = await h.dispatch(
    request({ actionId: 'action-2', attemptId: 'attempt-2' })
  );
  expect(second.code).toBe('INTENT_REFUSED');
  expect(second.actionCode).toBe('SPAN_ACTION_OPEN');
  expect(h.count('worker.launch')).toBe(1);
  // Only the second attempt's own new holdings were released.
  expect(h.world.leases.size).toBe(1);
  expect(h.world.actions.get('action-1').state).toBe('unknown');
  expect(h.world.claim).not.toBeNull();
});

test('a definite pre-dispatch refusal records failure, frees admission and keeps the writer', async () => {
  const h = harness();
  h.world.launchResult = {
    code: 'PROFILE_UNSUPPORTED',
    dispatched: false,
    error: 'detail',
    ok: false,
  };
  const result = await h.dispatch(request());
  expect(result).toMatchObject({
    code: 'LAUNCH_REFUSED',
    effect: 'none',
    outcomeRecorded: true,
    status: 'refused',
    workerCode: 'PROFILE_UNSUPPORTED',
  });
  expectNoLaunch({ count: () => 0 }, result);
  expect(h.world.actions.get('action-1').state).toBe('failed');
  expect(h.world.leases.size).toBe(0);
  expect(h.world.reservations.size).toBe(0);
  expect(h.world.claim).not.toBeNull();
  expect(h.count('writer.release')).toBe(0);

  // A new attempt with a new action ID may now proceed.
  h.world.launchResult = undefined;
  const retry = await h.dispatch(
    request({ actionId: 'action-2', attemptId: 'attempt-2' })
  );
  expect(retry.status).toBe('launched');
});

test('a refusal that cannot be recorded keeps the resources held', async () => {
  const h = harness();
  h.world.launchResult = { dispatched: false, ok: false };
  h.world.on.intent = () => {
    h.world.recordFails = true;
  };
  const result = await h.dispatch(request());
  expect(result.code).toBe('LAUNCH_REFUSED');
  expect(result.outcomeRecorded).toBe(false);
  expect(h.world.leases.size).toBe(1);
  expect(h.world.actions.get('action-1').state).toBe('intent');
});

// ---------------------------------------------------------------------------
// Duplicate actions
// ---------------------------------------------------------------------------

test('a repeated action returns its status after authorization and one read', async () => {
  const h = harness();
  await h.dispatch(request());
  const before = h.calls.length;
  const again = await h.dispatch(request());
  expect(again).toMatchObject({
    actionStatus: 'intent',
    code: 'ACTION_EXISTS',
    launched: false,
    status: 'duplicate',
  });
  expect(h.names().slice(before)).toEqual([
    'capabilities.verify',
    'authorization.verify',
    'runState.read',
  ]);
  expect(h.count('worker.launch')).toBe(1);
});

test('a finished action is reported as recorded, never relaunched', async () => {
  const h = harness();
  await h.dispatch(request());
  h.world.actions.get('action-1').state = 'completed';
  const again = await h.dispatch(request());
  expect(again).toMatchObject({
    actionStatus: 'completed',
    effect: 'recorded',
    status: 'duplicate',
  });
  expect(h.count('worker.launch')).toBe(1);
});

test('the same action with changed input is a conflict', async () => {
  const h = harness();
  await h.dispatch(request());
  const changed = await h.dispatch(request({ inputDigest: OTHER_DIGEST }));
  expect(changed.code).toBe('ACTION_CONFLICT');
  expectBounded(changed);
  const otherAttempt = await h.dispatch(request({ attemptId: 'attempt-2' }));
  expect(otherAttempt.code).toBe('ACTION_CONFLICT');
  expect(h.count('worker.launch')).toBe(1);
});

test('concurrent duplicates in one process launch exactly once', async () => {
  const h = harness();
  const other = createSpansDispatch({ adapters: h.adapters });
  const [first, second, third] = await Promise.all([
    h.dispatch(request()),
    h.dispatch(request()),
    other.dispatch(request()),
  ]);
  expect(first.status).toBe('launched');
  expect(second.code).toBe('DISPATCH_IN_FLIGHT');
  expect(third.code).toBe('DISPATCH_IN_FLIGHT');
  expect(h.count('worker.launch')).toBe(1);
  expect(h.count('actions.prepareAction')).toBe(1);
  // The guard is released afterwards.
  expect((await h.dispatch(request())).code).toBe('ACTION_EXISTS');
});

test("losing the intent race neither launches nor releases the winner's holdings", async () => {
  const h = harness();
  h.world.prepareResult = (input) => {
    h.world.actions.set(input.actionId, {
      actionId: input.actionId,
      attemptId: input.attemptId,
      inputDigest: input.inputDigest,
      planVersion: input.planVersion,
      spanId: input.spanId,
      state: 'intent',
      targetDigest: input.targetDigest,
    });
    return { created: false, ok: true, status: 'intent' };
  };
  const result = await h.dispatch(request());
  expect(result).toMatchObject({ code: 'ACTION_EXISTS', status: 'duplicate' });
  expect(h.count('worker.launch')).toBe(0);
  expect(h.count('admission.release')).toBe(0);
  expect(h.count('usage.release')).toBe(0);
  expect(h.world.leases.size).toBe(1);
});

// ---------------------------------------------------------------------------
// Completion and terminal release
// ---------------------------------------------------------------------------

async function launched() {
  const h = harness();
  const result = await h.dispatch(request());
  expect(result.status).toBe('launched');
  return h;
}

test('a process exit is not completion and releases nothing', async () => {
  const h = await launched();
  h.world.completionResult = { ok: true, verified: false };
  const before = h.calls.length;
  const result = await h.completeOwned({
    ...completionInput(),
    exitCode: 0,
    outcome: 'completed',
    processExited: true,
    verified: true,
  });
  expect(result).toMatchObject({
    code: 'COMPLETION_NOT_VERIFIED',
    retryAllowed: false,
    status: 'held',
  });
  expect(h.names().slice(before)).toEqual([
    'runState.read',
    'worker.verifyCompletion',
  ]);
  expect(h.world.leases.size).toBe(1);
  expect(h.world.claim).not.toBeNull();
  expect(h.world.actions.get('action-1').state).toBe('intent');
});

const BAD_RECEIPTS = [
  ['not terminal', { terminal: false }],
  ['an unknown outcome', { outcome: 'unknown' }],
  ['another worker', { workerId: 'worker-2' }],
  ['another action', { actionId: 'action-2' }],
  ['another attempt', { attemptId: 'attempt-2' }],
  ['no evidence id', { evidenceId: undefined }],
  ['a secret evidence id', { evidenceId: SECRET }],
  ['duplicate artifacts', { artifactIds: ['a', 'a'] }],
  ['a bad artifact id', { artifactIds: [''] }],
  ['a missing ok flag', { ok: undefined }],
  ['another run', { runId: 'run-2' }],
  ['another span', { spanId: 'span-b' }],
  ['another generation', { generation: 2 }],
  ['no generation', { generation: undefined }],
  ['another plan version', { planVersion: 2 }],
  ['another input digest', { inputDigest: OTHER_DIGEST }],
  ['another target digest', { targetDigest: OTHER_DIGEST }],
  ['no target digest', { targetDigest: undefined }],
  ['no writer owner', { writerSession: undefined }],
  ['another writer owner', { writerSession: 'spans-writer-other' }],
  ['no checkout identity', { checkoutIdentity: undefined }],
  [
    'an unknown checkout identity',
    { checkoutIdentity: { ...IDENTITY, known: false } },
  ],
  ['a partial checkout identity', { checkoutIdentity: { checkoutPath: WT } }],
];

for (const [label, override] of BAD_RECEIPTS) {
  test(`a completion receipt with ${label} is not verified`, async () => {
    const h = await launched();
    h.world.completionResult = (input) => receiptFor(h.world, input, override);
    accept(h);
    const result = await h.completeOwned(completionInput());
    expect(result.code).toBe('COMPLETION_NOT_VERIFIED');
    expect(h.count('actions.recordOutcome')).toBe(0);
    expect(h.names().some((name) => RELEASE_CALLS.includes(name))).toBe(false);
    expect(h.world.leases.size).toBe(1);
    expect(h.world.claim).not.toBeNull();
  });
}

test('a verified completion settles usage and admission but keeps the writer until acceptance', async () => {
  const h = await launched();
  const result = await h.completeOwned(completionInput());
  expect(result).toMatchObject({
    accepted: false,
    code: 'ACCEPTANCE_PENDING',
    effect: 'recorded',
    launched: true,
    ok: true,
    outcome: 'completed',
    outcomeRecorded: true,
    resources: { admission: 'released', usage: 'released', writer: 'held' },
    status: 'recorded',
  });
  expectBounded(result);
  expect(h.world.actions.get('action-1')).toMatchObject({
    outcomeArtifactIds: ['artifact-1'],
    state: 'completed',
  });
  expect(h.find('usage.settle').payload).toMatchObject({
    evidenceId: 'evidence-1',
    outcome: 'completed',
  });
  expect(h.find('actions.recordOutcome').payload.evidence).toEqual({
    evidenceId: 'evidence-1',
    source: 'owned-worker-completion',
    workerId: 'worker-1',
  });
  expect(h.world.leases.size).toBe(0);
  expect(h.world.claim).not.toBeNull();
  expect(h.count('writer.release')).toBe(0);
});

test('the writer is released once the committed run view shows the acceptance', async () => {
  const h = await launched();
  expect((await h.completeOwned(completionInput())).status).toBe('recorded');
  expect(h.world.claim).not.toBeNull();

  accept(h);
  const done = await h.completeOwned(completionInput());
  expect(done).toMatchObject({
    accepted: true,
    acceptedEvidenceId: 'acceptance-evidence-1',
    code: 'RELEASED',
    ok: true,
    resources: { admission: 'absent', usage: 'released', writer: 'released' },
    status: 'released',
  });
  expect(h.world.claim).toBeNull();
  expect(h.find('writer.release').payload).toEqual({
    binding: {
      acceptedEvidenceId: 'acceptance-evidence-1',
      actionId: 'action-1',
      attemptId: 'attempt-1',
      checkoutIdentity: IDENTITY,
      completionEvidenceId: 'evidence-1',
      generation: 1,
      runId: 'run-1',
      spanId: 'span-a',
    },
    checkoutPath: WT,
    session: h.world.session,
  });
  const calls = h.names();
  const writerCheck = calls.lastIndexOf('writer.check');
  expect(calls.slice(writerCheck, writerCheck + 3)).toEqual([
    'writer.check',
    'runState.read',
    'writer.release',
  ]);

  // Repeating after a restart is idempotent: an absent claim is released.
  const again = await h.completeOwned(completionInput());
  expect(again).toMatchObject({ code: 'RELEASED', ok: true });
  expect(again.resources).toEqual({
    admission: 'absent',
    usage: 'released',
    writer: 'absent',
  });
});

test('an acceptance already committed releases in the same call', async () => {
  const h = await launched();
  accept(h);
  const result = await h.completeOwned(completionInput());
  expect(result).toMatchObject({ accepted: true, status: 'released' });
  expect(h.world.claim).toBeNull();
});

const NOT_ACCEPTANCES = [
  ['another action', { acceptedActionId: 'action-other' }],
  ['no evidence reference', { acceptedEvidenceId: undefined }],
  ['a secret evidence reference', { acceptedEvidenceId: SECRET }],
  ['a span that is not completed', { state: 'running' }],
];

for (const [label, span] of NOT_ACCEPTANCES) {
  test(`an acceptance with ${label} does not release the writer`, async () => {
    const h = await launched();
    accept(h, span);
    const result = await h.completeOwned(completionInput());
    expect(result).toMatchObject({
      accepted: false,
      code: 'ACCEPTANCE_PENDING',
      resources: { writer: 'held' },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(h.count('writer.release')).toBe(0);
    expect(h.world.claim).not.toBeNull();
  });
}

test('a verified failed outcome is recorded, settles and keeps the writer', async () => {
  const h = await launched();
  h.world.completionResult = (input) =>
    receiptFor(h.world, input, {
      artifactIds: undefined,
      evidenceId: 'evidence-2',
      outcome: 'failed',
    });
  // No span is accepted for a failed action, so even an acceptance record for
  // this action id does not release the writer.
  accept(h);
  const result = await h.completeOwned(completionInput());
  expect(result).toMatchObject({
    accepted: false,
    code: 'ACCEPTANCE_PENDING',
    outcome: 'failed',
    resources: { admission: 'released', usage: 'released', writer: 'held' },
    status: 'recorded',
  });
  expect(h.world.actions.get('action-1').state).toBe('failed');
  expect(h.world.leases.size).toBe(0);
  expect(h.world.claim).not.toBeNull();
});

test('an unknown launch is resolved only by verified completion', async () => {
  const h = harness();
  h.world.launchResult = () => {
    throw new Error('lost');
  };
  await h.dispatch(request());
  expect(h.world.actions.get('action-1').state).toBe('unknown');
  h.world.completionResult = { ok: true, verified: false };
  expect((await h.completeOwned(completionInput())).code).toBe(
    'COMPLETION_NOT_VERIFIED'
  );
  expect(h.world.leases.size).toBe(1);
  h.world.completionResult = undefined;
  expect((await h.completeOwned(completionInput())).status).toBe('recorded');
  expect(h.world.actions.get('action-1').state).toBe('completed');
  expect(h.world.claim).not.toBeNull();
  accept(h);
  expect((await h.completeOwned(completionInput())).status).toBe('released');
});

// ---------------------------------------------------------------------------
// The release target comes from the durable receipt, never from the caller
// ---------------------------------------------------------------------------

test('a caller checkout that differs from the attested one releases nothing', async () => {
  const h = await launched();
  accept(h);
  const checksBefore = h.count('writer.check');
  const result = await h.completeOwned(
    completionInput({ wtDir: '/synthetic/spans/elsewhere' })
  );
  expect(result.code).toBe('COMPLETION_NOT_VERIFIED');
  expect(h.count('actions.recordOutcome')).toBe(0);
  expect(h.count('usage.settle')).toBe(0);
  expect(h.count('writer.check')).toBe(checksBefore);
  expect(h.count('writer.release')).toBe(0);
  expect(h.world.claim).not.toBeNull();
});

test('a completion without a caller checkout releases the attested checkout', async () => {
  const h = await launched();
  accept(h);
  const { wtDir: _omitted, ...input } = completionInput();
  const result = await h.completeOwned(input);
  expect(result.status).toBe('released');
  expect(h.find('writer.release').payload.checkoutPath).toBe(WT);
  expect(h.world.lastReleaseBinding).toEqual({
    acceptedEvidenceId: 'acceptance-evidence-1',
    actionId: 'action-1',
    attemptId: 'attempt-1',
    checkoutIdentity: IDENTITY,
    completionEvidenceId: 'evidence-1',
    generation: 1,
    runId: 'run-1',
    spanId: 'span-a',
  });
  expect(Object.isFrozen(h.world.lastReleaseBinding)).toBe(true);
  expect(Object.isFrozen(h.world.lastReleaseBinding.checkoutIdentity)).toBe(
    true
  );
  expect(
    Object.isFrozen(h.world.lastReleaseBinding.checkoutIdentity.admin)
  ).toBe(true);
});

test('the writer is checked on the attested checkout and only an exact claim is released', async () => {
  const h = await launched();
  accept(h);
  h.world.claim = { session: 'intruder' };
  const result = await h.completeOwned(completionInput());
  expect(result).toMatchObject({
    code: 'RELEASE_INCOMPLETE',
    ok: false,
    outcomeRecorded: true,
    resources: { writer: 'failed' },
    status: 'held',
  });
  expect(h.count('writer.release')).toBe(0);
  expect(h.world.claim.session).toBe('intruder');

  // A claim answered for a different checkout is never released either.
  const other = await launched();
  accept(other);
  other.adapters.writer.check = async ({ session }) => ({
    claim: { session },
    ok: true,
    wtDir: '/synthetic/spans/elsewhere',
  });
  expect((await other.completeOwned(completionInput())).resources.writer).toBe(
    'failed'
  );
  expect(other.count('writer.release')).toBe(0);
  expect(other.world.claim).not.toBeNull();
});

test('a generation that moves during settlement stops the writer release', async () => {
  const h = await launched();
  accept(h);
  h.world.on.settle = () => {
    h.world.generation = 2;
  };
  const result = await h.completeOwned(completionInput());
  expect(result).toMatchObject({
    code: 'STALE_GENERATION',
    effect: 'recorded',
    launched: true,
    ok: false,
    outcomeRecorded: true,
    resources: { admission: 'released', usage: 'released', writer: 'held' },
    status: 'held',
  });
  expect(h.count('writer.release')).toBe(0);
  expect(h.world.claim).not.toBeNull();
});

test('a takeover during writer check stops release for the prior generation', async () => {
  const h = await launched();
  accept(h);
  h.world.on.writerCheck = () => {
    h.world.generation = 2;
    h.world.claim = { session: h.world.claim.session, takeover: true };
  };
  const result = await h.completeOwned(completionInput());
  expect(result).toMatchObject({
    accepted: false,
    code: 'STALE_GENERATION',
    effect: 'recorded',
    launched: true,
    ok: false,
    resources: { writer: 'held' },
    status: 'held',
  });
  expect(h.count('writer.release')).toBe(0);
  expect(h.world.claim).toMatchObject({ takeover: true });
});

const ACCEPTANCE_CHANGES = [
  [
    'accepted action',
    (world) => {
      world.span.acceptedActionId = 'action-2';
    },
  ],
  [
    'accepted attempt',
    (world) => {
      world.actions.get('action-1').attemptId = 'attempt-2';
    },
  ],
  [
    'accepted evidence',
    (world) => {
      world.span.acceptedEvidenceId = 'acceptance-evidence-2';
    },
  ],
];

for (const [label, change] of ACCEPTANCE_CHANGES) {
  test(`a changed ${label} during writer check keeps the claim`, async () => {
    const h = await launched();
    accept(h);
    h.world.on.writerCheck = () => change(h.world);
    const result = await h.completeOwned(completionInput());
    expect(result).toMatchObject({
      accepted: false,
      code: 'ACCEPTANCE_PENDING',
      effect: 'recorded',
      launched: true,
      ok: true,
      resources: { writer: 'held' },
      status: 'recorded',
    });
    expect(h.count('writer.release')).toBe(0);
    expect(h.world.claim).not.toBeNull();
  });
}

test('an unreadable run view after settlement keeps the writer', async () => {
  const h = await launched();
  accept(h);
  const { runState } = h.adapters;
  const { read } = runState;
  let reads = 0;
  runState.read = (input) => {
    reads += 1;
    if (reads > 1) {
      throw new Error('view detail');
    }
    return read(input);
  };
  const result = await h.completeOwned(completionInput());
  expect(result).toMatchObject({
    code: 'RUN_STATE_UNAVAILABLE',
    outcomeRecorded: true,
    status: 'held',
  });
  expect(JSON.stringify(result)).not.toContain('view detail');
  expect(h.count('writer.release')).toBe(0);
});

test('an unrecorded completion keeps every resource', async () => {
  const h = await launched();
  h.world.recordFails = true;
  const result = await h.completeOwned(completionInput());
  expect(result.code).toBe('COMPLETION_NOT_RECORDED');
  expect(h.world.leases.size).toBe(1);
  expect(h.world.claim).not.toBeNull();
  expect(h.names().some((name) => RELEASE_CALLS.includes(name))).toBe(false);
});

test('a resource that cannot be released is reported, not hidden', async () => {
  const h = await launched();
  accept(h);
  h.world.settleFails = true;
  const result = await h.completeOwned(completionInput());
  expect(result).toMatchObject({
    code: 'RELEASE_INCOMPLETE',
    ok: false,
    outcomeRecorded: true,
    resources: { admission: 'released', usage: 'failed', writer: 'released' },
    status: 'held',
  });
  expect(h.world.actions.get('action-1').state).toBe('completed');

  // A writer release that fails is reported the same way.
  const other = await launched();
  accept(other);
  other.adapters.writer.release = async () => ({ ok: false });
  expect(await other.completeOwned(completionInput())).toMatchObject({
    code: 'RELEASE_INCOMPLETE',
    resources: { usage: 'released', writer: 'failed' },
  });
});

test('completion refuses a stale generation, an unknown action or another attempt', async () => {
  const h = await launched();
  h.world.generation = 2;
  const stale = await h.completeOwned(completionInput());
  expect(stale.code).toBe('STALE_GENERATION');
  expect(h.count('worker.verifyCompletion')).toBe(0);
  h.world.generation = 1;

  expect(
    (await h.completeOwned(completionInput({ actionId: 'action-x' }))).code
  ).toBe('ACTION_NOT_FOUND');
  expect(
    (await h.completeOwned(completionInput({ attemptId: 'attempt-x' }))).code
  ).toBe('ACTION_CONFLICT');
  expect(h.count('worker.verifyCompletion')).toBe(0);
  expect(h.world.leases.size).toBe(1);
});

const INVALID_COMPLETIONS = [
  ['no request', undefined],
  ['an empty worker id', completionInput({ workerId: '' })],
  ['a relative checkout path', completionInput({ wtDir: 'relative' })],
  ['a fractional generation', completionInput({ generation: 1.5 })],
];

for (const [label, input] of INVALID_COMPLETIONS) {
  test(`completion with ${label} is rejected before any adapter runs`, async () => {
    const h = harness();
    const result = await h.completeOwned(input);
    expect(result.code).toBe('REQUEST_INVALID');
    expectBounded(result);
    expect(h.calls).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// Hostile request data: nothing foreign is read before it is bounded
// ---------------------------------------------------------------------------

const probe = { calls: 0 };
const touch = () => {
  probe.calls += 1;
  return 'touched';
};
const withAccessor = (target, key) =>
  Object.defineProperty(target, key, { enumerable: true, get: touch });
const trapped = (target) =>
  new Proxy(target, {
    get: touch,
    getOwnPropertyDescriptor: touch,
    getPrototypeOf: touch,
    has: touch,
    ownKeys: touch,
  });
const many = (count, make) => Array.from({ length: count }, make);

const HOSTILE = [
  ['a top-level accessor', () => withAccessor(request(), 'runId')],
  [
    'a setter-only accessor',
    () =>
      Object.defineProperty(request(), 'actionId', {
        enumerable: true,
        set: touch,
      }),
  ],
  [
    'a nested accessor',
    () => {
      const hostile = request();
      withAccessor(hostile.checkout, 'wtDir');
      return hostile;
    },
  ],
  [
    'a deep identity accessor',
    () => {
      const hostile = request();
      withAccessor(hostile.checkout.expected.identity.admin, 'ino');
      return hostile;
    },
  ],
  [
    'an accessor on an array element',
    () => {
      const hostile = request();
      withAccessor(hostile.requiredCapabilities, '0');
      return hostile;
    },
  ],
  [
    'an inherited getter',
    () => {
      const hostile = Object.fromEntries(
        Object.entries(request()).filter(([key]) => key !== 'runId')
      );
      return Object.setPrototypeOf(hostile, {
        get runId() {
          return touch();
        },
      });
    },
  ],
  [
    'a class instance',
    () =>
      new (class {
        get runId() {
          return touch();
        }
      })(),
  ],
  ['a Proxy request', () => trapped(request())],
  [
    'a Proxy nested record',
    () => request({ checkout: trapped(request().checkout) }),
  ],
  [
    'a Proxy array',
    () => request({ requiredCapabilities: trapped(['edit', 'test']) }),
  ],
  [
    'a cycle',
    () => {
      const hostile = request();
      hostile.checkout.again = hostile;
      return hostile;
    },
  ],
  [
    'excess depth',
    () => {
      const root = {};
      let node = root;
      for (let level = 0; level < 20; level += 1) {
        node.next = {};
        node = node.next;
      }
      return request({ deep: root });
    },
  ],
  ['an oversized string', () => request({ spanId: 'x'.repeat(5000) })],
  [
    'many strings that are each within the limit',
    () => request({ extra: many(60, () => 'x'.repeat(4000)) }),
  ],
  [
    'too many nodes through shared references',
    () => request({ extra: many(60, () => many(60, () => 1)) }),
  ],
  [
    'too many keys',
    () =>
      request({
        extra: Object.fromEntries(many(100, (_, index) => [`k${index}`, 1])),
      }),
  ],
  ['an oversized array', () => request({ extra: many(1000, () => 0) })],
  [
    'an array with a hole',
    () => {
      const capabilities = new Array(3);
      capabilities[0] = 'a';
      capabilities[2] = 'c';
      return request({ requiredCapabilities: capabilities });
    },
  ],
  [
    'an array with an extra property',
    () => {
      const capabilities = ['edit', 'test'];
      capabilities.extra = 'x';
      return request({ requiredCapabilities: capabilities });
    },
  ],
  ['a symbol key', () => request({ [Symbol('key')]: 1 })],
  [
    'a hidden property',
    () =>
      Object.defineProperty(request(), 'hidden', {
        enumerable: false,
        value: 1,
      }),
  ],
  [
    'an own __proto__ key',
    () =>
      Object.defineProperty(request(), '__proto__', {
        enumerable: true,
        value: {},
      }),
  ],
  ['a Date', () => request({ at: new Date(0) })],
  ['a Map', () => request({ extra: new Map() })],
  ['a function', () => request({ extra: () => 1 })],
  ['a non-finite number', () => request({ extra: Number.POSITIVE_INFINITY })],
  ['a bigint', () => request({ extra: 1n })],
  ['an undefined array item', () => request({ extra: [undefined] })],
];

for (const [label, build] of HOSTILE) {
  test(`${label} is refused without touching the data or any adapter`, async () => {
    const h = harness();
    probe.calls = 0;
    const result = await h.dispatch(build());
    expect(result).toMatchObject({
      code: 'REQUEST_INVALID',
      field: 'request',
      ok: false,
    });
    expectBounded(result);
    expect(probe.calls).toBe(0);
    expect(h.calls).toEqual([]);
  });
}

test('a completion request is bounded the same way', async () => {
  const h = harness();
  probe.calls = 0;
  const inputs = [
    withAccessor(completionInput(), 'workerId'),
    trapped(completionInput()),
    completionInput({ spanId: 'x'.repeat(5000) }),
    completionInput({ extra: many(60, () => 'x'.repeat(4000)) }),
  ];
  const results = await Promise.all(
    inputs.map((input) => h.completeOwned(input))
  );
  for (const result of results) {
    expect(result).toMatchObject({
      code: 'REQUEST_INVALID',
      field: 'request',
    });
  }
  expect(probe.calls).toBe(0);
  expect(h.calls).toEqual([]);
});

test('the target digest planner input is bounded without invoking accessors', () => {
  probe.calls = 0;
  const hostile = structuredClone(EXPECTED);
  withAccessor(hostile, 'head');
  expect(targetDigestFor(hostile)).toBeNull();
  expect(targetDigestFor(trapped(structuredClone(EXPECTED)))).toBeNull();
  expect(probe.calls).toBe(0);
});

test('a null-prototype request is plain data and still launches', async () => {
  const h = harness();
  const plain = Object.assign(Object.create(null), request());
  expect((await h.dispatch(plain)).status).toBe('launched');
});

// ---------------------------------------------------------------------------
// Adapter faults never escape
// ---------------------------------------------------------------------------

test('an adapter result with a throwing accessor is a fixed refusal before any effect', async () => {
  const h = harness();
  h.adapters.archive.capacity = async () => ({
    get newLaunchAllowed() {
      throw new Error(`archive ${SECRET}`);
    },
    ok: true,
  });
  const result = await h.dispatch(request());
  expect(result).toMatchObject({
    code: 'ADAPTER_FAILED',
    effect: 'none',
    launched: false,
    ok: false,
    status: 'refused',
  });
  expectBounded(result);
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(h.count('writer.claim')).toBe(0);
});

test('an adapter fault after an effect holds everything and never launches', async () => {
  const h = harness();
  h.adapters.usage.reserve = async () => ({
    cap: 'enforced',
    ok: true,
    get reservationId() {
      throw new Error(`usage ${SECRET}`);
    },
  });
  const result = await h.dispatch(request());
  expect(result).toMatchObject({
    code: 'ADAPTER_FAILED',
    effect: 'unknown',
    ok: false,
    retryAllowed: false,
    status: 'held',
  });
  expect(result.resources).toMatchObject({ admission: 'held', writer: 'held' });
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(h.count('worker.launch')).toBe(0);
  expect(h.names().some((name) => RELEASE_CALLS.includes(name))).toBe(false);
  // The in-flight guard was released.
  expect((await h.dispatch(request())).code).toBe('ADAPTER_FAILED');
});

test('an adapter map with a throwing accessor is a missing adapter, not a throw', async () => {
  const h = harness();
  const adapters = { ...h.adapters };
  Object.defineProperty(adapters, 'worker', {
    enumerable: true,
    get() {
      throw new Error('adapter map detail');
    },
  });
  const dispatcher = createSpansDispatch({ adapters });
  const result = await dispatcher.dispatch(request());
  expect(result.code).toBe('ADAPTER_MISSING');
  expect((await dispatcher.completeOwned(completionInput())).code).toBe(
    'ADAPTER_MISSING'
  );
  expect(JSON.stringify(result)).not.toContain('detail');
});

test('a completion receipt with a throwing accessor is a fixed hold that releases nothing', async () => {
  const h = await launched();
  accept(h);
  h.world.completionResult = () => ({
    ok: true,
    get verified() {
      throw new Error(`receipt ${SECRET}`);
    },
  });
  const result = await h.completeOwned(completionInput());
  expect(result).toMatchObject({
    code: 'ADAPTER_FAILED',
    effect: 'unknown',
    ok: false,
    status: 'held',
  });
  expectBounded(result);
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(h.count('actions.recordOutcome')).toBe(0);
  expect(h.names().some((name) => RELEASE_CALLS.includes(name))).toBe(false);
  expect(h.world.claim).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Bounded results
// ---------------------------------------------------------------------------

test('every exported code has fixed text and results never reflect adapter strings', async () => {
  const h = harness();
  h.world.launchResult = () => {
    throw new Error(`launch ${SECRET}`);
  };
  const results = [
    await h.dispatch(request()),
    await h.dispatch(request()),
    await h.dispatch(request({ inputDigest: OTHER_DIGEST })),
  ];
  for (const result of results) {
    expectBounded(result);
    expect(typeof result.error).toBe('string');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  }
  expect(Object.keys(SPANS_DISPATCH_CODES)).toContain('LAUNCH_UNKNOWN');
  expect(Object.isFrozen(SPANS_DISPATCH_CODES)).toBe(true);
});

test('the target digest is stable and requires an exact snapshot', () => {
  expect(targetDigestFor(EXPECTED)).toMatch(DIGEST_REGEX);
  expect(targetDigestFor({ ...EXPECTED, extra: 1 })).toBe(
    targetDigestFor(EXPECTED)
  );
  expect(targetDigestFor({ ...EXPECTED, head: 'c'.repeat(40) })).not.toBe(
    targetDigestFor(EXPECTED)
  );
  expect(
    targetDigestFor({
      ...EXPECTED,
      dependency: { ...DEPENDENCY, lockfileHash: '2'.repeat(64) },
    })
  ).not.toBe(targetDigestFor(EXPECTED));
  expect(targetDigestFor({ head: HEAD })).toBeNull();
  expect(targetDigestFor(undefined)).toBeNull();
});
