function failure(code, error) {
  return { code, error, ok: false };
}

async function targetOf(registeredTarget, repo, name) {
  if (!(typeof repo === 'string' && typeof name === 'string')) {
    return null;
  }
  return (await registeredTarget(repo, name)) ?? null;
}

function filterTarget(records, repo, name) {
  return records.filter(
    (record) =>
      (repo === undefined || record.repo === repo) &&
      (name === undefined || record.name === name)
  );
}

// Portal composition only. Runtime modules remain independent factories; this
// adapter gives HTTP and MCP one target-validation and outcome-recording path.
export function createPortalWiring({
  admission,
  attention,
  cache,
  caches,
  dependency,
  events,
  github,
  headless,
  mcpActions,
  now = Date.now,
  operationId = () => crypto.randomUUID(),
  registeredTarget,
  sessions,
  setup,
  storage,
} = {}) {
  if (typeof registeredTarget !== 'function') {
    throw new TypeError('Portal wiring needs a registered target resolver');
  }

  const target = async (repo, name) => {
    const found = await targetOf(registeredTarget, repo, name);
    return (
      found ??
      failure(
        'WORKTREE_NOT_FOUND',
        'No registered worktree matches this request'
      )
    );
  };
  const present = (value) => value && value.ok !== false && value.repo;
  const record = async (kind, source, value, result, id = operationId()) => {
    if (!events?.record) {
      return { operationId: id, outcomeRecorded: false };
    }
    const state =
      result?.state === 'unknown' || result?.code?.includes('UNKNOWN')
        ? 'unknown'
        : result?.queued
          ? 'queued'
          : ['starting', 'running', 'accepted'].includes(result?.state)
            ? 'accepted'
            : result?.ok === false
              ? 'failed'
              : 'completed';
    const persisted = await events.record({
      ...(result?.code ? { code: result.code } : {}),
      at: now(),
      id,
      kind,
      operationId: id,
      source,
      state,
      target: value ? { name: value.name, repo: value.repo } : null,
    });
    return persisted?.ok === true
      ? { operationId: id }
      : { operationId: id, outcomeRecorded: false };
  };
  const withOutcome = async (kind, value, source, action) => {
    const id = operationId();
    let accepted = { operationId: id };
    try {
      accepted = await record(
        kind,
        source ?? 'portal',
        value,
        { ok: true, state: 'accepted' },
        id
      );
    } catch {
      accepted = { operationId: id, outcomeRecorded: false };
    }
    let result;
    try {
      result = await action(value, id);
    } catch (error) {
      result = failure(
        error?.code ?? 'OPERATION_UNKNOWN',
        error?.message ?? 'The requested operation could not be confirmed'
      );
    }
    let outcome = { operationId: id };
    try {
      outcome = await record(kind, source ?? 'portal', value, result, id);
    } catch {
      outcome = { operationId: id, outcomeRecorded: false };
    }
    return {
      ...result,
      ...(result?.operationId === undefined ? outcome : {}),
      ...(accepted.outcomeRecorded === false ||
      outcome.outcomeRecorded === false
        ? { outcomeRecorded: false }
        : {}),
    };
  };
  const withTarget = async (kind, input, source, action) => {
    const value = await target(input?.repo, input?.name);
    return present(value) ? withOutcome(kind, value, source, action) : value;
  };
  const readTarget = async (input, action) => {
    const value = await target(input?.repo, input?.name);
    if (!present(value)) {
      return value;
    }
    try {
      return await action(value);
    } catch (error) {
      return failure(
        error?.code ?? 'OPERATION_UNKNOWN',
        error?.message ?? 'The requested operation could not be confirmed'
      );
    }
  };

  return {
    admissionStatus: () => admission.status(),
    agentSessions: (query = {}) => ({
      ok: true,
      sessions: filterTarget(sessions.list(), query.repo, query.name),
    }),
    attention: (query = {}) => {
      const listed = attention.list();
      return listed?.ok === false
        ? listed
        : {
            events: filterTarget(listed.events ?? [], query.repo, query.name),
            ok: true,
          };
    },
    attentionFocus: (input) =>
      withTarget('attention-focus', input, input.source, () =>
        attention.returnToTerminal(input.sessionId, {
          checkoutIdentity: input.checkoutIdentity,
        })
      ),
    attentionHook: (input) => attention.receive(input),
    cacheExecute: (input) =>
      withTarget('cache-execute', input, input.source, (value) =>
        cache.executeForTarget
          ? cache.executeForTarget(value, input)
          : cache.execute(input.manifestId, input.confirmation)
      ),
    cachePrepare: (input) =>
      withTarget('cache-prepare', input, input.source, (value) =>
        cache.prepare(value)
      ),
    dependencyRepair: (input) =>
      withTarget('dependency-repair', input, input.source, async (value) => {
        const result = await dependency.repair(value);
        return { ...result, executed: false };
      }),
    dependencyVerify: (input) =>
      withTarget('dependency-verify', input, input.source, async (value) => {
        const view = await dependency.inspect(value);
        return view?.ok === false
          ? view
          : { ok: true, view: { ...view, name: value.name, repo: value.repo } };
      }),
    dependencyViews: async (input = {}) => dependency.views(input),
    endAgentSession: (input) =>
      withTarget('session-end', input, input.source, () =>
        sessions.end(input.sessionId, {
          checkoutIdentity: input.checkoutIdentity,
        })
      ),
    githubDispatch: (input) =>
      withTarget('github-dispatch', input, input.source, (value) =>
        github.dispatch({ ...input, name: value.name, repo: value.repo })
      ),
    githubRuns: (input) => readTarget(input, (value) => github.listRuns(value)),
    githubWorkflows: (input) =>
      readTarget(input, (value) => github.listWorkflows(value)),
    headlessCancel: (input) =>
      withTarget('headless-cancel', input, input.source, () =>
        headless.cancel({
          checkoutIdentity: input.checkoutIdentity,
          id: input.runId,
        })
      ),
    headlessResume: (input, source = input?.source) =>
      withTarget('headless-resume', input, source, (value, id) =>
        headless.resume({
          ...input,
          checkoutIdentity: value.checkoutIdentity,
          checkoutPath: value.wtDir,
          id,
          name: value.name,
          repo: value.repo,
          runId: input.runId,
        })
      ),
    headlessRuns: (query = {}) => ({
      ok: true,
      runs: filterTarget(headless.list?.() ?? [], query.repo, query.name),
    }),
    headlessStart: (input, source = input?.source) =>
      withTarget('headless-run', input, source, (value, id) =>
        headless.start({
          ...input,
          checkoutIdentity: value.checkoutIdentity,
          checkoutPath: value.wtDir,
          id,
          name: value.name,
          repo: value.repo,
        })
      ),
    invokeMcpAction: (input, source = input?.source) =>
      mcpActions.invoke(input.actionId, input.input, input.confirmation, {
        source,
      }),
    mcpActions: () => mcpActions.list(),
    operations: ({ repo, name, ...query } = {}) => {
      const since =
        typeof query.since === 'string' ? Date.parse(query.since) : query.since;
      const listed = events.list({
        ...query,
        since,
        ...(repo !== undefined && name !== undefined
          ? { target: { name, repo } }
          : {}),
      });
      return listed?.ok === false
        ? listed
        : {
            ...listed,
            events: listed.events.filter(
              (event) =>
                (repo === undefined || event.target?.repo === repo) &&
                (name === undefined || event.target?.name === name)
            ),
          };
    },
    preflightMcpAction: (input) =>
      mcpActions.preflight(input.actionId, input.input),
    saveMcpAction: (input) =>
      withOutcome('mcp-action-save', null, input.source, () =>
        mcpActions.save(input)
      ),
    setupProgress: (query = {}) => {
      const listed = setup.list();
      return listed?.ok === false
        ? listed
        : {
            ok: true,
            records: filterTarget(listed.records ?? [], query.repo, query.name),
          };
    },
    setupRetry: (input) =>
      withTarget('setup-retry', input, input.source, (value) =>
        setup.retry({ ...input, target: value })
      ),
    sharedCaches: () => caches.list(),
    workspaceStorage: async () => ({
      observations: await storage.readAll(),
      ok: true,
      roots: await storage.roots(),
    }),
    workspaceStorageInspect: async (input) => {
      if (input?.storeId !== undefined) {
        const observations = await storage.inspect({ storeId: input.storeId });
        return observations?.ok === false
          ? observations
          : { observations, ok: true };
      }
      const value = await target(input?.repo, input?.name);
      if (!present(value)) {
        return value;
      }
      const observations = await storage.inspect(value);
      return observations?.ok === false
        ? observations
        : { observations, ok: true };
    },
  };
}
