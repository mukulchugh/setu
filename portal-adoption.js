import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const pending = (code, error, port) => ({
  code,
  error,
  ok: false,
  ...(port === null ? {} : { port }),
  recovery: 'Retry this adoption with the same repo, name, and checkout path.',
});

function validRecord(record, repo, name) {
  return (
    record &&
    record.repo === repo &&
    record.name === name &&
    record.identity?.known === true &&
    typeof record.identity.checkoutPath === 'string'
  );
}

export function createWorktreeAdoption({
  assignPort,
  inspectIdentity,
  isLinkedWorktree,
  isRegisteredProject,
  readRecords,
  registeredPort,
  validateTarget,
  withRecords,
  withTarget,
  writeRecords,
  writeRouting,
}) {
  async function verify(target, prior) {
    const identity = await inspectIdentity(
      target.repo,
      target.name,
      target.wtDir
    );
    if (!identity?.known) {
      return {
        result: {
          code: 'CHECKOUT_IDENTITY_UNKNOWN',
          error: 'Checkout identity could not be verified',
          ok: false,
        },
      };
    }
    if (prior && !isDeepStrictEqual(prior, identity)) {
      return {
        result: {
          code: 'ADOPTION_IDENTITY_CHANGED',
          error: 'Checkout identity changed; adoption recovery is blocked',
          ok: false,
        },
      };
    }
    if (!(await isLinkedWorktree(target.repo, identity.checkoutPath))) {
      return {
        result: {
          code: 'WORKTREE_NOT_LINKED',
          error: 'Checkout is not a linked worktree of the registered project',
          ok: false,
        },
      };
    }
    return { identity };
  }

  async function adoptLocked(target) {
    let records;
    try {
      records = await readRecords();
      if (!records || typeof records !== 'object' || Array.isArray(records)) {
        throw new Error('invalid adoption state');
      }
    } catch {
      return {
        code: 'ADOPTION_STATE_UNREADABLE',
        error: 'Adoption recovery state could not be read',
        ok: false,
      };
    }
    const key = `${target.repo}/${target.name}`;
    const existing = records[key];
    if (existing && !validRecord(existing, target.repo, target.name)) {
      return {
        code: 'ADOPTION_STATE_UNREADABLE',
        error: 'Adoption recovery state is invalid',
        ok: false,
      };
    }
    let port = registeredPort(target.repo, target.name);
    if (port !== null && !existing) {
      return {
        code: 'WORKTREE_ALREADY_REGISTERED',
        error: `Worktree ${target.repo}/${target.name} is already registered with Setu`,
        ok: false,
      };
    }

    const first = await verify(target, existing?.identity);
    if (first.result) {
      return first.result;
    }
    if (!existing) {
      records[key] = {
        identity: first.identity,
        name: target.name,
        repo: target.repo,
        version: 1,
      };
      await writeRecords(records);
    }

    // Registration publication is the point of no return. Observe again so a
    // replacement checkout cannot inherit a port intended for its predecessor.
    const beforeRegistration = await verify(target, records[key].identity);
    if (beforeRegistration.result) {
      return beforeRegistration.result;
    }
    if (port === null) {
      try {
        port = await assignPort(target.repo, target.name);
      } catch (error) {
        return pending(
          'ADOPTION_REGISTRATION_PENDING',
          error?.message ?? 'Worktree registration could not be completed',
          null
        );
      }
    }
    if (registeredPort(target.repo, target.name) !== port) {
      return pending(
        'ADOPTION_REGISTRATION_CHANGED',
        'Worktree registration changed before routing could be applied',
        port
      );
    }

    let routing;
    try {
      routing = await writeRouting(target.repo, target.name, port);
    } catch (error) {
      return pending(
        'ADOPTION_ROUTING_PENDING',
        error?.message ?? 'Worktree was registered but routing is pending',
        port
      );
    }
    if (!routing?.ok) {
      return pending(
        routing?.code ?? 'ADOPTION_ROUTING_PENDING',
        routing?.error ?? 'Worktree was registered but routing is pending',
        port
      );
    }
    delete records[key];
    await writeRecords(records);
    return {
      name: target.name,
      ok: true,
      path: beforeRegistration.identity.checkoutPath,
      port,
      repo: target.repo,
    };
  }

  return {
    async adopt({ name, path, repo }) {
      let target;
      try {
        target = validateTarget(repo, name, path);
      } catch {
        return {
          code: 'ADOPTION_TARGET_INVALID',
          error: 'Invalid worktree target',
          ok: false,
        };
      }
      if (
        typeof path !== 'string' ||
        !target?.wtDir ||
        resolve(path) !== resolve(target.wtDir)
      ) {
        return {
          code: 'ADOPTION_PATH_INVALID',
          error: 'Only the managed checkout path can be adopted',
          ok: false,
        };
      }
      if (!isRegisteredProject(repo)) {
        return {
          code: 'PROJECT_NOT_REGISTERED',
          error: `Project ${repo} is not registered with Setu`,
          ok: false,
        };
      }
      return withTarget(target, () => withRecords(() => adoptLocked(target)));
    },
  };
}
