import { homedir } from 'os';
import { join } from 'path';
import { claimWriter, releaseWriter, checkWriter, listWriterClaims } from './writer-claims.js';

// Separate from the legacy argument parser: --json is always boolean,
// including when it precedes the optional worktree path.
export async function runWriterCommand(cmd, argv) {
  const args = [], flags = {};
  const asJson = argv.includes('--json');
  try {
    const allowed = new Set(cmd === 'claim' ? ['agent', 'session', 'task', 'pid'] : cmd === 'release' ? ['session', 'force'] : cmd === 'claims' ? [] : ['session']);
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--json') continue;
      if (arg === '--') { args.push(...argv.slice(i + 1)); break; }
      if (!arg.startsWith('--')) { args.push(arg); continue; }
      const key = arg.slice(2);
      if (!allowed.has(key)) throw new Error(`Unknown option: ${arg}`);
      if (key === 'force') { flags[key] = true; continue; }
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      flags[key] = argv[++i];
    }
    if (args.length > (cmd === 'claims' ? 0 : 1)) throw new Error(`Too many arguments for setu ${cmd}`);
    if (cmd === 'claim-check' && !args[0]) throw new Error('Usage: setu claim-check <path> --session Y [--json]');
    const path = args[0]?.startsWith('~/') ? join(homedir(), args[0].slice(2)) : args[0] ?? process.cwd();
    let result;
    if (cmd === 'claim') {
      result = claimWriter(path, { agent: flags.agent, session: flags.session, task: flags.task, pid: flags.pid === undefined ? process.ppid : Number(flags.pid) });
    } else if (cmd === 'release') {
      result = releaseWriter(path, flags.session, { force: flags.force === true });
    } else if (cmd === 'claim-check') {
      result = checkWriter(path, flags.session);
    } else {
      const { loadConfig, writerClaimPaths } = await import('./lib.js');
      result = listWriterClaims(writerClaimPaths(loadConfig().workspace));
    }
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else if (cmd === 'claims') {
      if (!result.length) console.log('No active writer claims.');
      for (const row of result) {
        if (row.unreadable) console.log(`${row.path}: unreadable writer claim: ${row.error}`);
        else console.log(`${row.wtDir}: ${row.agent} (session ${row.session}, pid ${row.pid}) ${row.task}`);
      }
    } else if (cmd === 'claim') {
      console.log(`Claimed ${result.wtDir} for ${result.claim.agent} (session ${result.claim.session}).`);
      if (result.tookOverFrom) console.error(`Warning: took over a stale claim from ${result.tookOverFrom.agent} (session ${result.tookOverFrom.session}); this tree may hold that owner's uncommitted work.`);
    }
    else if (cmd === 'release') console.log(`${result.released ? 'Released' : 'No writer claim on'} ${result.wtDir}.`);
    if (result.ok === false) { console.error(result.error); return 2; }
    return 0;
  } catch (e) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: e.message }));
    console.error(e.message);
    return cmd === 'claim-check' ? 2 : 1;
  }
}
