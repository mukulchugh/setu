// agent.test.js — `bun agent.test.js`. No framework, no fixtures.
//
// Covers the three pieces of agent.js that are non-trivial and testable without
// a container engine: line reassembly across chunk boundaries, the output tail
// cap, and credential resolution. The docker/sandcastle seam needs a live
// engine and is Stage 0's job, not this file's.

import assert from 'node:assert/strict';
import {
  AGENT_ADAPTERS,
  agentRunFinish,
  agentRunStart,
  agentStatus,
  applyBudgetGuard,
  boundedTail,
  DEFAULT_MAX_BUDGET_USD,
  INTERACTIVE_ONLY,
  pumpLines,
  resolveCredential,
  runAgent,
} from './agent.js';

const UNKNOWN_AGENT = /unknown agent/;
const MINT_CMD = /claude setup-token/;

// Feeds an array of byte-chunks through pumpLines as an async iterable, the
// same shape Bun.spawn's stdout has.
async function collect(chunks) {
  const enc = new TextEncoder();
  const stream = (function* gen() {
    for (const c of chunks) {
      yield enc.encode(c);
    }
  })();
  const lines = [];
  await pumpLines(stream, (l) => lines.push(l));
  return lines;
}

const failures = [];
async function check(what, fn) {
  try {
    await fn();
    console.log(`  ok   ${what}`);
  } catch (e) {
    failures.push(what);
    console.log(`  FAIL ${what}\n       ${e.message}`);
  }
}

console.log('pumpLines');

await check('splits on newlines', async () => {
  assert.deepEqual(await collect(['a\nb\nc\n']), ['a', 'b', 'c']);
});

// The bug this file exists to catch: a JSON line arriving in two reads must be
// delivered once, whole. Getting this wrong corrupts stream-json parsing in a
// way that looks like the agent misbehaving.
await check('reassembles a line split across chunks', async () => {
  assert.deepEqual(await collect(['{"ty', 'pe":"result"}\n']), [
    '{"type":"result"}',
  ]);
});

await check('handles a line spanning three chunks', async () => {
  assert.deepEqual(await collect(['aa', 'bb', 'cc\n']), ['aabbcc']);
});

await check('emits a trailing line with no newline', async () => {
  assert.deepEqual(await collect(['done\npartial']), ['done', 'partial']);
});

await check('does not emit for an empty stream', async () => {
  assert.deepEqual(await collect([]), []);
});

await check('preserves empty lines between content', async () => {
  assert.deepEqual(await collect(['a\n\nb\n']), ['a', '', 'b']);
});

// A chunk boundary landing mid-UTF-8 must not produce a replacement char —
// TextDecoder({stream:true}) holds the partial sequence until it completes.
await check('survives a multi-byte char split across chunks', async () => {
  const bytes = new TextEncoder().encode('café\n');
  const stream = (function* gen() {
    yield bytes.slice(0, 4); // splits the é
    yield bytes.slice(4);
  })();
  const got = [];
  await pumpLines(stream, (l) => got.push(l));
  assert.deepEqual(got, ['café']);
});

console.log('boundedTail');

await check('keeps everything under the limit', () => {
  const t = boundedTail(1000);
  t.push('hello');
  t.push('world');
  assert.equal(t.toString(), 'helloworld');
});

await check('drops from the head, keeps the tail', () => {
  const t = boundedTail(10);
  t.push('aaaaa');
  t.push('bbbbb');
  t.push('ccccc');
  const s = t.toString();
  assert.ok(s.endsWith('ccccc'), `tail lost: ${s}`);
  assert.ok(!s.includes('aaaaa'), `head not dropped: ${s}`);
});

await check('never drops the only entry, even oversized', () => {
  const t = boundedTail(4);
  t.push('a-very-long-single-write');
  assert.equal(t.toString(), 'a-very-long-single-write');
});

await check('counts bytes, not characters', () => {
  const t = boundedTail(8);
  t.push('ααα'); // 6 bytes
  t.push('βββ'); // 6 bytes -> 12 > 8, head must go
  assert.equal(t.toString(), 'βββ');
});

console.log('resolveCredential');

await check('rejects an unknown agent', () => {
  assert.match(resolveCredential('nope').error, UNKNOWN_AGENT);
});

// Cursor/antigravity are excluded on purpose; the error has to say why, or the
// omission reads as a bug rather than a boundary.
await check(
  'explains interactive-only agents instead of failing blankly',
  () => {
    for (const id of Object.keys(INTERACTIVE_ONLY)) {
      const { error } = resolveCredential(id);
      assert.ok(error?.includes('interactive-only'), `${id}: ${error}`);
    }
  }
);

await check('env-kind reports the mint command when unset', () => {
  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
  const { error } = resolveCredential('claude');
  assert.match(error, MINT_CMD);
  if (prev === undefined) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
  }
});

await check('env-kind passes the token through with no mounts', () => {
  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-test';
  const got = resolveCredential('claude');
  assert.equal(got.env.CLAUDE_CODE_OAUTH_TOKEN, 'tok-test');
  assert.deepEqual(got.mounts, []);
  if (prev === undefined) {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
  }
});

// A writable credential mount would let a compromised run swap the token back
// onto the host. Every file-kind mount must be read-only.
await check('file-kind mounts are always read-only', () => {
  for (const [id, a] of Object.entries(AGENT_ADAPTERS)) {
    if (a.credential.kind !== 'file') {
      continue;
    }
    const got = resolveCredential(id);
    if (got.error) {
      continue; // not signed in on this machine; nothing to assert
    }
    assert.ok(
      got.mounts.every((m) => m.readonly === true),
      `${id} mounted writable`
    );
  }
});

console.log('applyBudgetGuard');

await check(
  'runAgent rejects an invalid budget before loading a provider',
  async () => {
    await assert.rejects(
      runAgent({ agentId: 'claude', maxBudgetUsd: Number.NaN }),
      /finite positive/
    );
  }
);

// The exact suffix claudeCode's buildPrintCommand produces today (verified
// live against @ai-hero/sandcastle's actual output, not the .d.ts alone):
// prompt travels via stdin, never argv, and the command always ends in the
// `-p -` sentinel. Asserted here so a future sandcastle bump that changes
// this shape fails a test instead of silently degrading the guard.
const PRINT_OPTS = { dangerouslySkipPermissions: true, prompt: 'hi' };
const BUDGET_2_RE = /--max-budget-usd 2\b/;
const BUDGET_5_RE = /--max-budget-usd 5\b/;
const TRAILING_SENTINEL_RE = / -p -$/;
const RESUME_FORK_BUDGET_RE =
  /--resume 'abc-123' --fork-session --max-budget-usd 2 -p -$/;
const DID_NOT_LAND_RE = /did not land/;
const fixtureProvider = (command = 'claude --print -p -') => ({
  buildPrintCommand: (opts) => ({
    command:
      opts.forkSession && opts.resumeSession
        ? "claude --print --resume 'abc-123' --fork-session -p -"
        : command,
  }),
  captureSessions: true,
  name: 'fixture',
  parseStreamLine: () => {},
  sessionStorage: {},
});

await check('claude: flag lands and the -p - sentinel survives', () => {
  const { guarded, provider } = applyBudgetGuard(
    'claude',
    fixtureProvider(),
    DEFAULT_MAX_BUDGET_USD
  );
  assert.equal(guarded, true);
  const { command } = provider.buildPrintCommand(PRINT_OPTS);
  assert.match(command, BUDGET_2_RE);
  assert.match(
    command,
    TRAILING_SENTINEL_RE,
    `flag spliced after the sentinel: ${command}`
  );
});

await check('claude: budget is overridable per run', () => {
  const { provider } = applyBudgetGuard('claude', fixtureProvider(), 5);
  const { command } = provider.buildPrintCommand(PRINT_OPTS);
  assert.match(command, BUDGET_5_RE);
});

// The resume/fork path renders --resume/--fork-session before the sentinel;
// the budget flag must still land after them and before -p -, not between.
await check('claude: flag lands on the resume+fork path too', () => {
  const { provider } = applyBudgetGuard(
    'claude',
    fixtureProvider(),
    DEFAULT_MAX_BUDGET_USD
  );
  const { command } = provider.buildPrintCommand({
    ...PRINT_OPTS,
    forkSession: true,
    resumeSession: 'abc-123',
  });
  assert.match(command, RESUME_FORK_BUDGET_RE);
});

// Wrapping must not drop what run() calls on the provider elsewhere --
// parseStreamLine runs per output line, and sessionStorage/captureSessions
// drive resume support. A naive rebuild (rather than a spread) would lose
// these silently.
await check('claude: wrapping preserves the rest of the provider', () => {
  const raw = fixtureProvider();
  const { provider } = applyBudgetGuard('claude', raw, DEFAULT_MAX_BUDGET_USD);
  assert.equal(provider.name, raw.name);
  assert.equal(provider.captureSessions, raw.captureSessions);
  assert.equal(provider.sessionStorage, raw.sessionStorage);
  assert.equal(typeof provider.parseStreamLine, 'function');
});

// codex and opencode have no budget flag or env var (checked `codex exec
// --help` / `opencode run --help` directly -- neither lists one). Degrading
// safely means the run still happens: the provider passes through
// untouched (same reference, not a rebuilt lookalike) and `guarded` tells
// the caller honestly that nothing is capping this run. Written as two
// explicit checks rather than a loop -- matches this file's style and
// keeps each assertion's own agent id in the failure output.
await check('codex: unguarded and passed through unmodified', () => {
  const raw = fixtureProvider('codex exec');
  const { guarded, provider } = applyBudgetGuard(
    'codex',
    raw,
    DEFAULT_MAX_BUDGET_USD
  );
  assert.equal(guarded, false);
  assert.equal(provider, raw);
});

await check('opencode: unguarded and passed through unmodified', () => {
  const raw = fixtureProvider('opencode run');
  const { guarded, provider } = applyBudgetGuard(
    'opencode',
    raw,
    DEFAULT_MAX_BUDGET_USD
  );
  assert.equal(guarded, false);
  assert.equal(provider, raw);
});

await check('unknown agent id: reports unguarded, does not throw', () => {
  const stub = {};
  const { guarded, provider } = applyBudgetGuard(
    'nope',
    stub,
    DEFAULT_MAX_BUDGET_USD
  );
  assert.equal(guarded, false);
  assert.equal(provider, stub);
});

// The splice targets a string shape sandcastle owns, not a documented
// contract. If a future version stops ending the command in ` -p -`, the
// regex would silently no-op and hand back an uncapped command still
// labeled `guarded: true` -- worse than the regression this file fixes.
// The wrapper must refuse instead of lying.
await check(
  'claude: refuses to report guarded if the flag fails to land',
  () => {
    const brokenProvider = {
      buildPrintCommand: () => ({ command: 'claude --print --model x' }),
    };
    const { provider } = applyBudgetGuard(
      'claude',
      brokenProvider,
      DEFAULT_MAX_BUDGET_USD
    );
    assert.throws(
      () => provider.buildPrintCommand(PRINT_OPTS),
      DID_NOT_LAND_RE
    );
  }
);

console.log('run state');

await check('no status before a run starts', () => {
  assert.equal(agentStatus('repo', 'never-run'), null);
});

await check('start seeds a running record', () => {
  agentRunStart('r', 'wt1', { agentId: 'claude', maxIterations: 5 });
  const st = agentStatus('r', 'wt1');
  assert.equal(st.phase, 'running');
  assert.equal(st.agentId, 'claude');
  assert.equal(st.iteration, 1);
  assert.equal(st.tool, null);
});

// budgetGuarded defaults to null (not false) when omitted -- runAgent always
// supplies the real applyBudgetGuard result, so null only ever shows up for
// a caller that bypassed that resolution, and should read as "unresolved"
// rather than a false claim of "unguarded".
await check('budgetGuarded defaults to null when omitted', () => {
  agentRunStart('r', 'wt-budget-default', {
    agentId: 'claude',
    maxIterations: 1,
  });
  assert.equal(agentStatus('r', 'wt-budget-default').budgetGuarded, null);
});

await check('budgetGuarded is carried through when supplied', () => {
  agentRunStart('r', 'wt-budget-true', {
    agentId: 'claude',
    budgetGuarded: true,
    maxIterations: 1,
  });
  assert.equal(agentStatus('r', 'wt-budget-true').budgetGuarded, true);

  agentRunStart('r', 'wt-budget-false', {
    agentId: 'codex',
    budgetGuarded: false,
    maxIterations: 1,
  });
  assert.equal(agentStatus('r', 'wt-budget-false').budgetGuarded, false);
});

// The chip's whole job: show which iteration and which tool, live.
await check('stream events advance iteration and tool', () => {
  const onEvent = agentRunStart('r', 'wt2', {
    agentId: 'codex',
    maxIterations: 3,
  });
  onEvent({ iteration: 2, message: 'hi', timestamp: new Date(), type: 'text' });
  assert.equal(agentStatus('r', 'wt2').iteration, 2);
  onEvent({
    formattedArgs: 'bun test',
    iteration: 2,
    name: 'Bash',
    timestamp: new Date(),
    type: 'toolCall',
  });
  assert.equal(agentStatus('r', 'wt2').tool, 'Bash');
});

// A text event after a toolCall must NOT clear the tool -- the agent is still
// working on that tool's result, and a blanking chip reads as "idle".
await check('text after a tool call keeps the tool shown', () => {
  const onEvent = agentRunStart('r', 'wt3', {
    agentId: 'claude',
    maxIterations: 1,
  });
  onEvent({
    formattedArgs: 'x',
    iteration: 1,
    name: 'Read',
    timestamp: new Date(),
    type: 'toolCall',
  });
  onEvent({
    iteration: 1,
    message: 'thinking',
    timestamp: new Date(),
    type: 'text',
  });
  assert.equal(agentStatus('r', 'wt3').tool, 'Read');
});

await check('finish marks done and clears the tool', () => {
  agentRunStart('r', 'wt4', { agentId: 'claude', maxIterations: 1 });
  agentRunFinish('r', 'wt4');
  const st = agentStatus('r', 'wt4');
  assert.equal(st.phase, 'done');
  assert.equal(st.tool, null);
  assert.equal(st.error, null);
});

// A failed run must stay visible as failed. A vanished chip reads as "nothing
// happened" when something did.
await check('failure is retained, not erased', () => {
  agentRunStart('r', 'wt5', { agentId: 'claude', maxIterations: 1 });
  agentRunFinish('r', 'wt5', { error: 'boom' });
  const st = agentStatus('r', 'wt5');
  assert.equal(st.phase, 'failed');
  assert.equal(st.error, 'boom');
});

await check('events for an unknown run are ignored, not thrown', () => {
  const onEvent = agentRunStart('r', 'wt6', {
    agentId: 'claude',
    maxIterations: 1,
  });
  agentRunFinish('r', 'wt6');
  onEvent({
    iteration: 9,
    message: 'late',
    timestamp: new Date(),
    type: 'text',
  });
  assert.equal(agentStatus('r', 'wt6').iteration, 9);
});

console.log(
  failures.length
    ? `\n${failures.length} failed: ${failures.join(', ')}`
    : '\nall passed'
);
process.exit(failures.length ? 1 : 0);
