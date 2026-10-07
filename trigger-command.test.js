import { expect, test } from 'bun:test';
import { requestPortalMutation } from './remove-command.js';
import { runTriggerCommand } from './trigger-command.js';

test('offline Trigger start and stop never spawn, signal, read PID files or start the portal', async () => {
  for (const action of ['start', 'stop']) {
    const effects = [],
      output = [],
      errors = [];
    const result = await runTriggerCommand(
      { action, name: 'topic', repo: 'r' },
      {
        ensurePortal: () => effects.push('portal'),
        readPid: () => effects.push('pid'),
        request: async () => {
          throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
        },
        signal: () => effects.push('signal'),
        spawn: () => effects.push('spawn'),
        stderr: (value) => errors.push(value),
        stdout: (value) => output.push(value),
      }
    );
    expect(result.result.code).toBe('PORTAL_REQUIRED');
    expect(result.exitCode).toBe(1);
    expect(effects).toEqual([]);
    expect(output).toEqual([]);
    expect(errors[0]).toContain('No local process');
  }
});
test('online Trigger delegates exact start/stop once and JSON preserves refusal metadata', async () => {
  const sent = [],
    output = [];
  const response = {
    code: 'TARGET_REMOVING',
    error: 'Removal owns this checkout',
    ok: false,
  };
  const result = await runTriggerCommand(
    { action: 'start', json: true, name: 'feature/one', repo: 'r' },
    {
      request: async (path, body) => {
        sent.push({ body, path });
        return response;
      },
      stderr() {
        /* No side effect is needed in this fixture. */
      },
      stdout: (value) => output.push(value),
    }
  );
  expect(sent).toEqual([
    { body: { name: 'feature/one', repo: 'r' }, path: '/api/trigger/start' },
  ]);
  expect(JSON.parse(output[0])).toEqual(response);
  expect(result.exitCode).toBe(1);
});
test('malformed successful HTTP response is uncertain and never replayed', async () => {
  let requests = 0;
  const result = await runTriggerCommand(
    { action: 'stop', name: 'topic', repo: 'r' },
    {
      request: (path, body) =>
        requestPortalMutation(body, {
          fetch: async () => {
            requests += 1;
            return new Response('not JSON', { status: 200 });
          },
          url: path,
        }),
      stderr() {
        /* No side effect is needed in this fixture. */
      },
      stdout() {
        throw new Error('must not report success');
      },
    }
  );
  expect(result.result.code).toBe('TRIGGER_OUTCOME_UNKNOWN');
  expect(requests).toBe(1);
});
