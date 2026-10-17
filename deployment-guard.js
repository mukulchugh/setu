import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const issue = (code, error) => Object.assign(new Error(error), { code });
const checkoutHeadPattern = /^[0-9a-f]{40,64}$/;
const convexPreviewKeyPattern = /^preview:([a-z0-9-]+):([a-z0-9-]+)\|.+$/;
const convexProductionKeyPattern = /^prod:([a-z0-9-]+)\|.+$/;
const deploymentTargetPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const netlifySiteIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]+$/;
const vercelOrgIdPattern = /^team_[a-zA-Z0-9]+$/;
const vercelProjectIdPattern = /^prj_[a-zA-Z0-9]+$/;
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

function deployToolCandidates(provider, checkout, which) {
  const candidates = [];
  if (checkout.wtDir) {
    let directory = resolve(checkout.wtDir);
    const root = resolve(checkout.checkoutRoot ?? checkout.wtDir);
    for (;;) {
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
  return candidates;
}

async function packageVersionForExecutable(executable, packageName) {
  let directory = dirname(executable);
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      const pkg = JSON.parse(
        // biome-ignore lint/performance/noAwaitInLoops: Each package lookup advances exactly one parent directory toward the candidate owner.
        await readFile(join(directory, 'package.json'), 'utf8')
      );
      if (
        pkg.name === packageName &&
        typeof pkg.version === 'string' &&
        pkg.version
      ) {
        return pkg.version;
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
  return null;
}

// Inspect installed files only. Preflight must never download or run a CLI.
export async function installedDeployTool(
  provider,
  checkout = {},
  { which = Bun.which } = {}
) {
  if (!['vercel', 'netlify', 'convex'].includes(provider)) {
    return null;
  }
  const candidates = deployToolCandidates(provider, checkout, which);
  const packageName = provider === 'netlify' ? 'netlify-cli' : provider;
  for (const candidate of candidates) {
    let executable;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: The first verified candidate wins and later paths must not be probed first.
      executable = await realpath(candidate);
      await access(executable, constants.X_OK);
    } catch {
      continue;
    }
    const version = await packageVersionForExecutable(executable, packageName);
    if (version) {
      return { executable, version };
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
    return headCode === 0 && dirtyCode === 0 && checkoutHeadPattern.test(value)
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
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Stream chunks must be decoded in arrival order before the bounded tail is retained.
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

function confirmedExit(proc, unknown) {
  return Promise.resolve()
    .then(() => proc.exited)
    .then(
      (code) => {
        if (!Number.isInteger(code) || code < 0 || proc.signalCode) {
          throw unknown();
        }
        return code;
      },
      () => {
        throw unknown();
      }
    );
}

async function settledOutput(stream) {
  try {
    return { status: 'fulfilled', value: await boundedOutput(stream) };
  } catch (reason) {
    return { reason, status: 'rejected' };
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
  function unknownDeployment(store, key, entry) {
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
  }
  function netlifyOutput(out) {
    try {
      return JSON.parse(out);
    } catch {
      try {
        return JSON.parse(out.slice(out.lastIndexOf('{')));
      } catch {
        // Result validation reports an unreadable deployment result.
      }
    }
  }
  function convexOutcome(exitCode, out, err) {
    return exitCode === 0
      ? { error: null, ok: true, url: null }
      : {
          error:
            `${out}\n${err}`.trim().split('\n').at(-1) ||
            `convex deploy exited ${exitCode}`,
          ok: false,
          url: null,
        };
  }
  function netlifyOutcome(binding, exitCode, out, provider, repo, name) {
    const data = netlifyOutput(out);
    if (exitCode === 0 && data && data.site_id !== binding.linkedSiteId) {
      return {
        error:
          'Netlify deployed to a different site than the confirmed link; inspect provider state before retrying',
        ok: false,
        url: null,
      };
    }
    if (
      exitCode === 0 &&
      data?.site_id === binding.linkedSiteId &&
      (data.url || data.deploy_url)
    ) {
      return { error: null, ok: true, url: data.url || data.deploy_url };
    }
    return {
      error:
        exitCode === 0
          ? 'Could not confirm the Netlify deployment result; inspect provider status'
          : tailError(repo, name, provider) || `netlify exited ${exitCode}`,
      ok: false,
      url: null,
    };
  }
  function vercelOutcome(exitCode, out, provider, repo, name) {
    return exitCode === 0 && out
      ? { error: null, ok: true, url: out }
      : {
          error: tailError(repo, name, provider) || `vercel exited ${exitCode}`,
          ok: false,
          url: null,
        };
  }
  function outputOutcome({
    binding,
    err,
    exitCode,
    name,
    out,
    provider,
    repo,
    stderr,
    stdout,
  }) {
    if ([stdout, stderr].some((result) => result.status === 'rejected')) {
      return {
        error:
          'Deployment finished but its output could not be read; inspect provider status',
        ok: false,
        url: null,
      };
    }
    if (provider === 'convex') {
      return convexOutcome(exitCode, out, err);
    }
    if (provider === 'netlify') {
      return netlifyOutcome(binding, exitCode, out, provider, repo, name);
    }
    return vercelOutcome(exitCode, out, provider, repo, name);
  }
  function loggedOutcome({ name, outcome, out, err, provider, repo, target }) {
    try {
      appendLog(
        repo,
        name,
        provider,
        provider === 'convex'
          ? `\n[deploy ${target}]\n${out}\n${err}\n`
          : `\n${outcome.ok ? outcome.url : `[deploy failed] ${outcome.error}`}\n`
      );
      return outcome;
    } catch {
      return {
        ...outcome,
        error:
          'Deployment finished but its log could not be saved; inspect provider status',
        ok: false,
      };
    }
  }
  function recordDeploymentCompletion({
    entry,
    key,
    outcome,
    provider,
    store,
  }) {
    if (store.get(key) === entry) {
      store.set(key, {
        ...entry,
        deploying: false,
        error: outcome.error,
        url: outcome.ok ? outcome.url : null,
        ...(provider === 'convex' ? { ok: outcome.ok } : {}),
      });
    }
    return {
      ok: outcome.ok,
      ...(outcome.error ? { code: 'DEPLOY_FAILED', error: outcome.error } : {}),
      ...(outcome.url && outcome.ok ? { url: outcome.url } : {}),
    };
  }
  async function completeDeployment({
    binding,
    closeFailed,
    entry,
    key,
    name,
    proc,
    provider,
    repo,
    store,
    target,
  }) {
    const unknown = () => unknownDeployment(store, key, entry);
    // Output failure alone cannot release an active child. Unknown exit, however,
    // must retain ownership promptly even when the child's pipe never closes.
    const exited = confirmedExit(proc, unknown);
    const [stdout, stderr, exitCode] = await Promise.all([
      settledOutput(proc.stdout),
      settledOutput(provider === 'convex' ? proc.stderr : null),
      exited,
    ]);
    const out = stdout.status === 'fulfilled' ? stdout.value : '';
    const err = stderr.status === 'fulfilled' ? stderr.value : '';
    let outcome = outputOutcome({
      binding,
      err,
      exitCode,
      name,
      out,
      provider,
      repo,
      stderr,
      stdout,
    });
    outcome = loggedOutcome({
      err,
      name,
      out,
      outcome,
      provider,
      repo,
      target,
    });
    if (closeFailed) {
      outcome = {
        ...outcome,
        error: 'Deployment finished but its log descriptor could not be closed',
        ok: false,
      };
    }
    return recordDeploymentCompletion({ entry, key, outcome, provider, store });
  }
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
      // biome-ignore lint/style/useErrorCause: The launcher deliberately exposes a fixed sanitized CLI-start error rather than a host command failure.
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
    const completion = completeDeployment({
      binding,
      closeFailed,
      entry,
      key,
      name,
      proc,
      provider,
      repo,
      store,
      target,
    }).catch((error) => {
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
  function netlifyTarget(siteId, target) {
    const production = target === 'production';
    const preview = target === 'preview';
    let environment = 'custom';
    let label = `${siteId} alias ${target}`;
    let deployArgs = ['--alias', target];
    if (production) {
      environment = 'production';
      label = `${siteId} production`;
      deployArgs = ['--prod'];
    } else if (preview) {
      environment = 'preview';
      label = siteId;
      deployArgs = [];
    }
    return { deployArgs, environment, label };
  }
  async function resolveNetlify(target, checkout) {
    const installed = await tool('netlify', checkout);
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
      !netlifySiteIdPattern.test(link.siteId)
    ) {
      throw issue(
        'DEPLOY_LINK_REQUIRED',
        'This checkout needs a Netlify site link before preview deployment.'
      );
    }
    const { deployArgs, environment, label } = netlifyTarget(
      link.siteId,
      target
    );
    return {
      binding: { executable: installed.executable, version: installed.version },
      destination: { environment, id: link.siteId, label },
      launch: {
        command: [
          installed.executable,
          'deploy',
          '--json',
          '--site',
          link.siteId,
          ...deployArgs,
        ],
        cwd: checkout.wtDir,
        linkedSiteId: link.siteId,
      },
    };
  }
  async function resolveConvex(target, checkout) {
    const installed = await tool('convex', checkout);
    const key = await convexDeployKey(checkout);
    const value = typeof key?.value === 'string' ? key.value : null;
    const prod = value?.match(convexProductionKeyPattern);
    const preview = value?.match(convexPreviewKeyPattern);
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
      binding: { executable: installed.executable, version: installed.version },
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
  async function verifiedVercelLink(checkout) {
    let link;
    try {
      link = await readJson(`${checkout.wtDir}/.vercel/project.json`);
    } catch {
      // biome-ignore lint/style/useErrorCause: A link read failure deliberately has one sanitized remediation message and does not expose filesystem details.
      throw issue(
        'DEPLOY_LINK_REQUIRED',
        'This checkout needs a readable Vercel project link. Run vercel link yourself, then refresh preflight.'
      );
    }
    if (
      !(
        vercelProjectIdPattern.test(link?.projectId) &&
        vercelOrgIdPattern.test(link?.orgId)
      )
    ) {
      throw issue(
        'DEPLOY_LINK_REQUIRED',
        'A Vercel project ID and team owner ID are required for exact binding. Refresh the checkout link before deploying.'
      );
    }
    return link;
  }
  async function verifiedVercelProject(installed, link, checkout) {
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
    return remote;
  }
  async function resolveVercel(target, checkout) {
    if (!['preview', 'production'].includes(target)) {
      throw issue(
        'DEPLOY_TARGET_UNVERIFIED',
        'Custom Vercel environments are not authoritatively resolved yet. Select explicit preview or production.'
      );
    }
    const installed = await tool('vercel', checkout);
    if (installed?.version !== '58.9.1' || !installed.executable) {
      throw issue(
        'DEPLOY_TARGET_UNVERIFIED',
        'This Vercel CLI version has not been verified for exact destination binding. Use the reviewed 58.9.1 adapter or update its verification before deploying.'
      );
    }
    const link = await verifiedVercelLink(checkout);
    const remote = await verifiedVercelProject(installed, link, checkout);
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
  }
  // biome-ignore lint/suspicious/useAwait: Provider resolution is a public Promise boundary; unsupported providers must reject rather than synchronously throw.
  return async function resolveProvider(request, checkout) {
    if (request.provider === 'netlify') {
      return resolveNetlify(request.target, checkout);
    }
    if (request.provider === 'convex') {
      return resolveConvex(request.target, checkout);
    }
    if (request.provider === 'vercel') {
      return resolveVercel(request.target, checkout);
    }
    throw issue(
      'DEPLOY_TARGET_UNVERIFIED',
      'Convex deployment is refused: this machine has no source-verified Convex CLI target binding or deployment-key identity. No deployment was started.'
    );
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
  function assertDeployRequest(request) {
    if (
      !['vercel', 'netlify', 'convex'].includes(request.provider) ||
      typeof request.target !== 'string' ||
      !deploymentTargetPattern.test(request.target)
    ) {
      throw issue(
        'INVALID_DEPLOY_TARGET',
        'Select a supported provider and explicit deployment target'
      );
    }
  }
  const operationBusy = (checkout) =>
    ['running', 'unknown'].includes(operation(checkout)?.phase);
  function assertResolvedDestination(resolved) {
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
  }
  async function resolveDeployment(request, admitted = false) {
    assertDeployRequest(request);
    const checkout = target(request.repo, request.name);
    await validate(checkout);
    if (!admitted && operationBusy(checkout)) {
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
    assertResolvedDestination(resolved);
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
    if (!admitted && operationBusy(checkout)) {
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
      const { expectedContext, requiresConfirmation } =
        await resolveDeployment(request);
      return { expectedContext, ok: true, requiresConfirmation };
    } catch (error) {
      return failure(error);
    }
  }
  async function dispatch(request) {
    try {
      const checkout = target(request.repo, request.name);
      return await startOperation(checkout, async () => {
        const current = await resolveDeployment(request, true);
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
