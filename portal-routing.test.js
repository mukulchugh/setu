import { expect, test } from 'bun:test';
import { createPortalRouting } from './portal-routing.js';

function fixture({ reloadCaddy, run, writeCaddy } = {}) {
  const writes = [];
  const routing = createPortalRouting({
    hostsEnd: '# end',
    hostsStart: '# start',
    localDomain: (repo, name) => `${name}.${repo}.local`,
    readFile: async () => '127.0.0.1 localhost\n# start\nstale\n# end\n',
    reloadCaddy: reloadCaddy ?? (async () => true),
    run: run ?? (() => ({ exited: Promise.resolve(0) })),
    stagingPath: '/tmp/setu-hosts',
    state: {
      replaceText: async (path, value) => writes.push([path, value]),
      snapshot: async () => ({ ports: [{ name: 'topic', repo: 'r' }] }),
      withRouting: (task) => task(),
    },
    writeCaddy:
      writeCaddy ??
      (async () => {
        // The fixture does not write a real Caddy configuration.
      }),
  });
  return { routing, writes };
}

test('portal host routing writes the registry domains and awaits an async sudo copy', async () => {
  const { routing, writes } = fixture();
  await expect(routing.syncHosts()).resolves.toBe(true);
  expect(writes).toEqual([
    [
      '/tmp/setu-hosts',
      '127.0.0.1 localhost\n# start\n127.0.0.1\ttopic.r.local\n# end\n',
    ],
  ]);
});

test('adoption routing reports hosts and Caddy failures instead of accepting partial routing', async () => {
  const hostsFailed = fixture({
    run: () => ({ exited: Promise.resolve(1) }),
  });
  await expect(
    hostsFailed.routing.writeAdoptionRouting('r', 'topic', 3201)
  ).resolves.toMatchObject({ code: 'ADOPTION_HOSTS_PENDING', ok: false });

  const caddyFailed = fixture({ reloadCaddy: async () => false });
  await expect(
    caddyFailed.routing.writeAdoptionRouting('r', 'topic', 3201)
  ).resolves.toMatchObject({ code: 'ADOPTION_CADDY_PENDING', ok: false });
});

test('adoption routing retries each pending hosts or Caddy stage', async () => {
  let hostsAttempts = 0;
  let caddyAttempts = 0;
  const { routing } = fixture({
    // biome-ignore lint/suspicious/useAwait: The reload fixture preserves the asynchronous routing contract.
    reloadCaddy: async () => {
      caddyAttempts += 1;
      return caddyAttempts > 1;
    },
    run: () => {
      hostsAttempts += 1;
      return { exited: Promise.resolve(hostsAttempts === 1 ? 1 : 0) };
    },
  });
  await expect(
    routing.writeAdoptionRouting('r', 'topic', 3201)
  ).resolves.toMatchObject({
    code: 'ADOPTION_HOSTS_PENDING',
    ok: false,
  });
  await expect(
    routing.writeAdoptionRouting('r', 'topic', 3201)
  ).resolves.toMatchObject({
    code: 'ADOPTION_CADDY_PENDING',
    ok: false,
  });
  await expect(
    routing.writeAdoptionRouting('r', 'topic', 3201)
  ).resolves.toEqual({
    ok: true,
  });
});

test('a slow host copy leaves another portal request task runnable', async () => {
  let release;
  const { routing } = fixture({
    run: () => ({
      exited: new Promise((resolve) => {
        release = resolve;
      }),
    }),
  });
  const pending = routing.syncHosts();
  await Promise.resolve();
  let secondRequestCompleted = false;
  await Promise.resolve().then(() => {
    secondRequestCompleted = true;
  });
  expect(secondRequestCompleted).toBe(true);
  release(0);
  await expect(pending).resolves.toBe(true);
});
