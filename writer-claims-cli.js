import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  checkWriter,
  claimWriter,
  listWriterClaims,
  releaseWriter,
} from './writer-claims.js';

function allowedOptions(cmd) {
  if (cmd === 'claim') {
    return new Set(['agent', 'session', 'task', 'pid']);
  }
  if (cmd === 'release') {
    return new Set(['session', 'force']);
  }
  return new Set(cmd === 'claims' ? [] : ['session']);
}

function parseWriterArguments(cmd, argv) {
  const args = [];
  const flags = {};
  const allowed = allowedOptions(cmd);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      continue;
    }
    if (arg === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      args.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (!allowed.has(key)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (key === 'force') {
      flags[key] = true;
      continue;
    }
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    i += 1;
    flags[key] = argv[i];
  }
  if (args.length > (cmd === 'claims' ? 0 : 1)) {
    throw new Error(`Too many arguments for setu ${cmd}`);
  }
  if (cmd === 'claim-check' && !args[0]) {
    throw new Error('Usage: setu claim-check <path> --session Y [--json]');
  }
  return { args, flags };
}

function writerPath(args) {
  return args[0]?.startsWith('~/')
    ? join(homedir(), args[0].slice(2))
    : (args[0] ?? process.cwd());
}

async function executeWriterCommand(cmd, path, flags) {
  if (cmd === 'claim') {
    return claimWriter(path, {
      agent: flags.agent,
      pid: flags.pid === undefined ? process.ppid : Number(flags.pid),
      session: flags.session,
      task: flags.task,
    });
  }
  if (cmd === 'release') {
    return releaseWriter(path, flags.session, { force: flags.force === true });
  }
  if (cmd === 'claim-check') {
    return checkWriter(path, flags.session);
  }
  const { loadConfig, writerClaimPaths } = await import('./lib.js');
  return listWriterClaims(writerClaimPaths(loadConfig().workspace));
}

function printWriterResult(cmd, result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (cmd === 'claims') {
    if (!result.length) {
      console.log('No active writer claims.');
    }
    for (const row of result) {
      if (row.unreadable) {
        console.log(`${row.path}: unreadable writer claim: ${row.error}`);
      } else {
        console.log(
          `${row.wtDir}: ${row.agent} (session ${row.session}, pid ${row.pid}) ${row.task}`
        );
      }
    }
    return;
  }
  if (cmd === 'claim') {
    console.log(
      `Claimed ${result.wtDir} for ${result.claim.agent} (session ${result.claim.session}).`
    );
    if (result.tookOverFrom) {
      console.error(
        `Warning: took over a stale claim from ${result.tookOverFrom.agent} (session ${result.tookOverFrom.session}); this tree may hold that owner's uncommitted work.`
      );
    }
  } else if (cmd === 'release') {
    console.log(
      `${result.released ? 'Released' : 'No writer claim on'} ${result.wtDir}.`
    );
  }
}

// Separate from the legacy argument parser: --json is always boolean,
// including when it precedes the optional worktree path.
export async function runWriterCommand(cmd, argv) {
  const asJson = argv.includes('--json');
  try {
    const { args, flags } = parseWriterArguments(cmd, argv);
    const result = await executeWriterCommand(cmd, writerPath(args), flags);
    printWriterResult(cmd, result, asJson);
    if (result.ok === false) {
      console.error(result.error);
      return 2;
    }
    return 0;
  } catch (e) {
    if (asJson) {
      console.log(JSON.stringify({ error: e.message, ok: false }));
    }
    console.error(e.message);
    return cmd === 'claim-check' ? 2 : 1;
  }
}
