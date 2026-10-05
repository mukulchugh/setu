import { expect, test } from 'bun:test';
import {
  fileSyncPatterns,
  quoteShellPath,
  sidecarArguments,
  sidecarNameError,
  stripAnsiSgr,
} from './portal/ui-helpers';

test('sidecar arguments preserve typed whitespace until save and split then', () => {
  expect(sidecarArguments('run dev --watch')).toEqual([
    'run',
    'dev',
    '--watch',
  ]);
  expect(sidecarArguments('  ')).toEqual([]);
});

test('file-sync patterns split only at line boundaries', () => {
  expect(
    fileSyncPatterns('.env.{development,test}.local\nconfig/local.json')
  ).toEqual(['.env.{development,test}.local', 'config/local.json']);
});

test('sidecar names are trimmed and use only safe log-name characters', () => {
  expect(sidecarNameError(' worker_1 ')).toBeNull();
  expect(sidecarNameError('worker.log')).toBe(
    'Use only letters, numbers, underscores, and hyphens for sidecar names.'
  );
});

test('cd paths are safely single-quoted', () => {
  expect(quoteShellPath("/tmp/feature/o'hare")).toBe(
    "'/tmp/feature/o'\\''hare'"
  );
});

test('ANSI SGR sequences do not appear in rendered logs', () => {
  expect(stripAnsiSgr('\u001b[31mfailed\u001b[0m')).toBe('failed');
});
