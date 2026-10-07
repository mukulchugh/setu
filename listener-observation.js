import { execFile } from 'node:child_process';

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
        const ports = [],
          seen = new Set();
        let current = {};
        for (const line of (stdout ?? '').split('\n')) {
          if (line.startsWith('p')) {
            current = { pid: line.slice(1) };
          } else if (line.startsWith('c')) {
            current.cmd = line.slice(1);
          } else if (line.startsWith('n')) {
            const match = line.match(/:(\d+)$/);
            if (!(match && current.pid)) {
              continue;
            }
            const key = `${current.pid}:${match[1]}`;
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            ports.push({ ...current, port: Number(match[1]) });
          }
        }
        resolve(ports);
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
