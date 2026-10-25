import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { redactSpansValue } from './spans-redaction.js';

// Small helpers shared by the Spans execution modules. Nothing here performs
// IO. Request validation is exact: a field that is not named is refused, so a
// caller can never smuggle evidence, paths or authorization into a request.

export const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Dollars to whole micro-dollars, the unit of the usage ledger.
export const toMicro = (usd) => Math.round(usd * 1_000_000);

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const digestOf = (value) => sha256(canonicalJson(value));

export const holdsSecret = (value) =>
  typeof value === 'string' && redactSpansValue(value) !== value;

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isExplicitId(value) {
  return (
    typeof value === 'string' && ID_PATTERN.test(value) && !holdsSecret(value)
  );
}

const MAX_REQUEST_ARRAY_ITEMS = 64;
const REQUEST_ARRAY_FIELDS = new Set(['artifactIds', 'criteria']);

function copyRequestArray(value) {
  if (types.isProxy(value) || !Array.isArray(value)) {
    return null;
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const { length } = value;
  if (!Number.isSafeInteger(length) || length > MAX_REQUEST_ARRAY_ITEMS) {
    return null;
  }

  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !(lengthDescriptor && 'value' in lengthDescriptor) ||
    lengthDescriptor.value !== length ||
    lengthDescriptor.enumerable
  ) {
    return null;
  }

  const copy = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !(descriptor && 'value' in descriptor && descriptor.enumerable) ||
      typeof descriptor.value !== 'string'
    ) {
      return null;
    }
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return copy;
}

function snapshotRequestValue(key, value) {
  if (types.isProxy(value)) {
    return { ok: false };
  }
  if (!Array.isArray(value)) {
    return { ok: true, value };
  }
  const copied = REQUEST_ARRAY_FIELDS.has(key) ? copyRequestArray(value) : null;
  return copied === null ? { ok: false } : { ok: true, value: copied };
}

// The same seal is checked by the portal and the detached capture owner.
export const spansExecutionInputDigest = ({
  baselineTree,
  budgetMicro,
  criteria,
  instructions,
  inputArtifact,
  launchMode,
  requireChange,
  wallClockMs,
}) =>
  digestOf({
    baselineTree,
    budgetMicro,
    criteria,
    inputArtifact,
    instructions,
    launchMode,
    requireChange,
    wallClockMs,
  });

// Reads a plain data object without invoking getters or proxy traps. Returns
// null for anything else, including unknown or missing fields. Array fields
// accepted by current callers are copied as bounded plain data arrays.
export function exactRequest(input, required, optional = []) {
  try {
    if (
      types.isProxy(input) ||
      input === null ||
      typeof input !== 'object' ||
      Array.isArray(input)
    ) {
      return null;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }

    const allowed = new Set([...required, ...optional]);
    const copy = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        return null;
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!(descriptor && 'value' in descriptor && descriptor.enumerable)) {
        return null;
      }
      if (descriptor.value === undefined) {
        continue;
      }
      const snapshot = snapshotRequestValue(key, descriptor.value);
      if (!snapshot.ok) {
        return null;
      }
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: snapshot.value,
        writable: true,
      });
    }
    return required.every((key) => Object.hasOwn(copy, key)) ? copy : null;
  } catch {
    return null;
  }
}

// Fixed result shape. The error text is never taken from an adapter.
export function refusal(code, error, extra = {}) {
  return { code, error, ok: false, ...extra };
}
