import { execFile } from 'node:child_process';

const listenerPortPattern = /:(\d+)$/;

function parseListenerRecord(line, current, seen, ports) {
  if (line.startsWith('p')) {
    return { pid: line.slice(1) };
  }
  if (line.startsWith('c')) {
    current.cmd = line.slice(1);
    return current;
  }
  if (!line.startsWith('n')) {
    return current;
  }
  const match = line.match(listenerPortPattern);
  if (!(match && current.pid)) {
    return current;
  }
  const key = `${current.pid}:${match[1]}`;
  if (!seen.has(key)) {
    seen.add(key);
    ports.push({ ...current, port: Number(match[1]) });
  }
  return current;
}

function parseListeningPorts(stdout) {
  const ports = [];
  const seen = new Set();
  let current = {};
  for (const line of (stdout ?? '').split('\n')) {
    current = parseListenerRecord(line, current, seen, ports);
  }
  return ports;
}

export function probeListeningPorts(run = execFile) {
  return new Promise((resolve, reject) => {
    run(
      'lsof',
      [
        '-i',
        'TCP:3000-3999',
        '-i',
        'TCP:8288-9287',
        '-sTCP:LISTEN',
        '-nP',
        '-F',
        'pcn',
      ],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 5000 },
      (error, stdout, stderr) => {
        // lsof exits 1 for a selector with no matches, even when another matched.
        if ((error && error.code !== 1) || stderr?.trim()) {
          reject(
            Object.assign(new Error('Listener observation failed'), {
              code: 'LISTENER_PROBE_FAILED',
            })
          );
          return;
        }
        resolve(parseListeningPorts(stdout));
      }
    );
  });
}

export function createListenerObservation(probe, now = Date.now) {
  let pending = null,
    ports = null,
    attemptedAt = null;
  let observation = { code: 'NOT_CHECKED', observedAt: null, state: 'unknown' };
  return {
    observation: () => ({ ...observation }),
    async read() {
      if (!pending && (attemptedAt === null || now() - attemptedAt >= 1500)) {
        pending = Promise.resolve()
          .then(probe)
          .then((value) => {
            ports = value;
            observation = { observedAt: now(), state: 'ready' };
          })
          .catch(() => {
            observation = {
              code: 'LISTENER_PROBE_FAILED',
              observedAt: observation.observedAt,
              state: 'unknown',
            };
          })
          .finally(() => {
            attemptedAt = now();
            pending = null;
          });
      }
      if (pending) {
        await pending;
      }
      if (ports === null) {
        throw Object.assign(
          new Error('Current process status is unavailable'),
          { code: 'LISTENER_PROBE_FAILED' }
        );
      }
      return ports;
    },
  };
}
