import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const pending = (code, error, port) => ({
  code,
  error,
  ok: false,
  ...(port === null ? {} : { port }),
  recovery: 'Retry this adoption with the same repo, name, and checkout path.',
});

function errorMessage(error, fallback) {
  return error?.message ?? fallback;
}

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

  async function adoptionState(target) {
    let records;
    try {
      records = await readRecords();
      if (!records || typeof records !== 'object' || Array.isArray(records)) {
        throw new Error('invalid adoption state');
      }
    } catch {
      return {
        result: {
          code: 'ADOPTION_STATE_UNREADABLE',
          error: 'Adoption recovery state could not be read',
          ok: false,
        },
      };
    }
    const key = `${target.repo}/${target.name}`;
    const existing = records[key];
    if (existing && !validRecord(existing, target.repo, target.name)) {
      return {
        result: {
          code: 'ADOPTION_STATE_UNREADABLE',
          error: 'Adoption recovery state is invalid',
          ok: false,
        },
      };
    }
    const port = registeredPort(target.repo, target.name);
    if (port !== null && !existing) {
      return {
        result: {
          code: 'WORKTREE_ALREADY_REGISTERED',
          error: `Worktree ${target.repo}/${target.name} is already registered with Setu`,
          ok: false,
        },
      };
    }
    return { existing, key, port, records };
  }

  async function register(target, state) {
    const first = await verify(target, state.existing?.identity);
    if (Object.hasOwn(first, 'result')) {
      return first;
    }
    if (!state.existing) {
      state.records[state.key] = {
        identity: first.identity,
        name: target.name,
        repo: target.repo,
        version: 1,
      };
      await writeRecords(state.records);
    }
    const verified = await verify(target, state.records[state.key].identity);
    if (Object.hasOwn(verified, 'result')) {
      return verified;
    }
    let { port } = state;
    if (port === null) {
      try {
        port = await assignPort(target.repo, target.name);
      } catch (error) {
        return {
          result: pending(
            'ADOPTION_REGISTRATION_PENDING',
            errorMessage(error, 'Worktree registration could not be completed'),
            null
          ),
        };
      }
    }
    return { identity: verified.identity, port };
  }

  async function adoptLocked(target) {
    const state = await adoptionState(target);
    if (Object.hasOwn(state, 'result')) {
      return state.result;
    }
    // Registration publication is the point of no return. Observe again so a
    // replacement checkout cannot inherit a port intended for its predecessor.
    const registered = await register(target, state);
    if (Object.hasOwn(registered, 'result')) {
      return registered.result;
    }

    if (registeredPort(target.repo, target.name) !== registered.port) {
      return pending(
        'ADOPTION_REGISTRATION_CHANGED',
        'Worktree registration changed before routing could be applied',
        registered.port
      );
    }

    let routing;
    try {
      routing = await writeRouting(target.repo, target.name, registered.port);
    } catch (error) {
      return pending(
        'ADOPTION_ROUTING_PENDING',
        errorMessage(error, 'Worktree was registered but routing is pending'),
        registered.port
      );
    }
    if (!routing?.ok) {
      return pending(
        routing?.code ?? 'ADOPTION_ROUTING_PENDING',
        routing?.error ?? 'Worktree was registered but routing is pending',
        registered.port
      );
    }
    delete state.records[state.key];
    await writeRecords(state.records);
    return {
      name: target.name,
      ok: true,
      path: registered.identity.checkoutPath,
      port: registered.port,
      repo: target.repo,
    };
  }

  return {
    // biome-ignore lint/suspicious/useAwait: Target validation can throw synchronously; adoption callers require a rejected Promise from this public boundary.
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
