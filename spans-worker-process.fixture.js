import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [, , modeOrMarker, suppliedMarker] = process.argv;
const fixturePath = fileURLToPath(import.meta.url);
const groupMode =
  modeOrMarker === 'group-parent' || modeOrMarker === 'group-descendant';
const behavior = groupMode ? null : suppliedMarker;
const marker = groupMode ? suppliedMarker : modeOrMarker;
if (!marker) {
  process.exit(2);
}

if (modeOrMarker === 'group-parent') {
  const child = spawn(
    process.execPath,
    [fixturePath, 'group-descendant', marker],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
    }
  );
  child.unref();
  writeFileSync(`${marker}.parent.pid`, String(process.pid), { mode: 0o600 });
  writeFileSync(`${marker}.ready`, 'ready', { mode: 0o600 });
  process.on('SIGUSR2', () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    process.exit(0);
  });
  process.stdout.write('parent exiting before inherited child\n');
  setTimeout(() => process.exit(0), 250);
} else if (modeOrMarker === 'group-descendant') {
  writeFileSync(`${marker}.descendant.pid`, String(process.pid), {
    mode: 0o600,
  });
  writeFileSync(`${marker}.descendant-ready`, 'ready', { mode: 0o600 });
  process.stdout.write('inherited child remains\n');
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGUSR2', () => process.exit(0));
  setInterval(() => {
    // Keep the group descendant alive until the owner signals it.
  }, 60_000);
} else {
  const inputChunks = [];
  if (behavior === 'reject-stdin') {
    process.stdin.destroy();
    writeFileSync(`${marker}.stdin-rejected`, 'rejected', { mode: 0o600 });
  }
  process.stdin.on('data', (chunk) => inputChunks.push(Buffer.from(chunk)));
  process.stdin.on('end', () => {
    writeFileSync(`${marker}.stdin`, Buffer.concat(inputChunks), {
      mode: 0o600,
    });
  });
  writeFileSync(`${marker}.pid`, String(process.pid), { mode: 0o600 });
  writeFileSync(`${marker}.ready`, 'ready', { mode: 0o600 });
  process.stdout.write('first token=fixture-secret\n');
  if (behavior === 'native-session') {
    process.stderr.write('{"session_id":"stderr-native"}\n');
    process.stdout.write('{"session_');
    setImmediate(() => {
      process.stdout.write(
        'id":"native-fixture"}\n{"session_id":"later-native"}\n'
      );
    });
  }
  const finish = () => {
    writeFileSync(`${marker}.exited`, 'exited', { mode: 0o600 });
    process.exit(0);
  };
  process.on('SIGUSR1', () => {
    process.stdout.write('second fixture chunk\n');
    writeFileSync(`${marker}.second`, 'emitted', { mode: 0o600 });
  });
  process.on('SIGUSR2', finish);
  process.on('SIGTERM', finish);
  setInterval(() => {
    // Keep the fixture process available for the capture lifetime.
  }, 60_000);
}
