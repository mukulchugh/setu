import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { validAgentSessionRecord } from './agent-sessions.js';
import {
  dependencySharingForTarget,
  inspectDependencyView,
  repairDependencyView,
} from './dependency-sharing.js';
import { createGithubActions } from './github-actions.js';
import { validHeadlessRunRecord } from './headless-run.js';
import { createMcpActions } from './mcp-actions.js';
import { createOperationEvents } from './operation-events.js';
import { createPortalWiring } from './portal-wiring.js';
import { createResourceAdmission } from './resource-admission.js';
import { createSharedCacheCatalog } from './shared-cache-catalog.js';
import { createWorkspaceStorage } from './workspace-storage.js';
import { createWorktreeCache } from './worktree-cache.js';

const failure = (code, error) => ({ code, error, ok: false });
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
function same(left, right) {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => same(value, right[index]))
    );
  }
  if (!(object(left) && object(right))) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && same(left[key], right[key])
    )
  );
}

function storeId(kind, path) {
  return `store:${createHash('sha256').update(`${kind}\0${path}`).digest('hex')}`;
}

function rootId(category, path) {
  return `root:${createHash('sha256').update(`${category}\0${path}`).digest('hex')}`;
}

function storeCategory(kind) {
  return (
    {
      'download-cache': 'downloads',
      'package-store': 'live-store',
      'task-cache': 'generated',
    }[kind] ?? 'live-store'
  );
}

function validRuntimeDocument(
  document,
  field,
  target,
  activeStates,
  validRecord
) {
  if (!object(document)) {
    return { state: 'unknown' };
  }
  const records = document[field];
  if (records === undefined) {
    return { state: 'stopped' };
  }
  if (!object(records)) {
    return { state: 'unknown' };
  }
  for (const [id, record] of Object.entries(records)) {
    if (
      !validRecord(record, id) ||
      record.id !== id ||
      !object(record.checkoutIdentity)
    ) {
      return { state: 'unknown' };
    }
    if (
      record.repo === target.repo &&
      record.name === target.name &&
      activeStates.has(record.state)
    ) {
      return { state: 'active' };
    }
  }
  return { state: 'stopped' };
}

// This is the portal's production composition for second-wave resource routes.
// It intentionally accepts host/process/provider boundaries so importing it has no I/O.
export function createPortalResourceServices({
  branch,
  callTool,
  claims,
  command,
  config,
  entries,
  githubTarget,
  gitHead,
  hostHealth,
  lifecycle,
  mcpTools,
  nativeRuntime = async () => 'dead',
  now = Date.now,
  operationId = () => crypto.randomUUID(),
  randomId = () => crypto.randomUUID(),
  resolveTarget,
  state,
  trackedPaths,
} = {}) {
  if (
    !(
      state?.read &&
      state?.update &&
      state?.withTargets &&
      typeof config === 'function' &&
      typeof entries === 'function' &&
      typeof resolveTarget === 'function'
    )
  ) {
    throw new TypeError(
      'Portal resource services need workspace state, configuration, registry, and target resolution'
    );
  }

  const events = createOperationEvents({ now, state });
  const admission = createResourceAdmission({ hostHealth, now, state });
  const manifestMap = (document) => {
    if (
      !object(document) ||
      (document.manifests !== undefined && !object(document.manifests))
    ) {
      throw Object.assign(new Error('Cleanup manifest journal is invalid'), {
        code: 'CACHE_MANIFEST_JOURNAL_INVALID',
      });
    }
    return document.manifests ?? {};
  };
  const manifests = {
    get: async (id) => manifestMap(state.read('cacheManifests'))[id] ?? null,
    save: async (manifest) =>
      state.update('cacheManifests', (document) => ({
        ...document,
        manifests: { ...manifestMap(document), [manifest.id]: manifest },
      })),
    update: async (id, mutate) =>
      state.update('cacheManifests', (document) => {
        const manifestEntries = manifestMap(document);
        const current = manifestEntries[id];
        if (!current) {
          throw new Error('cleanup manifest disappeared');
        }
        return {
          ...document,
          manifests: { ...manifestEntries, [id]: mutate(current) },
        };
      }),
  };
  const catalog = createSharedCacheCatalog({
    readConfig: config,
    readDependencyViews: async () => state.read('dependencyViews'),
    readRegistry: async () =>
      (await entries()).map((row) => ({ checkout: row.wtDir })),
  });

  async function roots() {
    const source = await Promise.all(
      (await entries()).map(async (row) => {
        const target = await resolveTarget(row.repo, row.name);
        const path = target?.checkoutIdentity?.checkoutPath ?? row.wtDir;
        const consumer = [{ name: row.name, repo: row.repo }];
        return [
          {
            category: 'source',
            consumers: consumer,
            id: rootId('source', path),
            path,
            targetKey: row.key,
          },
          {
            category: 'dependencies',
            consumers: consumer,
            id: rootId('dependencies', join(path, 'node_modules')),
            path: join(path, 'node_modules'),
            targetKey: row.key,
          },
          {
            category: 'generated',
            consumers: consumer,
            id: rootId('generated', join(path, '.next')),
            path: join(path, '.next'),
            targetKey: row.key,
          },
        ];
      })
    );
    const listed = await catalog.list();
    const sourceRoots = source.flat();
    return [
      ...sourceRoots,
      ...listed.stores.map((store) => ({
        category: storeCategory(store.kind),
        consumers: awaitConsumers(store, sourceRoots),
        id: storeId(store.kind, store.path),
        path: store.path,
        storeConsumers: store.consumers,
      })),
    ];
  }

  function awaitConsumers(store, source) {
    const byCheckout = new Map(
      source.map((row) => [row.path, row.consumers[0]])
    );
    return store.consumers
      .map((checkout) => byCheckout.get(checkout))
      .filter(Boolean);
  }

  let currentStorage = null;
  async function observer() {
    const currentRoots = await roots();
    const signature = JSON.stringify(
      currentRoots.map(({ category, consumers, id, path }) => ({
        category,
        consumers,
        id,
        path,
      }))
    );
    if (currentStorage?.signature === signature) {
      return { roots: currentRoots, storage: currentStorage.storage };
    }
    const storage = createWorkspaceStorage({ now, roots: currentRoots });
    currentStorage = { signature, storage };
    return { roots: currentRoots, storage };
  }
  const storage = {
    async inspect(input) {
      const current = await observer();
      const all = current.roots;
      const selected = input?.storeId
        ? all.filter(
            (root) => root.id === input.storeId && root.id.startsWith('store:')
          )
        : all.filter(
            (root) =>
              root.targetKey === input?.key &&
              ['source', 'dependencies', 'generated'].includes(root.category)
          );
      if (selected.length === 0 || (input?.storeId && selected.length !== 1)) {
        return failure(
          'STORAGE_ROOT_NOT_FOUND',
          'Select one registered worktree or known shared store'
        );
      }
      return current.storage.observeSelected(selected.map((root) => root.id));
    },
    async inspectAll() {
      return (await observer()).storage.observeAll();
    },
    async readAll() {
      return (await observer()).storage.readAll();
    },
    async roots() {
      return (await roots()).map(({ path, targetKey, ...root }) => root);
    },
  };

  async function ownership(target) {
    let records;
    try {
      records = await claims();
    } catch {
      return { state: 'unknown' };
    }
    if (!Array.isArray(records)) {
      return { state: 'unknown' };
    }
    for (const claim of records) {
      if (!object(claim) || claim.unreadable) {
        return { state: 'unknown' };
      }
      if (claim.wtDir === target.wtDir) {
        return { state: 'active' };
      }
    }
    return { state: 'clear' };
  }

  function lifecycleRuntime(target) {
    const life = lifecycle?.snapshot?.(target.key);
    if (life?.phase === 'unknown') {
      return { state: 'unknown' };
    }
    if (life?.phase === 'queued') {
      return { queued: true, state: 'stopped' };
    }
    const operation = lifecycle?.operationStatus?.(target.key);
    if (operation?.phase === 'unknown') {
      return { state: 'unknown' };
    }
    if (operation?.phase === 'queued') {
      return { queued: true, state: 'stopped' };
    }
    if (
      operation &&
      !['complete', 'completed', 'failed', 'stopped'].includes(operation.phase)
    ) {
      return { state: 'active' };
    }
    if (!life?.reserved) {
      return null;
    }
    return life.phase === 'queued'
      ? { queued: true, state: 'stopped' }
      : { state: 'active' };
  }

  function persistedRuntime(target) {
    let sessions;
    let runs;
    try {
      sessions = validRuntimeDocument(
        state.read('agentSessions'),
        'sessions',
        target,
        new Set(['starting', 'running', 'unknown']),
        validAgentSessionRecord
      );
      runs = validRuntimeDocument(
        state.read('headlessRuns'),
        'runs',
        target,
        new Set(['starting', 'running', 'cancelling', 'unknown']),
        validHeadlessRunRecord
      );
    } catch {
      return { state: 'unknown' };
    }
    if (sessions.state === 'unknown' || runs.state === 'unknown') {
      return { state: 'unknown' };
    }
    return sessions.state === 'active' || runs.state === 'active'
      ? { state: 'active' }
      : { queued: false, state: 'stopped' };
  }

  async function runtime(target) {
    const lifecycleState = lifecycleRuntime(target);
    if (lifecycleState) {
      return lifecycleState;
    }
    const native = await nativeRuntime(target);
    if (native === 'unknown') {
      return { state: 'unknown' };
    }
    if (native === 'alive') {
      return { state: 'active' };
    }
    return persistedRuntime(target);
  }

  const cache = createWorktreeCache({
    checkoutIdentity: (target) =>
      Promise.resolve(resolveTarget(target.repo, target.name)).then(
        (value) => value?.checkoutIdentity ?? { known: false }
      ),
    gitHead,
    manifests,
    now,
    ownership,
    randomId,
    runtime,
    state,
    trackedPaths,
  });
  const cacheWithTarget = {
    execute: cache.execute,
    async executeForTarget(target, input) {
      const manifest = await manifests.get(input.manifestId);
      if (!manifest) {
        return failure('MANIFEST_NOT_FOUND', 'Cleanup manifest was not found');
      }
      if (
        manifest.target?.repo !== target.repo ||
        manifest.target?.name !== target.name
      ) {
        return failure(
          'MANIFEST_TARGET_MISMATCH',
          'Cleanup manifest belongs to a different worktree'
        );
      }
      if (!same(manifest.checkoutIdentity, target.checkoutIdentity)) {
        return failure(
          'IDENTITY_CHANGED',
          'Checkout identity changed since cleanup was prepared'
        );
      }
      return cache.execute(input.manifestId, input.confirmation);
    },
    prepare: cache.prepare,
  };
  const github = createGithubActions({
    branch: (target) => branch(target),
    run: command,
    target: githubTarget,
  });
  const mcpActions = createMcpActions({
    callTool,
    eventRecorder: events,
    now,
    state,
    tools: mcpTools,
  });

  async function dependencyFor(target) {
    let sharing;
    let document;
    try {
      sharing = dependencySharingForTarget(
        await config(),
        target.repo,
        target.name
      );
      document = state.read('dependencyViews');
    } catch {
      return failure(
        'DEPENDENCY_VIEW_STATE_CORRUPT',
        'Dependency consumer records could not be read'
      );
    }
    if (!sharing?.enabled) {
      return { enabled: false, ok: true, state: 'disabled' };
    }
    if (
      !object(document) ||
      (document.consumers !== undefined && !object(document.consumers))
    ) {
      return failure(
        'DEPENDENCY_VIEW_STATE_CORRUPT',
        'Dependency consumer records could not be read'
      );
    }
    const consumers = document.consumers ?? {};
    for (const [checkout, consumer] of Object.entries(consumers)) {
      if (
        !object(consumer) ||
        consumer.checkout !== checkout ||
        typeof consumer.bunVersion !== 'string' ||
        typeof consumer.linkerMode !== 'string' ||
        typeof consumer.lockfileHash !== 'string' ||
        typeof consumer.platformNamespace !== 'string'
      ) {
        return failure(
          'DEPENDENCY_VIEW_STATE_CORRUPT',
          'Dependency consumer records could not be read'
        );
      }
    }
    return { ...sharing, consumers };
  }
  const dependency = {
    async inspect(target) {
      const sharing = await dependencyFor(target);
      if (sharing.ok === false || sharing.enabled === false) {
        return sharing;
      }
      return {
        ...(await inspectDependencyView(target.wtDir, sharing)),
        enabled: true,
      };
    },
    async repair(target) {
      const sharing = await dependencyFor(target);
      if (sharing.ok === false) {
        return sharing;
      }
      if (sharing.enabled === false) {
        return failure(
          'DEPENDENCY_VIEW_NOT_MANAGED',
          'Dependency sharing is disabled for this worktree'
        );
      }
      return {
        ...(await repairDependencyView(target.wtDir, sharing)),
        enabled: true,
      };
    },
    async views({ repo, name } = {}) {
      const rows = [];
      for (const row of await entries()) {
        if ((repo && row.repo !== repo) || (name && row.name !== name)) {
          continue;
        }
        // biome-ignore lint/performance/noAwaitInLoops: Views retain registry order and stop at the first unresolved target or failed inspection.
        const target = await resolveTarget(row.repo, row.name);
        if (!target?.checkoutIdentity) {
          return failure(
            'CHECKOUT_IDENTITY_UNKNOWN',
            'Checkout identity could not be verified'
          );
        }
        const view = await this.inspect(target);
        if (view.ok === false) {
          return view;
        }
        rows.push({ ...view, name: row.name, repo: row.repo });
      }
      return { ok: true, views: rows };
    },
  };
  const services = createPortalWiring({
    admission,
    cache: cacheWithTarget,
    caches: {
      async list() {
        const listed = await catalog.list();
        return {
          ok: true,
          stores: listed.stores.map((store) => ({
            ...store,
            id: storeId(store.kind, store.path),
          })),
        };
      },
    },
    dependency,
    events,
    github,
    mcpActions,
    now,
    operationId,
    registeredTarget: resolveTarget,
    storage,
  });
  return Object.freeze({ ...services, admission, events, storage });
}

export async function dispatchPortalResourceRoute(services, request) {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  const source = ['ui', 'cli', 'raycast'].includes(
    request.headers.get('x-setu-source')
  )
    ? request.headers.get('x-setu-source')
    : 'portal';
  const response = (value) =>
    new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  const read = async (serviceAction, input = query) =>
    response(await services[serviceAction](input));
  const getRoutes = {
    '/api/agent-sessions': { action: 'agentSessions', optional: true },
    '/api/attention': { action: 'attention', optional: true },
    '/api/dependency-sharing': { action: 'dependencyViews' },
    '/api/github/runs': { action: 'githubRuns' },
    '/api/github/workflows': { action: 'githubWorkflows' },
    '/api/headless-runs': { action: 'headlessRuns', optional: true },
    '/api/mcp-actions': { action: 'mcpActions', input: {} },
    '/api/operations': {
      action: 'operations',
      input: {
        ...query,
        limit: query.limit ? Number(query.limit) : undefined,
        since: query.since || undefined,
      },
    },
    '/api/resource-admission': { action: 'admissionStatus', input: {} },
    '/api/shared-caches': { action: 'sharedCaches', input: {} },
    '/api/workspace-storage': { action: 'workspaceStorage', input: {} },
  };
  if (request.method === 'GET') {
    const route = getRoutes[url.pathname];
    return route && (!route.optional || services[route.action])
      ? read(route.action, route.input)
      : null;
  }
  if (request.method !== 'POST') {
    return null;
  }
  const routes = {
    '/api/agent-sessions/end': 'endAgentSession',
    '/api/attention/focus': 'attentionFocus',
    '/api/attention/hook': 'attentionHook',
    '/api/dependency-sharing/repair': 'dependencyRepair',
    '/api/dependency-sharing/verify': 'dependencyVerify',
    '/api/github/dispatch': 'githubDispatch',
    '/api/headless-runs/cancel': 'headlessCancel',
    '/api/headless-runs/resume': 'headlessResume',
    '/api/headless-runs/start': 'headlessStart',
    '/api/mcp-actions/invoke': 'invokeMcpAction',
    '/api/mcp-actions/preflight': 'preflightMcpAction',
    '/api/mcp-actions/save': 'saveMcpAction',
    '/api/pr-review/handoff': 'handoffReview',
    '/api/workspace-storage/inspect': 'workspaceStorageInspect',
    '/api/worktree-cache/execute': 'cacheExecute',
    '/api/worktree-cache/prepare': 'cachePrepare',
  };
  const action = routes[url.pathname];
  if (!action) {
    return null;
  }
  const body = await request.json().catch(() => ({}));
  if (typeof services[action] !== 'function') {
    return null;
  }
  return response(await services[action]({ ...body, source }));
}
