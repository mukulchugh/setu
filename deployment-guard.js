import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const issue = (code, error) => Object.assign(new Error(error), { code });
const failure = (error) => ({
  code: error.code ?? 'DEPLOY_PREFLIGHT_FAILED',
  error: error.message ?? String(error),
  ok: false,
});
function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}
const same = (left, right) =>
  JSON.stringify(stable(left)) === JSON.stringify(stable(right));

// Inspect installed files only. Preflight must never download or run a CLI.
export async function installedDeployTool(
  provider,
  checkout = {},
  { which = Bun.which } = {}
) {
  if (!['vercel', 'netlify', 'convex'].includes(provider)) {
    return null;
  }
  const candidates = [];
  if (checkout.wtDir) {
    let directory = resolve(checkout.wtDir);
    const root = resolve(checkout.checkoutRoot ?? checkout.wtDir);
    while (true) {
      candidates.push(join(directory, 'node_modules', '.bin', provider));
      const parent = dirname(directory);
      if (directory === root || parent === directory) {
        break;
      }
      directory = parent;
    }
  }
  const global = which(provider);
  if (global) {
    candidates.push(global);
  }
  const packageName = provider === 'netlify' ? 'netlify-cli' : provider;
  for (const candidate of candidates) {
    let executable;
    try {
      executable = await realpath(candidate);
      await access(executable, constants.X_OK);
    } catch {
      continue;
    }
    let directory = dirname(executable);
    for (let depth = 0; depth < 10; depth += 1) {
      try {
        const pkg = JSON.parse(
          await readFile(join(directory, 'package.json'), 'utf8')
        );
        if (
          pkg.name === packageName &&
          typeof pkg.version === 'string' &&
          pkg.version
        ) {
          return { executable, version: pkg.version };
        }
      } catch {
        // A package may be above its bin directory.
      }
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }
  return null;
}

async function checkoutRevision(checkout) {
  try {
    const run = (args) =>
      Bun.spawn(args, {
        cwd: checkout.wtDir,
        stderr: 'ignore',
        stdout: 'pipe',
      });
    const headProcess = run(['git', 'rev-parse', '--verify', 'HEAD']);
    const dirtyProcess = run(['git', 'status', '--porcelain']);
    const [headCode, dirtyCode, head, dirty] = await Promise.all([
      headProcess.exited,
      dirtyProcess.exited,
      new Response(headProcess.stdout).text(),
      new Response(dirtyProcess.stdout).text(),
    ]);
    const value = head.trim();
    return headCode === 0 && dirtyCode === 0 && /^[0-9a-f]{40,64}$/.test(value)
      ? { dirty: dirty.length > 0, head: value, known: true }
      : { known: false };
  } catch {
    return { known: false };
  }
}

async function boundedOutput(stream) {
  if (!stream) {
    return '';
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      text = (text + decoder.decode(value, { stream: true })).slice(
        -1024 * 1024
      );
    }
    return (text + decoder.decode()).trim();
  } finally {
    reader.releaseLock();
  }
}

export function createDeploymentLauncher({
  env = process.env,
  stores,
  now,
  spawn,
  openLog,
  closeLog,
  appendLog,
  tailError,
  onCompletion,
}) {
  return function launch(request, binding) {
    const { provider, repo, name, target } = request,
      key = `${repo}/${name}`,
      store = stores[provider];
    if (!(binding?.command && store)) {
      throw issue(
        'DEPLOY_TARGET_UNVERIFIED',
        'Deployment has no verified command binding'
      );
    }
    if (store.get(key)?.deploying) {
      return failure(
        issue(
          'WORKTREE_BUSY',
          'A deployment is already running for this worktree'
        )
      );
    }
    const entry = {
      deploying: true,
      error: null,
      startedAt: now(),
      target,
      url: null,
      ...(provider === 'convex' ? { ok: false } : {}),
    };
    const fd = provider === 'convex' ? null : openLog(repo, name, provider);
    let proc,
      closeFailed = false;
    store.set(key, entry);
    try {
      proc = spawn(binding.command, {
        cwd: binding.cwd,
        ...(binding.env ? { env: { ...env, ...binding.env } } : {}),
        stderr: fd ?? 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
        timeout: 15 * 60 * 1000,
      });
    } catch {
      store.set(key, {
        ...entry,
        deploying: false,
        error: 'Deployment command could not start',
      });
      throw issue(
        'DEPLOY_START_FAILED',
        'Deployment command could not start; check the installed CLI'
      );
    } finally {
      if (fd !== null) {
        try {
          closeLog(fd);
        } catch {
          closeFailed = true;
        }
      }
    }
    const completion = (async () => {
      const unknown = () => {
        if (store.get(key) === entry) {
          store.set(key, {
            ...entry,
            error:
              'Deployment completion is unconfirmed; inspect provider status before retrying',
            phase: 'unknown',
          });
        }
        return issue(
          'OPERATION_UNKNOWN',
          'Deployment completion is unconfirmed; the worktree remains reserved for reconciliation'
        );
      };
      const exited = Promise.resolve()
        .then(() => proc.exited)
        .then(
          (code) => {
            if (!Number.isInteger(code) || code < 0 || proc.signalCode) {
              throw unknown();
            }
            return { status: 'fulfilled', value: code };
          },
          () => {
            throw unknown();
          }
        );
      const output = (stream) =>
        boundedOutput(stream).then(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ reason, status: 'rejected' })
        );
      // Output failure alone cannot release an active child. Unknown exit, however,
      // must retain ownership promptly even when the child's pipe never closes.
      const outputs = await Promise.all([
        output(proc.stdout),
        output(provider === 'convex' ? proc.stderr : null),
        exited,
      ]);
      const code = outputs[2].value,
        out = outputs[0].status === 'fulfilled' ? outputs[0].value : '',
        err = outputs[1].status === 'fulfilled' ? outputs[1].value : '';
      let url = null,
        error = null,
        ok = false;
      if (outputs.slice(0, 2).some((result) => result.status === 'rejected')) {
        error =
          'Deployment finished but its output could not be read; inspect provider status';
      } else if (provider === 'convex') {
        ok = code === 0;
        if (!ok) {
          error =
            `${out}\n${err}`.trim().split('\n').at(-1) ||
            `convex deploy exited ${code}`;
        }
      } else if (provider === 'netlify') {
        let data;
        try {
          data = JSON.parse(out);
        } catch {
          try {
            data = JSON.parse(out.slice(out.lastIndexOf('{')));
          } catch {
            // The result validation below reports an unreadable deployment result.
          }
        }
        if (code === 0 && data && data.site_id !== binding.linkedSiteId) {
          error =
            'Netlify deployed to a different site than the confirmed link; inspect provider state before retrying';
        } else if (
          code === 0 &&
          data?.site_id === binding.linkedSiteId &&
          (data.url || data.deploy_url)
        ) {
          url = data.url || data.deploy_url;
          ok = true;
        } else {
          error =
            code === 0
              ? 'Could not confirm the Netlify deployment result; inspect provider status'
              : tailError(repo, name, provider) || `netlify exited ${code}`;
        }
      } else if (code === 0 && out) {
        url = out;
        ok = true;
      } else {
        error = tailError(repo, name, provider) || `vercel exited ${code}`;
      }
      try {
        appendLog(
          repo,
          name,
          provider,
          provider === 'convex'
            ? `\n[deploy ${target}]\n${out}\n${err}\n`
            : `\n${ok ? url : `[deploy failed] ${error}`}\n`
        );
      } catch {
        error =
          'Deployment finished but its log could not be saved; inspect provider status';
        ok = false;
      }
      if (closeFailed) {
        error =
          'Deployment finished but its log descriptor could not be closed';
        ok = false;
      }
      if (store.get(key) === entry) {
        store.set(key, {
          ...entry,
          deploying: false,
          error,
          url: ok ? url : null,
          ...(provider === 'convex' ? { ok } : {}),
        });
      }
      return {
        ok,
        ...(error ? { code: 'DEPLOY_FAILED', error } : {}),
        ...(url && ok ? { url } : {}),
      };
    })().catch((error) => {
      if (error.code !== 'OPERATION_UNKNOWN' && store.get(key) === entry) {
        store.set(key, {
          ...entry,
          deploying: false,
          error:
            'Deployment exited but its result could not be recorded; inspect provider status',
        });
      }
      throw error;
    });
    onCompletion?.({ completion, request });
    return { completion, result: { deploying: true, ok: true, target } };
  };
}

export function createProviderResolver({
  readJson,
  tool,
  run,
  convexDeployKey = () => null,
}) {
  return async function resolveProvider(request, checkout) {
    const { provider, target } = request;
    if (provider === 'netlify') {
      const installed = await tool(provider, checkout);
      if (!installed?.executable) {
        throw issue(
          'DEPLOY_TARGET_UNVERIFIED',
          'Install and authenticate the Netlify CLI before preview deployment.'
        );
      }
      let link;
      try {
        link = await readJson(`${checkout.wtDir}/.netlify/state.json`);
      } catch {
        // Missing or unreadable linkage is rejected by the same authority check.
      }
      if (
        typeof link?.siteId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]+$/.test(link.siteId)
      ) {
        throw issue(
          'DEPLOY_LINK_REQUIRED',
          'This checkout needs a Netlify site link before preview deployment.'
        );
      }
      const production = target === 'production';
      return {
        binding: {
          executable: installed.executable,
          version: installed.version,
        },
        destination: {
          environment: production
            ? 'production'
            : target === 'preview'
              ? 'preview'
              : 'custom',
          id: link.siteId,
          label: production
            ? `${link.siteId} production`
            : target === 'preview'
              ? link.siteId
              : `${link.siteId} alias ${target}`,
        },
        launch: {
          command: [
            installed.executable,
            'deploy',
            '--json',
            '--site',
            link.siteId,
            ...(production
              ? ['--prod']
              : target === 'preview'
                ? []
                : ['--alias', target]),
          ],
          cwd: checkout.wtDir,
          linkedSiteId: link.siteId,
        },
      };
    }
    if (provider === 'convex') {
      const installed = await tool(provider, checkout);
      const key = await convexDeployKey(checkout);
      const value = typeof key?.value === 'string' ? key.value : null;
      const prod = value?.match(/^prod:([a-z0-9-]+)\|.+$/);
      const preview = value?.match(/^preview:([a-z0-9-]+):([a-z0-9-]+)\|.+$/);
      if (!(installed?.executable && (prod || preview))) {
        throw issue(
          'DEPLOY_TARGET_UNVERIFIED',
          'Convex requires a supported production or preview deploy key with a verified target identity. No deployment was started.'
        );
      }
      if (target === 'production' && !prod) {
        throw issue(
          'DEPLOY_TARGET_UNVERIFIED',
          'A Convex production target requires a production deploy key.'
        );
      }
      if (target !== 'production' && !preview) {
        throw issue(
          'DEPLOY_TARGET_UNVERIFIED',
          'A Convex custom target requires a preview deploy key and an explicit preview name.'
        );
      }
      if (target === 'preview') {
        throw issue(
          'DEPLOY_TARGET_UNVERIFIED',
          'Select an explicit custom preview name; inferred preview targets are not allowed.'
        );
      }
      const destination = prod
        ? { environment: 'production', id: prod[1], label: prod[1] }
        : {
            environment: 'custom',
            id: `${preview[1]}/${preview[2]}/${target}`,
            label: `${preview[1]}/${preview[2]} ${target}`,
          };
      return {
        binding: {
          executable: installed.executable,
          version: installed.version,
        },
        destination,
        launch: {
          command: [
            installed.executable,
            'deploy',
            ...(preview ? ['--preview-name', target] : []),
          ],
          cwd: checkout.wtDir,
          env: { CONVEX_DEPLOY_KEY: value },
        },
      };
    }
    if (provider !== 'vercel') {
      throw issue(
        'DEPLOY_TARGET_UNVERIFIED',
        provider === 'netlify'
          ? 'Netlify destination binding is not verified.'
          : 'Convex deployment is refused: this machine has no source-verified Convex CLI target binding or deployment-key identity. No deployment was started.'
      );
    }
    if (!['preview', 'production'].includes(target)) {
      throw issue(
        'DEPLOY_TARGET_UNVERIFIED',
        'Custom Vercel environments are not authoritatively resolved yet. Select explicit preview or production.'
      );
    }
    const installed = await tool(provider, checkout);
    if (installed?.version !== '58.9.1' || !installed.executable) {
      throw issue(
        'DEPLOY_TARGET_UNVERIFIED',
        'This Vercel CLI version has not been verified for exact destination binding. Use the reviewed 58.9.1 adapter or update its verification before deploying.'
      );
    }
    let link;
    try {
      link = await readJson(`${checkout.wtDir}/.vercel/project.json`);
    } catch {
      throw issue(
        'DEPLOY_LINK_REQUIRED',
        'This checkout needs a readable Vercel project link. Run vercel link yourself, then refresh preflight.'
      );
    }
    if (
      !(
        /^prj_[a-zA-Z0-9]+$/.test(link?.projectId) &&
        /^team_[a-zA-Z0-9]+$/.test(link?.orgId)
      )
    ) {
      throw issue(
        'DEPLOY_LINK_REQUIRED',
        'A Vercel project ID and team owner ID are required for exact binding. Refresh the checkout link before deploying.'
      );
    }
    let remote;
    try {
      const response = await run(
        [
          installed.executable,
          'api',
          `/v9/projects/${encodeURIComponent(link.projectId)}?teamId=${encodeURIComponent(link.orgId)}`,
          '--method',
          'GET',
          '--raw',
          '--scope',
          link.orgId,
        ],
        { cwd: checkout.wtDir, timeout: 15_000 }
      );
      if (response.code !== 0 || response.timedOut || response.truncated) {
        throw new Error('Unavailable');
      }
      remote = JSON.parse(response.stdout);
    } catch (error) {
      if (error.code === 'OPERATION_UNKNOWN') {
        throw error;
      }
      throw issue(
        'DEPLOY_TARGET_UNVERIFIED',
        'Vercel could not confirm the linked project and owner. Check CLI authentication and access, then refresh preflight.'
      );
    }
    if (
      remote?.id !== link.projectId ||
      remote?.accountId !== link.orgId ||
      typeof remote.name !== 'string' ||
      !remote.name.trim()
    ) {
      throw issue(
        'DEPLOY_TARGET_UNVERIFIED',
        'Vercel returned a different or incomplete project identity; no deployment was started.'
      );
    }
    return {
      binding: { executable: installed.executable, version: installed.version },
      destination: {
        environment: target,
        id: remote.id,
        label: remote.name,
        orgId: remote.accountId,
        projectId: remote.id,
      },
      launch: {
        command: [
          installed.executable,
          'deploy',
          '--yes',
          `--target=${target}`,
          '--project',
          remote.id,
          '--scope',
          remote.accountId,
        ],
        cwd: checkout.wtDir,
      },
    };
  };
}

export function createDeploymentGuard({
  target,
  identity,
  branch,
  operation,
  deploymentState,
  resolveProvider,
  startOperation,
  launch,
  revision = checkoutRevision,
  validate = () => Promise.resolve(),
}) {
  async function resolve(request, admitted = false) {
    if (
      !['vercel', 'netlify', 'convex'].includes(request.provider) ||
      typeof request.target !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(request.target)
    ) {
      throw issue(
        'INVALID_DEPLOY_TARGET',
        'Select a supported provider and explicit deployment target'
      );
    }
    const checkout = target(request.repo, request.name);
    await validate(checkout);
    if (
      !admitted &&
      ['running', 'unknown'].includes(operation(checkout)?.phase)
    ) {
      throw issue(
        'WORKTREE_BUSY',
        'A known operation is using this worktree; wait for it to finish'
      );
    }
    const before = await identity(checkout);
    if (!before?.known) {
      throw issue(
        'DEPLOY_IDENTITY_UNKNOWN',
        'Checkout identity is unavailable; resolve its registration before deployment'
      );
    }
    const actualBranch = await branch(checkout);
    if (!actualBranch) {
      throw issue(
        'DEPLOY_BRANCH_UNKNOWN',
        'The actual Git branch is unavailable; select a branch before deployment'
      );
    }
    const beforeRevision = await revision(checkout);
    if (!beforeRevision?.known) {
      throw issue(
        'DEPLOY_REVISION_UNKNOWN',
        'The checkout commit or dirty state is unavailable; refresh preflight before deployment'
      );
    }
    const resolved = await resolveProvider(request, checkout);
    if (
      !(
        resolved?.destination?.id &&
        resolved.destination.label &&
        ['preview', 'production', 'custom'].includes(
          resolved.destination.environment
        )
      )
    ) {
      throw issue(
        'DEPLOY_TARGET_UNVERIFIED',
        'The provider could not establish an exact deployment destination'
      );
    }
    if (
      !same(before, await identity(checkout)) ||
      actualBranch !== (await branch(checkout)) ||
      !same(beforeRevision, await revision(checkout))
    ) {
      throw issue(
        'DEPLOY_CONTEXT_CHANGED',
        'The checkout changed during preflight; review the deployment target again'
      );
    }
    if (
      !admitted &&
      ['running', 'unknown'].includes(operation(checkout)?.phase)
    ) {
      throw issue(
        'WORKTREE_BUSY',
        'A known operation began during preflight; wait for it to finish'
      );
    }
    const expectedContext = {
      branch: actualBranch,
      deploymentState: {
        binding: resolved.binding ?? null,
        known: deploymentState(checkout),
      },
      destination: resolved.destination,
      identity: before,
      name: request.name,
      provider: request.provider,
      repo: request.repo,
      revision: beforeRevision,
      target: request.target,
    };
    return {
      checkout,
      expectedContext,
      launch: resolved.launch,
      requiresConfirmation: resolved.destination.environment === 'production',
    };
  }
  async function preflight(request) {
    try {
      const { expectedContext, requiresConfirmation } = await resolve(request);
      return { expectedContext, ok: true, requiresConfirmation };
    } catch (error) {
      return failure(error);
    }
  }
  async function dispatch(request) {
    try {
      const checkout = target(request.repo, request.name);
      return await startOperation(checkout, async () => {
        const current = await resolve(request, true);
        if (current.requiresConfirmation && !request.expectedContext) {
          return failure(
            issue(
              'DEPLOY_PREFLIGHT_REQUIRED',
              'Production deployment requires a fresh target preflight and explicit confirmation'
            )
          );
        }
        if (
          request.expectedContext &&
          !same(request.expectedContext, current.expectedContext)
        ) {
          return failure(
            issue(
              'DEPLOY_CONTEXT_CHANGED',
              'The deployment context changed; refresh preflight and confirm the new destination'
            )
          );
        }
        return launch(request, current.launch);
      });
    } catch (error) {
      return failure(error);
    }
  }
  return Object.freeze({ dispatch, preflight });
}
