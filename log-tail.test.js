import { expect, test } from 'bun:test';
import { logSignature, readLogTail } from './log-tail.js';

function reader(text) {
  const content = Buffer.from(text),
    reads = [],
    closed = [];
  return {
    closed,
    files: {
      closeSync: (fd) => closed.push(fd),
      fstatSync: () => ({ size: content.length }),
      openSync: () => 3,
      readSync(_fd, buffer, offset, length, position) {
        reads.push(length);
        return content.copy(buffer, offset, position, position + length);
      },
    },
    reads,
  };
}

test('large log tails remain byte bounded for every requested line count and close descriptors', () => {
  for (const n of [
    undefined,
    1,
    2001,
    -5,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    1.5,
  ]) {
    const h = reader(`${'a'.repeat(400_000)}\nmarker\n`);
    const result = readLogTail('/owned/log', n, h);
    expect(h.reads.every((readSize) => readSize <= 262_144)).toBe(true);
    expect(h.closed).toEqual([3]);
    expect(result.lines).toEqual(['marker']);
    expect(result.truncated).toBe(true);
  }
  const huge = reader('अ'.repeat(150_000));
  const result = readLogTail('/owned/log', 150, huge);
  expect(result.lines.length).toBe(1);
  expect(result.lines[0]).toStartWith('[long line truncated] ');
  expect(result.lines[0]).not.toContain('\uFFFD');
});

test('missing, empty and read errors are distinct; failed reads retain only prior successful data', () => {
  const previous = readLogTail('/owned/log', 150, {
    ...reader('hello\n'),
    now: () => 10,
  });
  const denied = {
    openSync() {
      throw Object.assign(new Error('/secret/path'), { code: 'EACCES' });
    },
  };
  const failed = readLogTail('/owned/log', 150, {
    files: denied,
    now: () => 20,
    previous,
  });
  expect(failed).toMatchObject({
    code: 'EACCES',
    lines: ['hello'],
    observedAt: 20,
    retained: true,
    state: 'read-error',
    successfulAt: 10,
  });
  expect(JSON.stringify(failed)).not.toContain('/secret/path');
  expect(
    readLogTail('/owned/log', 150, { files: denied }).successfulAt
  ).toBeUndefined();
  expect(readLogTail('/owned/log', 150, reader(''))).toMatchObject({
    lines: [],
    retained: false,
    state: 'empty',
  });
  const missing = {
    openSync() {
      throw Object.assign(new Error('fixture file is missing'), {
        code: 'ENOENT',
      });
    },
  };
  expect(
    readLogTail('/owned/log', 150, { files: missing, previous })
  ).toMatchObject({ lines: [], retained: false, state: 'missing' });
});

test('signature errors cannot suppress a retry and open descriptors close after read failure', () => {
  expect(
    logSignature('/owned/log', {
      statSync() {
        throw Object.assign(new Error('fixture stat denied'), {
          code: 'EACCES',
        });
      },
    })
  ).toBeNull();
  const h = reader('hello');
  h.files.readSync = () => {
    throw Object.assign(new Error('fixture read failed'), { code: 'EIO' });
  };
  expect(readLogTail('/owned/log', 150, h).state).toBe('read-error');
  expect(h.closed).toEqual([3]);
});

test('real file growth, truncation and transient failures use one bounded snapshot and retry', async () => {
  const files = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { readLogSnapshot } = await import('./log-tail.js');
  const dir = files.mkdtempSync(join(tmpdir(), 'setu-log-test-')),
    path = join(dir, 'dev.log');
  const entry = {};
  let bytes = 0,
    denied = false;
  const io = {
    ...files,
    readSync(...args) {
      if (denied) {
        throw Object.assign(new Error('fixture read denied'), {
          code: 'EACCES',
        });
      }
      const n = files.readSync(...args);
      bytes += n;
      return n;
    },
  };
  try {
    files.writeFileSync(path, '1234567890\n'.repeat(50_000));
    const first = readLogSnapshot(entry, path, { files: io });
    expect(first.lines.length).toBe(150);
    for (let i = 0; i < 5; i += 1) {
      expect(readLogSnapshot(entry, path, { files: io })).toBeNull();
    }
    expect(bytes).toBe(262_144);
    files.appendFileSync(path, 'partial');
    expect(readLogSnapshot(entry, path, { files: io }).lines.at(-1)).toBe(
      'partial'
    );
    files.appendFileSync(path, ' continued');
    denied = true;
    expect(readLogSnapshot(entry, path, { files: io })).toMatchObject({
      retained: true,
      state: 'read-error',
    });
    denied = false;
    expect(readLogSnapshot(entry, path, { files: io }).lines.at(-1)).toBe(
      'partial continued'
    );
    files.writeFileSync(path, 'replacement');
    expect(readLogSnapshot(entry, path, { files: io }).lines).toEqual([
      'replacement',
    ]);
  } finally {
    files.rmSync(dir, { recursive: true });
  }
});

test('truncation between stat and read retains the prior good tail', () => {
  const h = reader('initial');
  const previous = readLogTail('/owned/log', 150, h);
  h.files.fstatSync = () => ({ size: 500_000 });
  h.files.readSync = () => 0;
  expect(readLogTail('/owned/log', 150, { ...h, previous })).toMatchObject({
    code: 'LOG_CHANGED',
    lines: ['initial'],
    retained: true,
    state: 'read-error',
  });
});

test('a removed subscribed checkout becomes a retained error rather than an interval exception', async () => {
  const { readLogSnapshot } = await import('./log-tail.js');
  const entry = { snapshot: readLogTail('/owned/log', 150, reader('initial')) };
  const result = readLogSnapshot(entry, () => {
    throw new Error('Worktree is no longer registered');
  });
  expect(result).toMatchObject({
    lines: ['initial'],
    retained: true,
    state: 'read-error',
  });
  expect(entry.signature).toBeNull();
});
