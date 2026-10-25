#!/usr/bin/env bun
// Deterministic stand-in for a provider CLI. It exists only for Setu's local
// process tests: it writes provider-shaped stream-json lines and does a small,
// visible piece of work in its working directory. Running it proves how Setu
// supervises a child process. It is not provider acceptance and says nothing
// about what a real provider does.

import { appendFileSync, writeFileSync } from 'node:fs';
import { observeProcessIdentity } from './process-observation.js';

const args = process.argv.slice(2);
// Process tests list every fixture they start so none can outlive its test.
if (process.env.SETU_FIXTURE_PIDFILE) {
  appendFileSync(process.env.SETU_FIXTURE_PIDFILE, `${process.pid}\n`);
  const proof = await observeProcessIdentity(process.pid);
  writeFileSync(
    `${process.env.SETU_FIXTURE_PIDFILE}.${process.pid}.identity.json`,
    JSON.stringify(proof),
    { mode: 0o600 }
  );
}
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
};

const prompt = await new Response(Bun.stdin.stream()).text();
let instructions = prompt;
try {
  const envelope = JSON.parse(prompt);
  if (
    envelope?.version === 1 &&
    typeof envelope.request?.instructions === 'string'
  ) {
    ({ instructions } = envelope.request);
  }
} catch {
  // Capability probes use ordinary text rather than a retained task envelope.
}
// A budget below a tenth of a cent is the capability probe, like the real one.
// A subscription probe sets no budget; its prompt is the same short reply.
const probing = Number(flag('--max-budget-usd') ?? '1') < 0.001;
const subscriptionProbe =
  !probing && instructions.startsWith('Reply with the single word ok');
let mode = /MODE:([a-z-]+)/.exec(instructions)?.[1] ?? 'success';
if (probing) {
  mode = 'probe';
} else if (subscriptionProbe) {
  mode = 'subscription-probe';
}
const session = process.env.SETU_FIXTURE_SESSION || crypto.randomUUID();
const cost = Number(process.env.SETU_FIXTURE_COST ?? '0.0125');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// When set, results also carry per-model costs, as a live result does.
const modelCost = process.env.SETU_FIXTURE_MODEL_COST;
const withModelUsage = (event) =>
  modelCost === undefined || probing || event.type !== 'result'
    ? event
    : {
        ...event,
        modelUsage: { 'fixture-model': { costUSD: Number(modelCost) } },
      };
const emit = (event) =>
  process.stdout.write(`${JSON.stringify(withModelUsage(event))}\n`);
// A pipe write is asynchronous: wait for it before exiting so nothing is lost.
const finish = async (code) => {
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(code);
};

emit({
  args,
  cwd: process.cwd(),
  // The live client reports no effort at init. SETU_FIXTURE_NO_EFFORT leaves it
  // out the same way, and SETU_FIXTURE_EFFORT reports a different one.
  ...(process.env.SETU_FIXTURE_NO_EFFORT
    ? { per_turn_effort_active: true }
    : { effort: process.env.SETU_FIXTURE_EFFORT || flag('--effort') }),
  model: process.env.SETU_FIXTURE_MODEL || flag('--model'),
  permissionMode: flag('--permission-mode'),
  prompt: prompt.slice(0, 500),
  session_id: session,
  stdin: prompt,
  subtype: 'init',
  // A worker that ran with a different toolset than it was started with.
  tools:
    mode === 'wrong-session'
      ? ['Read']
      : (flag('--tools')?.split(',') ?? ['Edit', 'Read', 'Write']),
  type: 'system',
});

if (mode === 'stubborn') {
  // Ignores a polite stop, like a worker busy with its own cleanup.
  process.on('SIGTERM', () => undefined);
}

// Every mode lives long enough for the supervisor to observe the process.
await sleep(Number(process.env.SETU_FIXTURE_DELAY_MS ?? '250'));

if (mode === 'graceful-stop') {
  // Finishes its work and reports success when asked to stop, then exits 0.
  process.on('SIGTERM', async () => {
    await Bun.write('fixture-output.txt', 'finished while stopping\n');
    emit({
      is_error: false,
      result: 'done',
      session_id: session,
      subtype: 'success',
      total_cost_usd: cost,
      type: 'result',
    });
    await finish(0);
  });
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}

if (mode === 'hang' || mode === 'stubborn') {
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}

if (mode === 'controlled-success') {
  const keepAlive = setInterval(() => undefined, 1000);
  await new Promise((resolve) => {
    process.once('SIGUSR2', resolve);
    writeFileSync(
      `${process.env.SETU_FIXTURE_PIDFILE}.${process.pid}.ready`,
      'ready\n'
    );
  });
  clearInterval(keepAlive);
}

if (mode === 'subscription-probe') {
  // One short answer with token counts, shaped like a live result. Its dollar
  // figure is an estimate on a subscription, not a charge.
  emit({
    is_error: false,
    modelUsage: {
      'claude-sonnet-5-5': {
        cacheCreationInputTokens: 2548,
        cacheReadInputTokens: 0,
        costUSD: 0.010_300_9,
        inputTokens: 3,
        outputTokens: 5,
      },
    },
    result: 'ok',
    session_id: session,
    subtype: 'success',
    total_cost_usd: 0.010_300_9,
    type: 'result',
  });
  await finish(0);
}

if (mode === 'probe' && process.env.SETU_FIXTURE_PROBE === 'uncapped') {
  // A provider that does not stop at its budget finishes normally.
  emit({
    is_error: false,
    result: 'ok',
    session_id: session,
    subtype: 'success',
    total_cost_usd: 0.000_12,
    type: 'result',
  });
  await finish(0);
}

if (mode === 'probe') {
  // A capped session stops after the response that passes its budget. Normally
  // this fixture stays under the cap; SETU_FIXTURE_PROBE=soft overshoots it by
  // roughly a hundred times, the shape a live Claude Code session recorded.
  emit({
    is_error: true,
    session_id: session,
    subtype: 'error_max_budget_usd',
    // Under the cap by default, exactly at it for `equal`, far over for `soft`.
    total_cost_usd:
      { equal: 0.0001, soft: 0.010_300_9 }[process.env.SETU_FIXTURE_PROBE] ??
      0.000_08,
    type: 'result',
  });
  await finish(1);
}

if (mode === 'secret') {
  process.stdout.write('deploy key sk-abcdefghijklmnopqrstuvwxyz0123 ok\n');
}

if (mode === 'chatty') {
  for (let index = 0; index < 400; index += 1) {
    process.stdout.write(`line ${index} ${'x'.repeat(200)}\n`);
  }
}

if (mode === 'claim-done') {
  emit({
    message: { content: [{ text: 'I am done.', type: 'text' }] },
    session_id: session,
    type: 'assistant',
  });
  await finish(0);
}

if (mode === 'fail') {
  emit({
    is_error: true,
    session_id: session,
    subtype: 'error_during_execution',
    total_cost_usd: cost,
    type: 'result',
  });
  await finish(1);
}

if (mode === 'nocost') {
  emit({
    is_error: false,
    result: 'done',
    session_id: session,
    subtype: 'success',
    type: 'result',
  });
  await finish(0);
}

if (mode === 'noop') {
  // Succeeds without changing anything, as a verification step legitimately can.
  emit({
    is_error: false,
    result: 'verified',
    session_id: session,
    subtype: 'success',
    total_cost_usd: cost,
    type: 'result',
  });
  await finish(0);
}

if (mode === 'commit') {
  // Moves HEAD without changing any file.
  Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=f@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'empty',
    ],
    { stderr: 'ignore', stdout: 'ignore' }
  );
  emit({
    is_error: false,
    result: 'committed',
    session_id: session,
    subtype: 'success',
    total_cost_usd: cost,
    type: 'result',
  });
  await finish(0);
}

if (
  mode === 'success' ||
  mode === 'secret' ||
  mode === 'chatty' ||
  mode === 'controlled-success' ||
  mode === 'wrong-session'
) {
  await Bun.write('fixture-output.txt', 'work done by the process fixture\n');
  emit({
    message: { content: [{ text: 'Wrote fixture-output.txt', type: 'text' }] },
    session_id: session,
    type: 'assistant',
  });
  emit({
    is_error: false,
    result: 'done',
    session_id: session,
    subtype: 'success',
    total_cost_usd: cost,
    type: 'result',
  });
  await finish(0);
}

await finish(2);
