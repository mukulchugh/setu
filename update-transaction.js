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
    const branch = (
      await deps.git(['rev-parse', '--abbrev-ref', 'HEAD'])
    ).trim();
    if (branch !== 'main') {
      fail(
        'UPDATE_BRANCH_UNSUPPORTED',
        `Guarded update requires branch main; current branch is ${branch || 'unknown'}`
      );
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
    await deps.install({ frozenLockfile: true });
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
    const recovery = {
      revisionRestored: false,
      stashApplied: false,
      warnings: [],
    };
    if (stage === 'stash-create' && marker && !stashId) {
      try {
        stashId = await findOwnStash();
      } catch {
        /* Never claim an unverified backup. */
      }
    }
    // A failed restart leaves the new revision installed. Rolling the source
    // back there would pair old code with the new dependencies.
    const rollBack = sourceChanged && stage !== 'restart';
    if (stage === 'restart') {
      recovery.warnings.push(
        'The new revision is installed but the portal restart was not confirmed. Start it with `setu portal`.'
      );
    }
    if (rollBack) {
      try {
        if (await deps.rebaseInProgress?.()) {
          await deps.git(['rebase', '--abort']);
          recovery.rebaseAborted = true;
        }
      } catch {
        recovery.warnings.push('The in-progress rebase could not be aborted.');
      }
      try {
        let head = (await deps.git(['rev-parse', '--verify', 'HEAD'])).trim();
        // A verified recovery stash preserves the original working tree while
        // reset returns source files installed by a completed rebase to before.
        if (head !== before && (!marker || stashId)) {
          await deps.git(['reset', '--hard', before]);
          head = (await deps.git(['rev-parse', '--verify', 'HEAD'])).trim();
        }
        recovery.revisionRestored = head === before;
        if (!recovery.revisionRestored) {
          recovery.warnings.push(
            'HEAD could not be restored to the recorded original revision.'
          );
        }
      } catch {
        recovery.warnings.push(
          'The original revision could not be confirmed after recovery.'
        );
      }
      if (stashId) {
        try {
          const clean =
            (await deps.git(['status', '--porcelain', '-z'])).length === 0;
          if (clean) {
            await deps.git(['stash', 'apply', '--index', stashId]);
            recovery.stashApplied = true;
          } else {
            recovery.warnings.push(
              'Recovery stash was retained because the working tree is not clean.'
            );
          }
        } catch {
          recovery.warnings.push(
            'Recovery stash was retained but could not be reapplied cleanly.'
          );
        }
      }
    }
    const checkoutRestored = rollBack
      ? recovery.revisionRestored
      : !(sourceChanged || dependenciesChanged);
    if (owner && checkoutRestored && stage !== 'restart') {
      try {
        const result = await deps.reopen(owner, { coherent: true });
        admissionClosed =
          result?.ok === true ? false : result?.ok === false ? true : null;
      } catch {
        admissionClosed = null;
      }
    }
    if (dependenciesChanged && checkoutRestored) {
      recovery.warnings.push(
        'Dependencies may have changed; reinstall them before relying on this checkout.'
      );
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
      ...(sourceChanged ? { recovery } : {}),
    };
  }
}
