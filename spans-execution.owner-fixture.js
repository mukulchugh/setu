#!/usr/bin/env bun
// Process-test helper: contends for the supervisor owner file of the archive in
// argv[2] at the wall-clock time argv[3], prints whether it won, and keeps the
// ownership until its parent closes its input. Used only by the owner test.
import { createExecutionOwner } from './spans-execution-owner.js';

const [root, startAt] = process.argv.slice(2);
const owner = createExecutionOwner({ root });
await new Promise((resolve) =>
  setTimeout(resolve, Math.max(0, Number(startAt) - Date.now()))
);
const result = await owner.acquire();
process.stdout.write(`${JSON.stringify({ ok: result.ok })}\n`);
await new Promise((resolve) => process.stdin.on('close', resolve).resume());
await owner.release();
