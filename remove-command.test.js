import { expect, test } from 'bun:test';
import { requestRemoval, runRemoveCommand } from './remove-command.js';

test('offline removal refuses without deleting locally or starting a portal', async () => {
  const effects = [],
    output = [],
    errors = [];
  const outcome = await runRemoveCommand(
    { force: true, name: 'topic', repo: 'r' },
    {
      ensurePortal: () => effects.push('started'),
      portalAvailable: () => false,
      removeLocal: async () => {
        effects.push('deleted');
      },
      request: async () => {
        throw Object.assign(new Error('Connection refused'), {
          code: 'ECONNREFUSED',
        });
      },
      stderr: (text) => errors.push(text),
      stdout: (text) => output.push(text),
    }
  );
  expect({
    code: outcome.result.code,
    effects,
    exitCode: outcome.exitCode,
    output,
  }).toEqual({ code: 'PORTAL_REQUIRED', effects: [], exitCode: 1, output: [] });
  expect(errors[0]).toContain('No files were removed');
});

test('confirmed online removal sends the explicit force once and prints success', async () => {
  const sent = [],
    output = [],
    errors = [];
  const outcome = await runRemoveCommand(
    { force: true, name: 'feature/one', repo: 'r' },
    {
      portalAvailable: () => {
        throw new Error('PID markers must not decide reachability');
      },
      request: async (body) => {
        sent.push(body);
        return { ok: true };
      },
      stderr: (text) => errors.push(text),
      stdout: (text) => output.push(text),
    }
  );
  expect({ errors, outcome, output, sent }).toEqual({
    errors: [],
    outcome: { exitCode: 0, result: { ok: true } },
    output: ['removed r/feature/one'],
    sent: [{ force: true, name: 'feature/one', repo: 'r' }],
  });
});

test('timeout or disconnect after possible acceptance never retries or claims no deletion', async () => {
  for (const code of ['TimeoutError', 'ECONNRESET']) {
    let attempts = 0;
    const output = [],
      errors = [];
    const outcome = await runRemoveCommand(
      { name: 'topic', repo: 'r' },
      {
        request: async () => {
          attempts += 1;
          throw Object.assign(new Error('Interrupted'), { code });
        },
        stderr: (text) => errors.push(text),
        stdout: (text) => output.push(text),
      }
    );
    expect(outcome.result).toMatchObject({
      code: 'REMOVAL_OUTCOME_UNKNOWN',
      ok: false,
      removed: null,
    });
    expect({ attempts, output }).toEqual({ attempts: 1, output: [] });
    expect(errors[0]).not.toContain('No files were removed');
  }
});

test('invalid force refuses before a request', async () => {
  const outcome = await runRemoveCommand(
    { force: 'true', name: 'topic', repo: 'r' },
    {
      request: () => {
        return Promise.reject(new Error('must not dispatch'));
      },
      stderr: () => {
        /* No side effect is needed in this fixture. */
      },
      stdout: () => {
        /* No side effect is needed in this fixture. */
      },
    }
  );
  expect(outcome.result.code).toBe('INVALID_ARGUMENT');
});

test('body read failure after response headers is uncertain even with a connection-refused code', async () => {
  const outcome = await runRemoveCommand(
    { name: 'topic', repo: 'r' },
    {
      request: (body) =>
        requestRemoval(body, {
          fetch: async () => ({
            json: async () => {
              throw Object.assign(new Error('body lost'), {
                code: 'ECONNREFUSED',
              });
            },
            ok: true,
          }),
          url: 'http://127.0.0.1:2999/api/remove',
        }),
      stderr: () => {
        /* No side effect is needed in this fixture. */
      },
      stdout: () => {
        /* No side effect is needed in this fixture. */
      },
    }
  );
  expect(outcome.result).toMatchObject({
    code: 'REMOVAL_OUTCOME_UNKNOWN',
    removed: null,
  });
});

test('the removal transport preserves structured HTTP refusal instead of throwing its fields away', async () => {
  const result = {
    code: 'CLEANUP_PENDING',
    error: 'Cleanup remains',
    ok: false,
    operationId: 'op-1',
    pendingSteps: ['routing'],
    removed: true,
  };
  const sent = [];
  const received = await requestRemoval(
    { force: true, name: 'topic', repo: 'r' },
    {
      fetch: async (url, options) => {
        sent.push({
          body: JSON.parse(options.body),
          redirect: options.redirect,
          url,
        });
        return Response.json(result, { status: 500 });
      },
      url: 'http://127.0.0.1:2999/api/remove',
    }
  );
  expect(received).toEqual(result);
  expect(sent).toEqual([
    {
      body: { force: true, name: 'topic', repo: 'r' },
      redirect: 'error',
      url: 'http://127.0.0.1:2999/api/remove',
    },
  ]);
});

test('a malformed reply after possible acceptance reports uncertainty without replay', async () => {
  let requests = 0;
  const output = [],
    errors = [];
  const outcome = await runRemoveCommand(
    { name: 'topic', repo: 'r' },
    {
      request: async () => {
        requests += 1;
        return { message: 'proxy unavailable' };
      },
      stderr: (text) => errors.push(text),
      stdout: (text) => output.push(text),
    }
  );
  expect(outcome.result).toMatchObject({
    code: 'REMOVAL_OUTCOME_UNKNOWN',
    ok: false,
    removed: null,
  });
  expect({ output, requests }).toEqual({ output: [], requests: 1 });
  expect(errors[0]).not.toContain('No files were removed');
});

test('online rejection retains the server outcome and never prints removal success', async () => {
  const requests = [],
    output = [],
    errors = [];
  const result = {
    code: 'DIRTY_WORKTREE',
    error: 'Worktree has local changes',
    ok: false,
    removed: false,
  };
  const outcome = await runRemoveCommand(
    { force: false, name: 'topic', repo: 'r' },
    {
      request: async (body) => {
        requests.push(body);
        return result;
      },
      stderr: (text) => errors.push(text),
      stdout: (text) => output.push(text),
    }
  );
  expect(outcome).toEqual({ exitCode: 1, result });
  expect(requests).toEqual([{ force: false, name: 'topic', repo: 'r' }]);
  expect(output).toEqual([]);
  expect(errors).toEqual(['Worktree has local changes']);
});

test('exact cleanup retry and JSON output preserve the complete partial result', async () => {
  const result = {
    code: 'REMOVAL_INCOMPLETE',
    completed: ['git'],
    error: 'Worktree was removed; routing cleanup is pending',
    ok: false,
    operationId: 'op-42',
    pendingSteps: ['routing'],
    removed: true,
  };
  const sent = [],
    output = [],
    errors = [];
  const outcome = await runRemoveCommand(
    { json: true, name: 'topic', operationId: 'op-42', repo: 'r' },
    {
      request: async (body) => {
        sent.push(body);
        return result;
      },
      stderr: (text) => errors.push(text),
      stdout: (text) => output.push(text),
    }
  );
  expect(sent).toEqual([
    { force: false, name: 'topic', operationId: 'op-42', repo: 'r' },
  ]);
  expect(outcome).toEqual({ exitCode: 1, result });
  expect(JSON.parse(output[0])).toEqual(result);
  expect(errors.join('\n')).toContain('op-42');
});

test('unknown exact cleanup ID exits nonzero with JSON and never starts a new removal', async () => {
  const requests = [],
    output = [];
  const result = {
    code: 'REMOVAL_NOT_FOUND',
    error: 'Unknown operation',
    ok: false,
    removed: false,
  };
  const outcome = await runRemoveCommand(
    { json: true, name: 'topic', operationId: 'expired-id', repo: 'r' },
    {
      request: async (body) => {
        requests.push(body);
        return result;
      },
      stderr: () => {
        /* No side effect is needed in this fixture. */
      },
      stdout: (text) => output.push(text),
    }
  );
  expect(outcome.exitCode).toBe(1);
  expect(requests).toEqual([
    { force: false, name: 'topic', operationId: 'expired-id', repo: 'r' },
  ]);
  expect(output.map(JSON.parse)).toEqual([result]);
});

test('invalid exact retry ID refuses before dispatch and still emits JSON', async () => {
  let calls = 0;
  const output = [];
  const outcome = await runRemoveCommand(
    { json: true, name: 'topic', operationId: true, repo: 'r' },
    {
      request: async () => {
        calls += 1;
      },
      stderr: () => {
        /* No side effect is needed in this fixture. */
      },
      stdout: (text) => output.push(text),
    }
  );
  expect(calls).toBe(0);
  expect(outcome.exitCode).toBe(1);
  expect(JSON.parse(output[0]).code).toBe('INVALID_ARGUMENT');
});
