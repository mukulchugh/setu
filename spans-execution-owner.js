import { link, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { observeProcessIdentity } from './process-observation.js';

// One supervisor owns an archive's workers. Two portals (or two services) over
// the same archive would each believe they own the same child processes, so
// the first one takes an owner file and the second refuses to supervise.
//
// A dead owner is never removed and replaced: that read-then-remove step lets
// two contenders delete each other's new file. Owners are numbered files
// (`execution.owner.<n>`). The highest number is the owner, and a number is
// never reused: the newest file is never deleted, not even on release. A
// release writes a "released" tombstone as the next number instead. A
// contender that finds the newest owner gone (dead, or released) creates number
// n+1 with an exclusive link, which exactly one contender can do, and an
// observer holding an old reading of n can only ever try n+1, which exists. A
// winner must still be the highest file right after creating its own, because
// a lower number can be free again once a successor pruned it; if it is not, it
// removes only its own file and does not own. Only numbers below a winner's own
// are ever pruned. A file whose owner cannot be identified is never overtaken,
// because guessing could double-supervise.

const OWNER_FILE = 'execution.owner';
const OWNER_NAME = /^execution\.owner\.([1-9][0-9]{0,8})$/;
const MAX_ROUNDS = 8;
// One owner per process and archive; the key names the process so a test can
// stand in for several processes.
const held = new Set();
let tempCounter = 0;

export function createExecutionOwner({
  observeProcess = observeProcessIdentity,
  pid = process.pid,
  root,
}) {
  const heldKey = `${join(root, OWNER_FILE)}\0${pid}`;
  let mine = null;
  let acquiring = null;

  const pathOf = (generation) => join(root, `${OWNER_FILE}.${generation}`);

  async function identity() {
    const observed = await observeProcess(pid);
    return observed?.state === 'alive' &&
      observed.processId === pid &&
      observed.processStartIdentity
      ? { pid, processStart: observed.processStartIdentity }
      : null;
  }

  async function ownerIsGone(content) {
    let recorded;
    try {
      recorded = JSON.parse(content);
    } catch {
      return false;
    }
    // A released tombstone names no running owner.
    if (recorded?.released === true) {
      return true;
    }
    if (!(Number.isSafeInteger(recorded?.pid) && recorded.pid > 0)) {
      return false;
    }
    const observed = await observeProcess(recorded.pid);
    if (observed?.state === 'absent') {
      return true;
    }
    // The pid may have been reused by a different process.
    return (
      observed?.state === 'alive' &&
      observed.processStartIdentity !== recorded.processStart
    );
  }

  // Owner files that exist, lowest first.
  async function generations() {
    const found = [];
    for (const name of await readdir(root)) {
      const match = OWNER_NAME.exec(name);
      if (match) {
        found.push(Number(match[1]));
      }
    }
    return found.sort((left, right) => left - right);
  }

  // Creates generation `generation` with its full content, or reports that
  // another contender holds that number. The content is written to a private
  // file first so a reader never sees a half-written owner.
  async function create(generation, self) {
    tempCounter += 1;
    const temporary = join(root, `${OWNER_FILE}.tmp-${pid}-${tempCounter}`);
    await writeFile(temporary, JSON.stringify(self), { mode: 0o600 });
    try {
      await link(temporary, pathOf(generation));
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        return false;
      }
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function pruneBelow(generation) {
    for (const lower of await generations()) {
      if (lower < generation) {
        // biome-ignore lint/performance/noAwaitInLoops: Few files, removed in order.
        await rm(pathOf(lower), { force: true });
      }
    }
  }

  // The newest owner file and whether its owner is gone: `gone` is true when
  // there is no file or its owner is provably dead, false when it may be alive,
  // and null when the file vanished while it was read.
  async function newest() {
    const all = await generations();
    const top = all.at(-1) ?? 0;
    if (all.length === 0) {
      return { gone: true, top };
    }
    try {
      return {
        gone: await ownerIsGone(await readFile(pathOf(top), 'utf8')),
        top,
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { gone: null, top };
      }
      throw error;
    }
  }

  // Whether `generation` is still the highest file after it was created.
  async function stillNewest(generation) {
    return (await generations()).at(-1) === generation;
  }

  async function contest(self) {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Each round depends on what the last one found.
      const { gone, top } = await newest();
      if (gone === false) {
        return null;
      }
      if (gone === true && (await create(top + 1, self))) {
        if (await stillNewest(top + 1)) {
          return top + 1;
        }
        // A stale reading let this number be created behind a newer owner.
        await rm(pathOf(top + 1), { force: true });
      }
    }
    return null;
  }

  async function take() {
    if (mine !== null) {
      return { ok: true };
    }
    if (held.has(heldKey)) {
      return { ok: false };
    }
    try {
      const self = await identity();
      const generation = self ? await contest(self) : null;
      if (generation === null) {
        return { ok: false };
      }
      mine = generation;
      held.add(heldKey);
      await pruneBelow(generation);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  // Concurrent callers share one attempt, so a service never contests itself.
  function acquire() {
    acquiring ??= take().finally(() => {
      acquiring = null;
    });
    return acquiring;
  }

  async function release() {
    if (mine === null) {
      return;
    }
    const generation = mine;
    mine = null;
    held.delete(heldKey);
    // The newest file stays, as a tombstone under the next number. If that
    // number exists, a successor already took over and there is nothing to do.
    if (await create(generation + 1, { pid, released: true })) {
      await pruneBelow(generation + 1);
    }
  }

  return Object.freeze({ acquire, release });
}
