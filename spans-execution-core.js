import { createHash } from 'node:crypto';
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

// Reads a plain data object without invoking getters or proxies. Returns null
// for anything else, including unknown or missing fields.
export function exactRequest(input, required, optional = []) {
  if (!isRecord(input)) {
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
    if (descriptor.value !== undefined) {
      copy[key] = descriptor.value;
    }
  }
  return required.every((key) => Object.hasOwn(copy, key)) ? copy : null;
}

// Fixed result shape. The error text is never taken from an adapter.
export function refusal(code, error, extra = {}) {
  return { code, error, ok: false, ...extra };
}
