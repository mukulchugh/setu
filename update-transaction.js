// Update decisions are import-safe; command/runtime effects are explicit adapters.
export async function runUpdateTransaction(
  deps,
  { includeUntracked = false, restartAuthorized = false } = {}
) {
  let stage = 'preflight',
    before,
    after,
    stashId,
    marker,
    owner;
  let sourceChanged = false,
    dependenciesChanged = false,
    admissionClosed = false;
  const fail = (code, message) => {
    throw Object.assign(new Error(message), { code });
  };
  const validOid = (value) => /^[a-f0-9]{40,64}$/.test(value);
  async function findOwnStash() {
    const entries = (
      await deps.git(['stash', 'list', '--format=%H%x00%gs'])
    ).split('\n');
    const matches = entries
      .map((line) => line.split('\0'))
      .filter(
        ([oid, subject]) => validOid(oid) && subject?.endsWith(`: ${marker}`)
      );
    if (matches.length !== 1) {
      return;
    }
    const oid = matches[0][0];
    await deps.git(['cat-file', '-e', `${oid}^{commit}`]);
    return oid;
  }
  try {
    before = (await deps.git(['rev-parse', '--verify', 'HEAD'])).trim();
    if (!validOid(before)) {
      fail('UPDATE_REVISION_UNKNOWN', 'Cannot establish the original revision');
    }
    if (
      (await deps.inProgress()) ||
      (await deps.git(['diff', '--name-only', '--diff-filter=U', '-z']))
    ) {
      fail(
        'GIT_OPERATION_PENDING',
        'Resolve the existing Git operation or conflicts before updating'
      );
    }
    const untracked = (
      await deps.git(['ls-files', '--others', '--exclude-standard', '-z'])
    )
      .split('\0')
      .filter(Boolean);
    if (untracked.length && !includeUntracked) {
      fail(
        'UNTRACKED_REVIEW_REQUIRED',
        'Untracked files require review; use --include-untracked only after checking what will enter the recovery stash'
      );
    }
    const dirty = (await deps.git(['status', '--porcelain', '-z'])).length > 0;
    stage = 'portal';
    const portal = await deps.inspectPortal();
    if (
      portal.state !== 'absent' &&
      (portal.state !== 'ready' || portal.protocol !== 1 || !portal.instanceId)
    ) {
      fail(
        'PORTAL_QUIESCENCE_UNAVAILABLE',
        'The running or unknown portal cannot establish guarded cutover; update was not started'
      );
    }
    if (portal.state === 'ready') {
      if (!restartAuthorized) {
        fail(
          'RESTART_APPROVAL_REQUIRED',
          'A running portal requires explicit --restart authorization before changing its loaded source'
        );
      }
      stage = 'quiesce';
      admissionClosed = null; // A transport failure may occur after the portal closed admission.
      const result = await deps.quiesce(portal);
      if (
        result.protocol !== 1 ||
        result.instanceId !== portal.instanceId ||
        !result.token
      ) {
        fail(
          'PORTAL_QUIESCENCE_UNKNOWN',
          'Quiescence could not be confirmed; inspect the portal before retrying'
        );
      }
      owner = result;
      admissionClosed = true;
      if (!result.ok) {
        fail(
          result.code || 'OWNED_WORK_ACTIVE',
          'Active or unknown work blocks update cutover'
        );
      }
    }
    stage = 'fetch';
    await deps.checkStorage?.();
    await deps.git(['fetch', 'origin', '--quiet']);
    if (dirty) {
      stage = 'stash-create';
      await deps.checkStorage?.();
      marker = `setu-update ${deps.operationId()}`;
      sourceChanged = true; // A failing Git write can still have changed its working tree.
      await deps.git(['stash', 'push', '--include-untracked', '-m', marker]);
      stashId = await findOwnStash();
      if (!stashId) {
        fail(
          'UPDATE_STASH_UNKNOWN',
          'The operation recovery stash could not be verified'
        );
      }
      if ((await deps.git(['status', '--porcelain', '-z'])).length > 0) {
        fail(
          'UPDATE_WORKTREE_NOT_CLEAN',
          'Some changes remain outside the recovery stash; update stopped'
        );
      }
    }
    stage = 'rebase';
    await deps.checkStorage?.();
    sourceChanged = true;
    await deps.git(['rebase', 'origin/main']);
    after = (await deps.git(['rev-parse', '--verify', 'HEAD'])).trim();
    if (!validOid(after)) {
      fail(
        'UPDATE_REVISION_UNKNOWN',
        'Cannot establish the installed revision'
      );
    }
    if (stashId) {
      stage = 'restore';
      await deps.git(['stash', 'apply', '--index', stashId]);
      // Retain this exact recovery object. Never pop/drop a guessed newest stash.
    }
    stage = 'install';
    await deps.checkStorage?.();
    dependenciesChanged = true;
    await deps.install();
    stage = 'link';
    await deps.link();
    stage = 'settings';
    const saved = await deps.writeCheck();
    if (!saved?.reconciled) {
      fail(
        'STATE_RECONCILIATION_REQUIRED',
        'Update check state committed but could not be reconciled'
      );
    }
    if (owner) {
      stage = 'restart';
      admissionClosed = null;
      await deps.restart(owner, { after, before });
      admissionClosed = false;
    }
    return {
      admissionClosed,
      after,
      before,
      dependenciesChanged,
      ok: true,
      sourceChanged,
      stage: 'complete',
      stashId,
      ...(saved.warning ? { warning: saved.warning } : {}),
    };
  } catch (error) {
    if (stage === 'stash-create' && marker && !stashId) {
      try {
        stashId = await findOwnStash();
      } catch {
        /* Never claim an unverified backup. */
      }
    }
    if (owner && !sourceChanged && !dependenciesChanged) {
      try {
        const result = await deps.reopen(owner, { coherent: true });
        admissionClosed =
          result?.ok === true ? false : result?.ok === false ? true : null;
      } catch {
        admissionClosed = null;
      }
    }
    return {
      admissionClosed,
      after,
      before,
      code:
        error.code ||
        `UPDATE_${stage.replaceAll('-', '_').toUpperCase()}_FAILED`,
      dependenciesChanged,
      error: error.code
        ? error.message
        : `Update stopped during ${stage}; inspect the recorded revision and recovery stash before retrying`,
      ok: false,
      sourceChanged,
      stage,
      stashId,
    };
  }
}
