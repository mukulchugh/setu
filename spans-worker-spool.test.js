import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import { openSpansStore } from './spans-store.js';
import { createSpansWorker } from './spans-worker.js';
import { createSpansWorkerSpool } from './spans-worker-spool.js';

const roots = new Set();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'setu-spans-spool-'));
  roots.add(root);
  const binding = {
    actionId: 'action-1',
    attemptId: 'attempt-1',
    generation: 3,
    runId: 'run-1',
    spanId: 'span-1',
    workerId: 'worker-1',
  };
  const attemptDigest = hash(
    JSON.stringify(['spans.worker.attempt', ...Object.values(binding)])
  );
  return { attemptDigest, binding, root };
}
const hash = (text) => createHash('sha256').update(text).digest('hex');
function chunk(f, seq, text) {
  return {
    attemptDigest: f.attemptDigest,
    binding: f.binding,
    bytes: Buffer.byteLength(text),
    digest: hash(text),
    generation: f.binding.generation,
    seq,
    text,
  };
}
function final(f, texts, complete = true) {
  const digests = texts.map(hash);
  return {
    attemptDigest: f.attemptDigest,
    binding: f.binding,
    bytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    chainDigest: hash(digests.join('\n')),
    chunks: texts.length,
    complete,
    generation: f.binding.generation,
  };
}
function makeSpool(f, options = {}) {
  return createSpansWorkerSpool({
    root: f.root,
    withCurrentAttempt: (binding, effect) =>
      binding.generation === f.binding.generation
        ? effect()
        : { code: 'STALE_GENERATION', ok: false },
    ...options,
  });
}
afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { force: true, recursive: true }))
  );
  roots.clear();
});

test('the detached spool accepts the current execution chunk ceiling and rejects a larger bound', async () => {
  const f = await fixture();
  expect(() => makeSpool(f, { maxAttemptChunks: 65_536 })).not.toThrow();
  expect(() => makeSpool(f, { maxAttemptChunks: 65_537 })).toThrow();
});

test('reopens a durable attempt, accepts exact retries, and finalizes to the shared content address', async () => {
  const f = await fixture();
  const first = makeSpool(f);
  expect(
    await first.append(chunk(f, 0, 'Authorization: [REDACTED]\n'))
  ).toEqual({ ok: true });
  const reopened = makeSpool(f);
  expect(reopened.stat({ attemptDigest: f.attemptDigest })).toEqual({
    bytes: 26,
    chunks: 1,
    ok: true,
  });
  expect(
    await reopened.append(chunk(f, 0, 'Authorization: [REDACTED]\n'))
  ).toEqual({ ok: true });
  expect((await reopened.append(chunk(f, 0, 'different\n'))).code).toBe(
    'SPOOL_CONFLICT'
  );
  expect(
    (
      await reopened.append(
        chunk({ ...f, binding: { ...f.binding, generation: 4 } }, 1, 'wrong\n')
      )
    ).code
  ).toBe('STALE_GENERATION');
  expect((await reopened.append(chunk(f, 1, 'token=raw-secret\n'))).code).toBe(
    'SPOOL_MISMATCH'
  );
  const result = await reopened.finalize(
    final(f, ['Authorization: [REDACTED]\n'])
  );
  expect(result.ok).toBe(true);
  expect(
    await reopened.finalize(final(f, ['Authorization: [REDACTED]\n']))
  ).toEqual(result);
  expect((await reopened.append(chunk(f, 1, 'late\n'))).code).toBe(
    'SPOOL_CONFLICT'
  );
  expect(
    (
      await reopened.finalize({
        ...final(f, ['Authorization: [REDACTED]\n']),
        complete: false,
      })
    ).code
  ).toBe('SPOOL_CONFLICT');
  expect(
    createSpansArtifacts({ root: f.root }).read({
      artifactId: result.artifactId,
    })
  ).toEqual({
    mediaType: 'text/plain',
    ok: true,
    text: 'Authorization: [REDACTED]\n',
  });
});

test('a partial temporary write is ignored and the same chunk can be retried', async () => {
  const f = await fixture();
  const spool = makeSpool(f);
  expect((await spool.append(chunk(f, 0, 'safe\n'))).ok).toBe(true);
  const dir = join(f.root, 'worker-spool', f.attemptDigest);
  await writeFile(join(dir, '.tmp-interrupted'), '{"text":"partial');
  const reopened = makeSpool(f);
  expect(reopened.stat({ attemptDigest: f.attemptDigest })).toEqual({
    bytes: 5,
    chunks: 1,
    ok: true,
  });
  expect(await reopened.append(chunk(f, 1, 'tail\n'))).toEqual({ ok: true });
  expect((await reopened.finalize(final(f, ['safe\n', 'tail\n']))).ok).toBe(
    true
  );
  expect(
    (await readFile(join(dir, 'chunk-00000001.json'), 'utf8')).includes('tail')
  ).toBe(true);
});

test('refuses symlinked spool attempt directories', async () => {
  const f = await fixture();
  const spoolRoot = join(f.root, 'worker-spool');
  await mkdir(spoolRoot, { mode: 0o700 });
  const outside = join(f.root, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(spoolRoot, f.attemptDigest));
  expect(spoolRoot).toBeTruthy();
  expect((await makeSpool(f).append(chunk(f, 0, 'safe\n'))).code).toBe(
    'SPOOL_INVALID'
  );
});

test('enforces per-attempt byte and chunk bounds', async () => {
  const f = await fixture();
  const spool = makeSpool(f, {
    maxAttemptBytes: 8,
    maxAttemptChunks: 1,
    maxChunkBytes: 8,
  });
  expect((await spool.append(chunk(f, 0, '123456789\n'))).code).toBe(
    'SPOOL_MISMATCH'
  );
  expect(await spool.append(chunk(f, 0, '1234567\n'))).toEqual({ ok: true });
  expect((await spool.append(chunk(f, 1, 'x\n'))).code).toBe('SPOOL_LIMIT');
});

test('bounds hostile seq and finalize counts before creating attempt state', async () => {
  const f = await fixture();
  const spool = makeSpool(f, { maxAttemptChunks: 2 });
  expect(
    (await spool.append(chunk(f, Number.MAX_SAFE_INTEGER, 'x\n'))).code
  ).toBe('SPOOL_LIMIT');
  expect(
    (await spool.finalize({ ...final(f, []), bytes: Number.MAX_SAFE_INTEGER }))
      .code
  ).toBe('SPOOL_LIMIT');
  expect(
    (await spool.finalize({ ...final(f, []), chunks: Number.MAX_SAFE_INTEGER }))
      .code
  ).toBe('SPOOL_LIMIT');
  expect(spool.stat({ attemptDigest: f.attemptDigest }).ok).toBe(false);
});

test('mutations fail closed without a serialized current-attempt authority', async () => {
  const f = await fixture();
  const spool = createSpansWorkerSpool({ root: f.root });
  expect(await spool.append(chunk(f, 0, 'safe\n'))).toMatchObject({
    code: 'SPOOL_AUTHORITY_REQUIRED',
    ok: false,
  });
  expect(await spool.finalize(final(f, []))).toMatchObject({
    code: 'SPOOL_AUTHORITY_REQUIRED',
    ok: false,
  });
  expect(spool.stat({ attemptDigest: f.attemptDigest }).ok).toBe(false);
});

test('a callback retained by rejected async authority cannot mutate after rejection', async () => {
  const f = await fixture();
  let retained;
  const spool = createSpansWorkerSpool({
    root: f.root,
    withCurrentAttempt: (_binding, effect) => {
      retained = effect;
      return Promise.reject(new Error('authority rejected'));
    },
  });

  expect(await spool.append(chunk(f, 0, 'safe\n'))).toMatchObject({
    code: 'SPOOL_AUTHORITY_REQUIRED',
    ok: false,
  });
  expect(() => retained()).toThrow();
  expect(spool.stat({ attemptDigest: f.attemptDigest }).ok).toBe(false);
});

test('a callback retained by throwing authority cannot mutate after the throw', async () => {
  const f = await fixture();
  let retained;
  const spool = createSpansWorkerSpool({
    root: f.root,
    withCurrentAttempt: (_binding, effect) => {
      retained = effect;
      throw new Error('authority threw');
    },
  });

  expect(await spool.append(chunk(f, 0, 'safe\n'))).toMatchObject({
    code: 'SPOOL_IO',
    ok: false,
  });
  expect(() => retained()).toThrow();
  expect(spool.stat({ attemptDigest: f.attemptDigest }).ok).toBe(false);
});

test('a callback retained after authority returns without invocation stays closed', async () => {
  const f = await fixture();
  let retained;
  const spool = createSpansWorkerSpool({
    root: f.root,
    withCurrentAttempt: (_binding, effect) => {
      retained = effect;
      return { code: 'STALE_GENERATION', ok: false };
    },
  });

  expect(await spool.append(chunk(f, 0, 'safe\n'))).toMatchObject({
    code: 'STALE_GENERATION',
    ok: false,
  });
  expect(() => retained()).toThrow();
  expect(spool.stat({ attemptDigest: f.attemptDigest }).ok).toBe(false);
});

test('authorized callback runs once and rejects duplicate or late invocation', async () => {
  const f = await fixture();
  let retained;
  const spool = createSpansWorkerSpool({
    root: f.root,
    withCurrentAttempt: (_binding, effect) => {
      retained = effect;
      return effect();
    },
  });

  expect(await spool.append(chunk(f, 0, 'safe\n'))).toEqual({ ok: true });
  expect(() => retained()).toThrow();
  expect(() => retained()).toThrow();
  expect(spool.stat({ attemptDigest: f.attemptDigest })).toEqual({
    bytes: 5,
    chunks: 1,
    ok: true,
  });
});

test('separate processes serialize append against finalization', async () => {
  const f = await fixture();
  const parent = makeSpool(f);
  expect(await parent.append(chunk(f, 0, 'first\n'))).toEqual({ ok: true });

  const script = `
    import { createSpansWorkerSpool } from ${JSON.stringify(new URL('./spans-worker-spool.js', import.meta.url).href)};
    const input = JSON.parse(process.argv[1]);
    const spool = createSpansWorkerSpool({ root: input.root, withCurrentAttempt: (_binding, effect) => effect() });
    const result = input.method === 'append' ? await spool.append(input.payload) : await spool.finalize(input.payload);
    process.stdout.write(JSON.stringify(result));
  `;
  const run = (method, payload) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['-e', script, JSON.stringify({ method, payload, root: f.root })],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (part) => {
        stdout += part;
      });
      child.stderr.setEncoding('utf8').on('data', (part) => {
        stderr += part;
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`spool child exited ${code}: ${stderr}`));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  const [appendResult, finalizeResult] = await Promise.all([
    run('append', chunk(f, 1, 'second\n')),
    run('finalize', final(f, ['first\n'])),
  ]);
  if (finalizeResult.ok) {
    expect(appendResult.code).toBe('SPOOL_CONFLICT');
    expect(parent.stat({ attemptDigest: f.attemptDigest })).toEqual({
      bytes: 6,
      chunks: 1,
      ok: true,
    });
  } else {
    expect(finalizeResult.code).toBe('SPOOL_MISMATCH');
    expect(appendResult).toEqual({ ok: true });
    expect(parent.stat({ attemptDigest: f.attemptDigest })).toEqual({
      bytes: 13,
      chunks: 2,
      ok: true,
    });
    expect(
      await parent.finalize(final(f, ['first\n', 'second\n']))
    ).toMatchObject({ ok: true });
  }
});

test('stat rejects hard-linked records, gaps, and stored totals over the configured bound', async () => {
  const f = await fixture();
  const spool = makeSpool(f, {
    maxAttemptBytes: 8,
    maxAttemptChunks: 4,
    maxChunkBytes: 8,
  });
  expect(await spool.append(chunk(f, 0, 'safe\n'))).toEqual({ ok: true });
  const dir = join(f.root, 'worker-spool', f.attemptDigest);
  await link(join(dir, 'chunk-00000000.json'), join(f.root, 'linked-record'));
  expect(spool.stat({ attemptDigest: f.attemptDigest }).code).toBe(
    'SPOOL_INVALID'
  );
  await rm(join(f.root, 'linked-record'));
  await writeFile(
    join(dir, 'chunk-00000002.json'),
    JSON.stringify({
      bytes: 2,
      digest: hash('x\n'),
      seq: 2,
      text: 'x\n',
      version: 1,
    }),
    { mode: 0o600 }
  );
  expect(spool.stat({ attemptDigest: f.attemptDigest }).code).toBe(
    'SPOOL_INVALID'
  );
});

test('stat refuses chunks added after finalization', async () => {
  const f = await fixture();
  const spool = makeSpool(f, {
    maxAttemptBytes: 8,
    maxAttemptChunks: 4,
    maxChunkBytes: 8,
  });
  expect(await spool.append(chunk(f, 0, 'safe\n'))).toEqual({ ok: true });
  expect((await spool.finalize(final(f, ['safe\n']))).ok).toBe(true);
  const dir = join(f.root, 'worker-spool', f.attemptDigest);
  await writeFile(
    join(dir, 'chunk-00000001.json'),
    JSON.stringify({
      bytes: 4,
      digest: hash('late'),
      seq: 1,
      text: 'late',
      version: 1,
    }),
    { mode: 0o600 }
  );
  expect(spool.stat({ attemptDigest: f.attemptDigest }).code).toBe(
    'SPOOL_INVALID'
  );
});

test('stat rechecks the configured aggregate byte cap against persisted chunks', async () => {
  const f = await fixture();
  const spool = makeSpool(f, {
    maxAttemptBytes: 8,
    maxAttemptChunks: 4,
    maxChunkBytes: 8,
  });
  expect(await spool.append(chunk(f, 0, 'safe\n'))).toEqual({ ok: true });
  const dir = join(f.root, 'worker-spool', f.attemptDigest);
  await writeFile(
    join(dir, 'chunk-00000001.json'),
    JSON.stringify({
      bytes: 4,
      digest: hash('late'),
      seq: 1,
      text: 'late',
      version: 1,
    }),
    { mode: 0o600 }
  );
  expect(spool.stat({ attemptDigest: f.attemptDigest }).code).toBe(
    'SPOOL_INVALID'
  );
});

test('actual worker appends and finalizes through the filesystem spool', async () => {
  const f = await fixture();
  let view = {
    actions: {
      [f.binding.actionId]: {
        actionId: f.binding.actionId,
        attemptId: f.binding.attemptId,
        spanId: f.binding.spanId,
        state: 'intent',
      },
    },
    generation: f.binding.generation,
    runId: f.binding.runId,
  };
  let revision = 0;
  const store = {
    commitRun(request) {
      if (request.expectedGeneration !== view.generation) {
        return { code: 'SPANS_MODEL_STALE_GENERATION', ok: false };
      }
      if (request.expectedRevision !== revision) {
        return { code: 'SPANS_MODEL_STALE_REVISION', ok: false };
      }
      view = structuredClone(request.view);
      revision += 1;
      return { ok: true };
    },
    readRun: () => ({
      generation: view.generation,
      ok: true,
      revision,
      view: structuredClone(view),
    }),
  };
  let sink;
  const worker = createSpansWorker({
    clock: { now: () => 100 },
    launcher: {
      launch: ({ sink: launchedSink }) => {
        sink = launchedSink;
        return {
          nativeId: 'native-1',
          ok: true,
          processStart: { id: 'proc-1', pid: 123 },
        };
      },
    },
    limits: {
      maxActiveAttempts: 1,
      maxAttemptBytes: 1024,
      maxAttemptChunks: 8,
      maxChunkBytes: 128,
      maxDeadlineMs: 1000,
      maxQueueBytes: 1024,
    },
    spool: makeSpool(f, {
      withCurrentAttempt: (binding, effect) =>
        binding.generation === view.generation
          ? effect()
          : { code: 'STALE_GENERATION', ok: false },
    }),
    store,
    workerId: f.binding.workerId,
  });
  expect(
    (
      await worker.start({
        actionId: f.binding.actionId,
        attemptId: f.binding.attemptId,
        deadlineMs: 500,
        generation: f.binding.generation,
        runId: f.binding.runId,
        spanId: f.binding.spanId,
      })
    ).ok
  ).toBe(true);
  expect((await sink.chunk('safe output\n')).ok).toBe(true);
  expect((await sink.exit({ code: 0, signal: null })).status).toBe('exited');
  expect(view.attempts[f.binding.attemptId].capture).toMatchObject({
    bytes: 12,
    chunks: 1,
    complete: true,
  });
  const artifact = createSpansArtifacts({ root: f.root }).read({
    artifactId: view.attempts[f.binding.attemptId].capture.artifactId,
  });
  expect(artifact).toEqual({
    mediaType: 'text/plain',
    ok: true,
    text: 'safe output\n',
  });
});

test('real archive authority fences spool writes after a durable generation change', async () => {
  const f = await fixture();
  f.binding.generation = 0;
  f.attemptDigest = hash(
    JSON.stringify(['spans.worker.attempt', ...Object.values(f.binding)])
  );
  const store = openSpansStore({ root: f.root });
  try {
    const view = {
      attempts: { [f.binding.attemptId]: { ...f.binding, status: 'running' } },
      generation: 0,
    };
    expect(
      store.commitRun({
        events: [],
        expectedGeneration: 0,
        expectedRevision: 0,
        runId: f.binding.runId,
        view,
      }).ok
    ).toBe(true);
    const spool = createSpansWorkerSpool({
      root: f.root,
      withCurrentAttempt: store.withCurrentAttempt,
    });
    expect(await spool.append(chunk(f, 0, 'first\n'))).toEqual({ ok: true });
    expect(
      store.commitRun({
        events: [],
        expectedGeneration: 0,
        expectedRevision: 1,
        runId: f.binding.runId,
        view: { ...view, generation: 1 },
      }).ok
    ).toBe(true);
    expect(await spool.append(chunk(f, 1, 'stale\n'))).toMatchObject({
      code: 'STALE_GENERATION',
      ok: false,
    });
    expect(spool.stat({ attemptDigest: f.attemptDigest })).toEqual({
      bytes: 6,
      chunks: 1,
      ok: true,
    });
    expect(await spool.finalize(final(f, ['first\n']))).toMatchObject({
      code: 'STALE_GENERATION',
      ok: false,
    });
  } finally {
    expect(store.close().ok).toBe(true);
  }
});
