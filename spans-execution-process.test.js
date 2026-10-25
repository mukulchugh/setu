import { expect, test } from 'bun:test';
import { createSpansExecutionLauncher } from './spans-execution-process.js';

function stream(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(Buffer.from(part));
      }
      controller.close();
    },
  });
}

async function capturedProvider({ chunk, native, stderr = [], stdout }) {
  const output = [];
  const ids = [];
  let exits = 0;
  const launcher = createSpansExecutionLauncher({
    maxChunkBytes: 1024,
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: 'fixture-start',
      state: 'alive',
    }),
    resolveLaunch: async () => ({
      argv: ['fake-provider'],
      ok: true,
      stdin: 'retained fixture input',
    }),
    signal() {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    },
    spawn: () => ({
      exitCode: 0,
      exited: Promise.resolve(0),
      pid: 100,
      signalCode: null,
      stderr: stream(stderr),
      stdin: {
        end: () => undefined,
        write: () => undefined,
      },
      stdout: stream(stdout),
    }),
  });
  try {
    const launched = await launcher.launch({
      attemptDigest: 'fixture',
      binding: {},
      sink: {
        chunk(text) {
          output.push(text);
          return chunk ? chunk(text) : { ok: true };
        },
        exit() {
          exits += 1;
          return { ok: true };
        },
        native(id) {
          ids.push(id);
          return native ? native(id) : { ok: true };
        },
      },
    });
    expect(launched.ok).toBe(true);
    await launcher.idle();
    return { exits, ids, output };
  } finally {
    launcher.shutdown();
  }
}

test('stdout session observation preserves complete evidence and ignores stderr IDs', async () => {
  const final = JSON.stringify({ session_id: 'stdout-session' });
  const result = await capturedProvider({
    stderr: ['{"session_id":"stderr-session"}\n'],
    stdout: ['x'.repeat(70 * 1024), '\n', final.slice(0, 7), final.slice(7)],
  });
  expect(result.ids).toEqual(['stdout-session']);
  const stdout = result.output
    .join('')
    .replace('{"session_id":"stderr-session"}\n', '');
  expect(stdout === `${'x'.repeat(70 * 1024)}\n${final}`).toBe(true);
  expect(result.exits).toBe(1);
});

test('refused session binding does not truncate later evidence or retry a different ID', async () => {
  const stdout =
    '{"session_id":"first-session"}\n{"session_id":"second-session"}\n';
  const result = await capturedProvider({
    native: () => ({ code: 'STORE_UNAVAILABLE', ok: false }),
    stdout: [stdout],
  });
  expect(result.ids).toEqual(['first-session']);
  expect(result.output.join('')).toBe(stdout);
  expect(result.exits).toBe(1);
});

test('an unrecorded chunk cannot be reported as a fully captured exit', async () => {
  const result = await capturedProvider({
    chunk() {
      throw new Error('fixture write failed');
    },
    stdout: ['provider evidence'],
  });
  expect(result.exits).toBe(0);
});
