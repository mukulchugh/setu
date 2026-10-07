import { lstatSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { reviewBashAllowed } from './pr-review.js';

export function reviewWriteAllowed(filePath, reportDir) {
  if (!(typeof filePath === 'string' && typeof reportDir === 'string')) {
    return false;
  }
  try {
    const reportPath = resolve(reportDir);
    const requested = resolve(filePath);
    const requestedRelative = relative(reportPath, requested);
    if (
      !requestedRelative ||
      requestedRelative === '..' ||
      requestedRelative.startsWith('../')
    ) {
      return false;
    }

    // lstat, rather than exists, sees dangling links. Every component below
    // the report root must be a real path so Write cannot follow a link after
    // this guard has approved a new file name.
    for (
      let current = requested;
      current !== reportPath;
      current = dirname(current)
    ) {
      const parent = dirname(current);
      if (parent === current) {
        return false;
      }
      try {
        if (lstatSync(current).isSymbolicLink()) {
          return false;
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          return false;
        }
      }
    }
    if (!lstatSync(reportPath).isDirectory()) {
      return false;
    }
    const report = realpathSync(reportPath);
    const candidate = resolve(report, requestedRelative);
    const rel = relative(report, candidate);
    return !!rel && rel !== '..' && !rel.startsWith('../');
  } catch {
    return false;
  }
}

async function input() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const [kind, reportDir] = process.argv.slice(2);
  const event = await input();
  const allowed =
    kind === 'bash'
      ? reviewBashAllowed(event?.tool_input?.command)
      : kind === 'write' &&
        reviewWriteAllowed(event?.tool_input?.file_path, reportDir);
  if (!allowed) {
    console.error(
      'This headless review permits only its saved report output and read-only commands.'
    );
    process.exit(2);
  }
}
