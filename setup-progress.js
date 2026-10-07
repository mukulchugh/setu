function validTarget(target) {
  return (
    target &&
    typeof target.repo === 'string' &&
    target.repo &&
    typeof target.name === 'string' &&
    target.name
  );
}

function keyFor(target) {
  return `${target.repo}/${target.name}`;
}

function validText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function validIdentity(value) {
  return (
    validText(value) ||
    (value && typeof value === 'object' && !Array.isArray(value))
  );
}

function sameIdentity(a, b) {
  if (a === b) {
    return true;
  }
  if (!(a && b && typeof a === 'object' && typeof b === 'object')) {
    return false;
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key, index) => key === bKeys[index] && sameIdentity(a[key], b[key])
    )
  );
}

function validRecord(record) {
  const terminal = ['completed', 'failed', 'unknown'];
  return (
    record &&
    validTarget(record.target) &&
    validIdentity(record.checkoutIdentity) &&
    validText(record.logLocation) &&
    validText(record.stage) &&
    Number.isFinite(record.startedAt) &&
    Number.isFinite(record.updatedAt) &&
    ['running', ...terminal].includes(record.state) &&
    (record.attemptId === undefined || validText(record.attemptId)) &&
    ((record.state === 'running' && record.outcome === null) ||
      (terminal.includes(record.state) && record.outcome === record.state)) &&
    (record.finishedAt === undefined || Number.isFinite(record.finishedAt))
  );
}

function records(document) {
  if (!Object.hasOwn(document ?? {}, 'records')) {
    return { ok: true, value: {} };
  }
  const value = document.records;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.values(value).every(validRecord)
  ) {
    return { ok: false };
  }
  return { ok: true, value };
}

function copyRecord(record) {
  return record ? { ...record, target: { ...record.target } } : null;
}

function refusal(code, error) {
  return { code, error, ok: false };
}

export function createSetupProgress({ state, now, newAttemptId }) {
  const clock = now ?? (() => Date.now());

  function newAttempt() {
    const value = newAttemptId?.();
    return validText(value) ? value : null;
  }

  function get(target) {
    if (!validTarget(target)) {
      return null;
    }
    const current = records(state.read('setupProgress'));
    return current.ok
      ? copyRecord(current.value[keyFor(target)])
      : refusal(
          'SETUP_PROGRESS_CORRUPT',
          'The setup progress journal is invalid'
        );
  }

  async function write(target, mutate) {
    const initial = records(state.read('setupProgress'));
    if (!initial.ok) {
      return refusal(
        'SETUP_PROGRESS_CORRUPT',
        'The setup progress journal is invalid'
      );
    }
    let result;
    await state.update('setupProgress', (document) => {
      const current = records(document);
      if (!current.ok) {
        result = refusal(
          'SETUP_PROGRESS_CORRUPT',
          'The setup progress journal is invalid'
        );
        return document;
      }
      const all = current.value;
      result = mutate(copyRecord(all[keyFor(target)]));
      if (!result.ok) {
        return document;
      }
      return {
        ...document,
        records: { ...all, [keyFor(target)]: result.record },
      };
    });
    return result;
  }

  function inputIsValid({ target, checkoutIdentity, logLocation, stage }) {
    return (
      validTarget(target) &&
      validIdentity(checkoutIdentity) &&
      validText(logLocation) &&
      validText(stage)
    );
  }

  async function start(input) {
    if (!inputIsValid(input)) {
      return refusal(
        'SETUP_PROGRESS_INVALID',
        'The setup progress record is invalid'
      );
    }
    return write(input.target, (current) => {
      if (current) {
        return refusal(
          'SETUP_PROGRESS_EXISTS',
          'A setup progress record already exists'
        );
      }
      const at = clock();
      const attemptId = newAttempt();
      if (!attemptId) {
        return refusal(
          'SETUP_ATTEMPT_ID_INVALID',
          'The setup attempt id is invalid'
        );
      }
      return {
        ok: true,
        record: {
          attemptId,
          checkoutIdentity: input.checkoutIdentity,
          logLocation: input.logLocation,
          outcome: null,
          stage: input.stage,
          startedAt: at,
          state: 'running',
          target: { ...input.target },
          updatedAt: at,
        },
      };
    });
  }

  async function stage({
    target,
    checkoutIdentity,
    attemptId,
    stage: nextStage,
  }) {
    if (
      !(
        validTarget(target) &&
        validIdentity(checkoutIdentity) &&
        validText(attemptId) &&
        validText(nextStage)
      )
    ) {
      return refusal(
        'SETUP_PROGRESS_INVALID',
        'The setup progress update is invalid'
      );
    }
    return write(target, (current) => {
      if (!current) {
        return refusal(
          'SETUP_PROGRESS_NOT_FOUND',
          'No setup progress record exists'
        );
      }
      if (!sameIdentity(current.checkoutIdentity, checkoutIdentity)) {
        return refusal(
          'CHECKOUT_IDENTITY_MISMATCH',
          'The checkout identity does not match'
        );
      }
      if (!current.attemptId) {
        return refusal(
          'SETUP_ATTEMPT_REQUIRED',
          'The setup record has no attempt identity'
        );
      }
      if (current.attemptId !== attemptId) {
        return refusal(
          'SETUP_ATTEMPT_MISMATCH',
          'The setup attempt does not match'
        );
      }
      if (current.state !== 'running') {
        return refusal('SETUP_NOT_RUNNING', 'The setup is not running');
      }
      return {
        ok: true,
        record: { ...current, stage: nextStage, updatedAt: clock() },
      };
    });
  }

  async function finish({ target, checkoutIdentity, attemptId, outcome }) {
    if (
      !(
        validTarget(target) &&
        validIdentity(checkoutIdentity) &&
        validText(attemptId) &&
        ['completed', 'failed', 'unknown'].includes(outcome)
      )
    ) {
      return refusal('SETUP_PROGRESS_INVALID', 'The setup outcome is invalid');
    }
    return write(target, (current) => {
      if (!current) {
        return refusal(
          'SETUP_PROGRESS_NOT_FOUND',
          'No setup progress record exists'
        );
      }
      if (!sameIdentity(current.checkoutIdentity, checkoutIdentity)) {
        return refusal(
          'CHECKOUT_IDENTITY_MISMATCH',
          'The checkout identity does not match'
        );
      }
      if (!current.attemptId) {
        return refusal(
          'SETUP_ATTEMPT_REQUIRED',
          'The setup record has no attempt identity'
        );
      }
      if (current.attemptId !== attemptId) {
        return refusal(
          'SETUP_ATTEMPT_MISMATCH',
          'The setup attempt does not match'
        );
      }
      if (current.state !== 'running') {
        return refusal('SETUP_NOT_RUNNING', 'The setup is not running');
      }
      const at = clock();
      return {
        ok: true,
        record: {
          ...current,
          finishedAt: at,
          outcome,
          state: outcome,
          updatedAt: at,
        },
      };
    });
  }

  async function recover() {
    const initial = records(state.read('setupProgress'));
    if (!initial.ok) {
      return refusal(
        'SETUP_PROGRESS_CORRUPT',
        'The setup progress journal is invalid'
      );
    }
    let recovered = 0;
    await state.update('setupProgress', (document) => {
      const current = records(document);
      if (!current.ok) {
        throw Object.assign(new Error('setup progress journal is invalid'), {
          code: 'SETUP_PROGRESS_CORRUPT',
        });
      }
      const all = current.value;
      const next = Object.fromEntries(
        Object.entries(all).map(([key, record]) => {
          if (record?.state !== 'running') {
            return [key, record];
          }
          recovered += 1;
          const at = clock();
          return [
            key,
            {
              ...record,
              finishedAt: at,
              outcome: 'unknown',
              state: 'unknown',
              updatedAt: at,
            },
          ];
        })
      );
      return recovered ? { ...document, records: next } : document;
    });
    return { ok: true, recovered };
  }

  async function retry(input) {
    if (!inputIsValid(input)) {
      return refusal(
        'SETUP_PROGRESS_INVALID',
        'The setup retry record is invalid'
      );
    }
    return write(input.target, (current) => {
      if (!current) {
        return refusal(
          'SETUP_PROGRESS_NOT_FOUND',
          'No setup progress record exists'
        );
      }
      if (!sameIdentity(current.checkoutIdentity, input.checkoutIdentity)) {
        return refusal(
          'CHECKOUT_IDENTITY_MISMATCH',
          'The checkout identity does not match'
        );
      }
      if (!current.attemptId) {
        return refusal(
          'SETUP_ATTEMPT_REQUIRED',
          'The setup record has no attempt identity'
        );
      }
      if (
        !validText(input.attemptId) ||
        current.attemptId !== input.attemptId
      ) {
        return refusal(
          'SETUP_ATTEMPT_MISMATCH',
          'The setup attempt does not match'
        );
      }
      if (!['failed', 'unknown'].includes(current.outcome)) {
        return refusal(
          'SETUP_RETRY_UNAVAILABLE',
          'Only failed or unknown setup can be retried'
        );
      }
      const { finishedAt, ...unfinished } = current;
      const attemptId = newAttempt();
      if (!attemptId) {
        return refusal(
          'SETUP_ATTEMPT_ID_INVALID',
          'The setup attempt id is invalid'
        );
      }
      return {
        ok: true,
        record: {
          ...unfinished,
          attemptId,
          logLocation: input.logLocation,
          outcome: null,
          stage: input.stage,
          startedAt: clock(),
          state: 'running',
          updatedAt: clock(),
        },
      };
    });
  }

  return { finish, get, recover, retry, stage, start };
}
