import { expect, test } from 'bun:test';
import {
  createListenerObservation,
  probeListeningPorts,
} from './listener-observation.js';

test('expired listener reads await one shared fresh observation; failures preserve last good ports', async () => {
  let time = 0,
    calls = 0,
    settle;
  const cache = createListenerObservation(
    () => {
      calls += 1;
      return new Promise((resolve, reject) => {
        settle = { reject, resolve };
      });
    },
    () => time
  );
  const a = cache.read(),
    b = cache.read();
  await Promise.resolve();
  expect(calls).toBe(1);
  settle.resolve([{ port: 3331 }]);
  expect(await a).toEqual(await b);
  expect(cache.observation()).toEqual({ observedAt: 0, state: 'ready' });
  time = 1499;
  expect(await cache.read()).toEqual([{ port: 3331 }]);
  expect(calls).toBe(1);
  time = 1500;
  const c = cache.read();
  await Promise.resolve();
  expect(calls).toBe(2);
  settle.resolve([{ port: 3332 }]);
  expect(await c).toEqual([{ port: 3332 }]);
  time = 3000;
  const d = cache.read();
  await Promise.resolve();
  settle.reject(new Error('failed'));
  expect(await d).toEqual([{ port: 3332 }]);
  expect(cache.observation()).toEqual({
    code: 'LISTENER_PROBE_FAILED',
    observedAt: 1500,
    state: 'unknown',
  });
});

test('initial observation failure cannot manufacture a valid empty listener set', async () => {
  const cache = createListenerObservation(() =>
    Promise.reject(new Error('denied'))
  );
  await expect(cache.read()).rejects.toMatchObject({
    code: 'LISTENER_PROBE_FAILED',
  });
});

test('lsof exit one retains stdout, duplicate sockets collapse, failures stay unknown', async () => {
  const fake =
    (error, stdout, stderr = '') =>
    (_cmd, _args, _options, cb) =>
      cb(error, stdout, stderr);
  expect(
    await probeListeningPorts(
      fake({ code: 1 }, 'p123\ncnode\nn*:3331\nn127.0.0.1:3331\n')
    )
  ).toEqual([{ cmd: 'node', pid: '123', port: 3331 }]);
  expect(await probeListeningPorts(fake({ code: 1 }, ''))).toEqual([]);
  await expect(
    probeListeningPorts(fake({ code: 'ENOENT' }, ''))
  ).rejects.toMatchObject({ code: 'LISTENER_PROBE_FAILED' });
  await expect(
    probeListeningPorts(fake({ code: 1 }, '', 'permission denied'))
  ).rejects.toMatchObject({ code: 'LISTENER_PROBE_FAILED' });
});
