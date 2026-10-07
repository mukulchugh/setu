import { execFile } from 'node:child_process';

const readStart = (processId) =>
  new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-p', String(processId), '-o', 'lstart='],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        maxBuffer: 4096,
        timeout: 3000,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });

// A signal-0 check observes existence only; this helper never terminates a PID.
export async function observeProcessIdentity(
  processId,
  { run = readStart, signal = (pid, value) => process.kill(pid, value) } = {}
) {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    return { state: 'unknown' };
  }
  const presence = () => {
    try {
      signal(processId, 0);
      return 'alive';
    } catch (error) {
      return error.code === 'ESRCH' ? 'absent' : 'unknown';
    }
  };
  const before = presence();
  if (before !== 'alive') {
    return { state: before };
  }
  try {
    const processStartIdentity = (await run(processId))
      .trim()
      .replace(/\s+/g, ' ');
    if (
      !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(
        processStartIdentity
      )
    ) {
      return { state: 'unknown' };
    }
    const after = presence();
    return after === 'alive'
      ? { processId, processStartIdentity, state: 'alive' }
      : { state: after };
  } catch {
    return { state: presence() === 'absent' ? 'absent' : 'unknown' };
  }
}
