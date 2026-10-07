import { expect, test } from 'bun:test';
import {
  createDeploymentIntent,
  type DeploymentContext,
  type DeploymentIntent,
  type DeploymentPreflight,
  type DeploymentResult,
} from './portal/deploy-intent';

const tick = async () => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
};
const intent = (
  provider: DeploymentIntent['provider'] = 'vercel',
  target = 'production'
): DeploymentIntent => ({
  name: 'directory-name',
  provider,
  repo: 'repo',
  target,
});
function context(input: DeploymentIntent): DeploymentContext {
  return {
    ...input,
    branch: 'actual-branch',
    deploymentState: { operation: null },
    destination: {
      environment: input.target === 'preview' ? 'preview' : 'production',
      id: 'exact-id',
      label: 'Exact destination',
    },
    identity: { inode: 42 },
  };
}
function fixture() {
  const reads: {
    intent: DeploymentIntent;
    signal: AbortSignal;
    resolve: (value: DeploymentPreflight) => void;
  }[] = [];
  const writes: {
    context: DeploymentContext;
    resolve: (value: DeploymentResult) => void;
  }[] = [];
  const outcomes: DeploymentResult[] = [];
  const controller = createDeploymentIntent({
    dispatch: (value) =>
      new Promise((resolve) => writes.push({ context: value, resolve })),
    preflight: (input, signal) =>
      new Promise((resolve) => reads.push({ intent: input, resolve, signal })),
    publish() {
      /* No side effect is needed in this fixture. */
    },
    result: (_input, result) => outcomes.push(result),
  });
  return {
    controller,
    outcomes,
    reads,
    resolve(index: number, requiresConfirmation = true) {
      const c = context(reads[index].intent);
      reads[index].resolve({
        expectedContext: c,
        ok: true,
        requiresConfirmation,
      });
      return c;
    },
    writes,
  };
}
test('all three production providers require an explicit confirmation and submit once', async () => {
  for (const provider of ['vercel', 'netlify', 'convex'] as const) {
    const f = fixture();
    f.controller.begin(intent(provider));
    const expected = f.resolve(0);
    await tick();
    expect(f.controller.getState().phase).toBe('ready');
    expect(f.writes).toHaveLength(0);
    f.controller.confirm();
    f.controller.confirm();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].context).toEqual(expected);
    expect(f.writes[0].context.branch).toBe('actual-branch');
    f.writes[0].resolve({ ok: true });
    await tick();
    expect(f.controller.getState().phase).toBe('idle');
  }
});
test('cancel and stale preflight responses dispatch nothing', async () => {
  const f = fixture();
  f.controller.begin(intent());
  f.controller.close();
  expect(f.reads[0].signal.aborted).toBe(true);
  f.resolve(0);
  await tick();
  expect(f.writes).toHaveLength(0);
  expect(f.controller.getState().phase).toBe('idle');
  f.controller.begin(intent('vercel'));
  f.controller.begin(intent('netlify'));
  f.resolve(1);
  await tick();
  expect(f.controller.getState().intent?.provider).toBe('netlify');
  f.resolve(2);
  await tick();
  f.controller.close();
  f.controller.confirm();
  expect(f.writes).toHaveLength(0);
});
test('verified preview stays one selection and repeated activation does not duplicate preflight', async () => {
  const f = fixture();
  f.controller.begin(intent('vercel', 'preview'));
  f.controller.begin(intent('vercel', 'preview'));
  expect(f.reads).toHaveLength(1);
  f.resolve(0, false);
  await tick();
  expect(f.writes).toHaveLength(1);
  f.controller.confirm();
  expect(f.writes).toHaveLength(1);
});
test('custom production and changed context require a fresh explicit confirmation', async () => {
  const f = fixture();
  f.controller.begin(intent('vercel', 'live-alias'));
  f.resolve(0);
  await tick();
  expect(f.writes).toHaveLength(0);
  f.controller.confirm();
  f.writes[0].resolve({ code: 'DEPLOY_CONTEXT_CHANGED', ok: false });
  await tick();
  expect(f.reads).toHaveLength(2);
  f.resolve(1, false);
  await tick();
  expect(f.writes).toHaveLength(1);
  expect(f.controller.getState().message).toContain('changed');
  f.controller.confirm();
  expect(f.writes).toHaveLength(2);
});
test('unknown authority and malformed or older-server responses never fall back to deploy', async () => {
  const f = fixture();
  f.controller.begin(intent());
  f.reads[0].resolve({
    code: 'DEPLOY_TARGET_UNVERIFIED',
    error: 'Target unavailable',
    ok: false,
  });
  await tick();
  f.controller.confirm();
  expect(f.writes).toHaveLength(0);
  expect(f.controller.getState().phase).toBe('error');
  f.controller.refresh();
  f.reads[1].resolve({ ok: true });
  await tick();
  f.controller.confirm();
  expect(f.writes).toHaveLength(0);
  expect(f.controller.getState().message).toContain('verified');
});
test('uncertain outcomes never replay, including after closing and selecting preview again', async () => {
  const f = fixture();
  f.controller.begin(intent('convex', 'preview'));
  f.resolve(0, false);
  await tick();
  f.controller.close();
  f.writes[0].resolve({ networkUncertain: true, ok: false });
  await tick();
  expect(f.controller.getState().phase).toBe('idle');
  expect(f.writes).toHaveLength(1);
  f.controller.begin(intent('convex', 'preview'));
  f.resolve(1, false);
  await tick();
  expect(f.writes).toHaveLength(1);
  expect(f.controller.getState().phase).toBe('ready');
  f.controller.confirm();
  expect(f.writes).toHaveLength(2);
});
