import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;

function objectRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validHash(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function legacyFields(fingerprint) {
  return (
    objectRecord(fingerprint) &&
    validHash(fingerprint.contentHash) &&
    validHash(fingerprint.metadataHash)
  );
}

function stableFields(fingerprint) {
  if (
    !(legacyFields(fingerprint) && Number.isSafeInteger(fingerprint.size)) ||
    fingerprint.size < 0 ||
    !Number.isSafeInteger(fingerprint.mode) ||
    fingerprint.mode < 0 ||
    !Number.isSafeInteger(fingerprint.uid) ||
    fingerprint.uid < 0 ||
    !Number.isSafeInteger(fingerprint.gid) ||
    fingerprint.gid < 0 ||
    !Array.isArray(fingerprint.attributes)
  ) {
    return null;
  }
  const names = new Set();
  const attributes = [];
  for (const attribute of fingerprint.attributes) {
    if (
      !objectRecord(attribute) ||
      typeof attribute.name !== 'string' ||
      attribute.name.length === 0 ||
      attribute.name.includes('\0') ||
      !validHash(attribute.digest) ||
      names.has(attribute.name)
    ) {
      return null;
    }
    names.add(attribute.name);
    attributes.push([attribute.name, attribute.digest]);
  }
  attributes.sort(([left], [right]) => {
    if (left < right) {
      return -1;
    }
    return Number(left > right);
  });
  return attributes;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function dependencyObjectKey(fingerprint, version = 2) {
  if (version === 1) {
    if (!legacyFields(fingerprint)) {
      throw new TypeError('A valid legacy dependency fingerprint is required');
    }
    return sha256(`${fingerprint.contentHash}${fingerprint.metadataHash}`);
  }
  if (version !== 2) {
    throw new TypeError(
      `Unsupported dependency object identity version: ${version}`
    );
  }
  const attributes = stableFields(fingerprint);
  if (!attributes) {
    throw new TypeError('A valid dependency fingerprint is required');
  }
  return sha256(
    `setu-dependency-object-v2\0${JSON.stringify([
      fingerprint.contentHash,
      fingerprint.size,
      fingerprint.mode,
      fingerprint.uid,
      fingerprint.gid,
      attributes,
    ])}`
  );
}

export function sameDependencyObject(left, right) {
  const leftAttributes = stableFields(left);
  const rightAttributes = stableFields(right);
  if (!(leftAttributes && rightAttributes)) {
    return false;
  }
  return (
    left.contentHash === right.contentHash &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    JSON.stringify(leftAttributes) === JSON.stringify(rightAttributes)
  );
}
