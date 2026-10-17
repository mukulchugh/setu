import { buildSpansCacheKey } from './spans-cache-key.js';
import { redactSpansValue } from './spans-redaction.js';

const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ISO_EXPIRY =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_EXPIRY_PARTS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function failure(code, error) {
  return { code, error, ok: false };
}

function failureCode(value, fallback) {
  return typeof value === 'string' && FAILURE_CODE.test(value)
    ? value
    : fallback;
}

function sanitizedValue(value) {
  try {
    return { ok: true, value: redactSpansValue(value) };
  } catch {
    return { ok: false };
  }
}

function fillOutcome(filled) {
  if (!filled || typeof filled !== 'object' || typeof filled.ok !== 'boolean') {
    return failure(
      'CACHE_FILL_UNKNOWN',
      'Read-only fill returned an unknown outcome'
    );
  }
  if (filled.ok !== true) {
    return failure(
      failureCode(filled.code, 'CACHE_FILL_FAILED'),
      'Read-only fill failed'
    );
  }
  if (!Object.hasOwn(filled, 'value')) {
    return failure(
      'CACHE_FILL_VALUE_INVALID',
      'Read-only fill returned an invalid value'
    );
  }
  const safe = sanitizedValue(filled.value);
  if (!safe.ok) {
    return failure(
      'CACHE_FILL_VALUE_INVALID',
      'Read-only fill returned an invalid value'
    );
  }
  return { ok: true, value: safe.value };
}

async function runFill(fill) {
  try {
    return fillOutcome(await fill());
  } catch (error) {
    return failure(
      failureCode(error.code, 'CACHE_FILL_FAILED'),
      'Read-only fill failed'
    );
  }
}

function epochMilliseconds(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string' || !ISO_EXPIRY.test(value)) {
    return null;
  }
  const match = value.match(ISO_EXPIRY_PARTS);
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHour,
    offsetMinute,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    month < 1 ||
    month > 12 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (offsetHour !== undefined &&
      (Number(offsetHour) > 23 || Number(offsetMinute) > 59))
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dependencyExpiry(dependencies) {
  let minimum = null;
  for (const dependency of dependencies) {
    if (dependency.validUntil === undefined) {
      continue;
    }
    const parsed = epochMilliseconds(dependency.validUntil);
    if (parsed === null) {
      return { ok: false };
    }
    minimum = minimum === null ? parsed : Math.min(minimum, parsed);
  }
  return { ok: true, validUntil: minimum };
}

function sameJson(left, right) {
  if (left === right) {
    return true;
  }
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameJson(left[key], right[key])
    )
  );
}

function completeEntry(entry, key, manifest, validUntil, nowValue) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    entry.key === key &&
    sameJson(entry.manifest, manifest) &&
    Object.hasOwn(entry, 'value') &&
    Number.isFinite(entry.createdAt) &&
    entry.validUntil === validUntil &&
    (entry.validUntil === null || nowValue < entry.validUntil)
  );
}

function cachedValue(entry, key, manifest, validUntil, nowValue) {
  try {
    if (!completeEntry(entry, key, manifest, validUntil, nowValue)) {
      return { valid: false };
    }
    const safe = sanitizedValue(entry.value);
    return { valid: safe.ok, value: safe.value };
  } catch {
    return { valid: false };
  }
}

function cacheMeta(hit, key, createdAt, manifest, missReason) {
  return {
    createdAt,
    hit,
    key,
    manifest,
    ...(missReason ? { missReason } : {}),
  };
}

async function fillWithoutCaching(request, identity, expiry) {
  const filled = await runFill(request.fill);
  if (!filled.ok) {
    return filled;
  }
  return {
    cache: cacheMeta(
      false,
      null,
      null,
      null,
      expiry.ok ? identity.code : 'DEPENDENCY_EXPIRY_INVALID_OR_UNKNOWN'
    ),
    ok: true,
    value: filled.value,
  };
}

async function cacheOperation({
  expiry,
  identity,
  now,
  readEntry,
  request,
  writeEntry,
}) {
  let existing;
  try {
    existing = await readEntry(identity.key);
  } catch {
    return failure('CACHE_READ_FAILED', 'Cache storage read failed');
  }
  const currentTime = now();
  if (!Number.isFinite(currentTime)) {
    return failure(
      'CACHE_CLOCK_INVALID',
      'Cache clock must return finite epoch milliseconds'
    );
  }
  const hitValue = cachedValue(
    existing,
    identity.key,
    identity.manifest,
    expiry.validUntil,
    currentTime
  );
  if (hitValue.valid) {
    return {
      cache: cacheMeta(
        true,
        identity.key,
        existing.createdAt,
        existing.manifest
      ),
      ok: true,
      value: hitValue.value,
    };
  }

  const filled = await runFill(request.fill);
  if (!filled.ok) {
    return filled;
  }
  const createdAt = now();
  if (!Number.isFinite(createdAt)) {
    return failure(
      'CACHE_CLOCK_INVALID',
      'Cache clock must return finite epoch milliseconds'
    );
  }
  const entry = {
    createdAt,
    key: identity.key,
    manifest: identity.manifest,
    validUntil: expiry.validUntil,
    value: redactSpansValue(filled.value),
  };
  try {
    await writeEntry(identity.key, entry);
  } catch {
    return failure('CACHE_WRITE_FAILED', 'Cache storage write failed');
  }
  return {
    cache: cacheMeta(false, identity.key, createdAt, identity.manifest),
    ok: true,
    value: redactSpansValue(filled.value),
  };
}

export function createSpansCache({
  readEntry,
  writeEntry,
  now = Date.now,
} = {}) {
  if (typeof readEntry !== 'function' || typeof writeEntry !== 'function') {
    throw new Error('Spans cache requires readEntry and writeEntry callbacks');
  }
  if (typeof now !== 'function') {
    throw new Error('Spans cache now must be a function');
  }
  const pending = new Map();

  async function getOrFill(request = {}) {
    if (request.readOnly !== true) {
      return failure(
        'CACHE_READ_ONLY_REQUIRED',
        'Cache fills require readOnly: true'
      );
    }
    if (typeof request.fill !== 'function') {
      return failure(
        'CACHE_FILL_REQUIRED',
        'A read-only fill function is required'
      );
    }

    const identity = buildSpansCacheKey(request);
    const expiry = Array.isArray(request.dependencies)
      ? dependencyExpiry(request.dependencies)
      : { ok: false };
    const cacheable = identity.ok && expiry.ok;
    if (!cacheable) {
      return fillWithoutCaching(request, identity, expiry);
    }

    const existingPending = pending.get(identity.key);
    if (existingPending) {
      return structuredClone(await existingPending);
    }

    const operation = cacheOperation({
      expiry,
      identity,
      now,
      readEntry,
      request,
      writeEntry,
    });
    pending.set(identity.key, operation);
    try {
      return structuredClone(await operation);
    } finally {
      if (pending.get(identity.key) === operation) {
        pending.delete(identity.key);
      }
    }
  }

  return { getOrFill };
}
