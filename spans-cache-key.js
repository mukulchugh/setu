import { createHash } from 'node:crypto';

const ARRAY_INDEX_KEY = /^(0|[1-9]\d*)$/;
const DEPENDENCY_KINDS = new Set(['content', 'corpus', 'revision']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalArray(value, ancestors) {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        (key !== 'length' &&
          (!ARRAY_INDEX_KEY.test(key) || Number(key) >= value.length))
    )
  ) {
    throw new TypeError('Array has non-JSON properties');
  }
  const values = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor?.enumerable && 'value' in descriptor)) {
      throw new TypeError('Sparse or accessor array');
    }
    values.push(canonicalJson(descriptor.value, ancestors));
  }
  return `[${values.join(',')}]`;
}

function canonicalObject(value, ancestors) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Object is not a plain JSON object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Symbol keys are not JSON-compatible');
  }
  const entries = keys.toSorted().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor.enumerable && 'value' in descriptor)) {
      throw new TypeError('Non-JSON object property');
    }
    return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`;
  });
  return `{${entries.join(',')}}`;
}

function canonicalJson(value, ancestors = new Set()) {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Non-finite number');
    }
    return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError('Value is not JSON-compatible');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Cyclic value');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return canonicalArray(value, ancestors);
    }
    return canonicalObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function failure(code, error) {
  return { code, error, ok: false };
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validGeneration(value) {
  return (
    isNonemptyString(value) ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

const DEPENDENCY_FIELDS = new Set([
  'id',
  'kind',
  'digest',
  'generation',
  'validUntil',
  'known',
  'readable',
  'complete',
  'status',
]);

function validDependencyFields(dependency) {
  return !(
    Object.keys(dependency).some((field) => !DEPENDENCY_FIELDS.has(field)) ||
    ['known', 'readable', 'complete'].some(
      (field) =>
        dependency[field] !== undefined &&
        typeof dependency[field] !== 'boolean'
    ) ||
    (dependency.status !== undefined &&
      !['known', 'unknown', 'unreadable', 'incomplete'].includes(
        dependency.status
      ))
  );
}

function validDependencyState(dependency) {
  return !(
    dependency.known === false ||
    dependency.readable === false ||
    dependency.complete === false ||
    ['unknown', 'unreadable', 'incomplete'].includes(dependency.status)
  );
}

function validDependencyEvidence(dependency) {
  if (dependency.digest !== undefined && !isNonemptyString(dependency.digest)) {
    return false;
  }
  if (
    dependency.generation !== undefined &&
    !validGeneration(dependency.generation)
  ) {
    return false;
  }
  if (
    dependency.validUntil !== undefined &&
    !validGeneration(dependency.validUntil)
  ) {
    return false;
  }
  if (
    (dependency.kind === 'content' || dependency.kind === 'corpus') &&
    !isNonemptyString(dependency.digest)
  ) {
    return false;
  }
  if (dependency.kind === 'corpus' && !validGeneration(dependency.generation)) {
    return false;
  }
  return !(
    dependency.kind === 'revision' &&
    dependency.digest === undefined &&
    dependency.generation === undefined &&
    dependency.validUntil === undefined
  );
}

function validateDependency(dependency, ids) {
  if (!(isRecord(dependency) && isNonemptyString(dependency.id))) {
    return failure(
      'DEPENDENCY_INCOMPLETE',
      'Each dependency requires a known identifier and kind'
    );
  }
  if (!validDependencyFields(dependency)) {
    return failure(
      'DEPENDENCY_INCOMPLETE',
      'Dependency fields must use the explicit dependency contract'
    );
  }
  if (ids.has(dependency.id)) {
    return failure(
      'DEPENDENCY_ID_DUPLICATE',
      'Dependency identifiers must be unique'
    );
  }
  ids.add(dependency.id);
  if (
    !(
      isNonemptyString(dependency.kind) && DEPENDENCY_KINDS.has(dependency.kind)
    )
  ) {
    return failure(
      'DEPENDENCY_INCOMPLETE',
      'Each dependency requires a supported kind'
    );
  }
  if (!validDependencyState(dependency)) {
    return failure(
      'DEPENDENCY_INCOMPLETE',
      'Unknown, unreadable or incomplete dependencies cannot be cached'
    );
  }
  if (!validDependencyEvidence(dependency)) {
    return failure(
      'DEPENDENCY_INCOMPLETE',
      'Dependency revision or validity evidence is incomplete or invalid'
    );
  }
  return { ok: true };
}

function validateDependencies(dependencies) {
  if (!Array.isArray(dependencies)) {
    return failure(
      'DEPENDENCY_INCOMPLETE',
      'Dependencies must be supplied as an explicit array'
    );
  }
  try {
    canonicalJson(dependencies);
  } catch {
    return failure(
      'DEPENDENCY_INCOMPLETE',
      'A dependency is not a complete JSON value'
    );
  }
  const ids = new Set();
  for (const dependency of dependencies) {
    const result = validateDependency(dependency, ids);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}

export function buildSpansCacheKey({
  input,
  dependencies,
  scope,
  versions,
} = {}) {
  try {
    if (input === undefined || !isRecord(scope) || !isRecord(versions)) {
      return failure(
        'CACHE_KEY_INPUT_INVALID',
        'Input, scope and versions must be supplied'
      );
    }
    const dependencyResult = validateDependencies(dependencies);
    if (!dependencyResult.ok) {
      return dependencyResult;
    }
    for (const name of ['project', 'environment', 'access']) {
      if (!isNonemptyString(scope[name])) {
        return failure(
          'CACHE_SCOPE_INVALID',
          `Scope requires a nonempty ${name} value`
        );
      }
    }
    for (const name of ['tool', 'skill', 'parser']) {
      if (!isNonemptyString(versions[name])) {
        return failure(
          'CACHE_VERSIONS_INVALID',
          `Versions require a nonempty ${name} version`
        );
      }
    }
    if (
      Object.keys(versions).some(
        (name) => !['tool', 'skill', 'parser', 'model', 'prompt'].includes(name)
      )
    ) {
      return failure(
        'CACHE_VERSIONS_INVALID',
        'Versions may contain tool, skill, parser and optional model/prompt settings'
      );
    }

    const normalized = {
      dependencies: [...dependencies]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ id, kind, digest, generation, validUntil }) => ({
          ...(digest === undefined ? {} : { digest }),
          ...(generation === undefined ? {} : { generation }),
          id,
          kind,
          ...(validUntil === undefined ? {} : { validUntil }),
        })),
      input,
      scope,
      versions,
    };
    const key = `sha256:${sha256(`setu-spans-cache-key-v1\0${canonicalJson(normalized)}`)}`;
    const manifest = {
      algorithm: 'sha256',
      dependencies: normalized.dependencies,
      inputDigest: sha256(canonicalJson(input)),
      keyVersion: 1,
      scope: Object.fromEntries(
        Object.entries(scope).map(([name, value]) => [
          `${name}Digest`,
          sha256(canonicalJson(value)),
        ])
      ),
      versions: {
        parser: versions.parser,
        skill: versions.skill,
        tool: versions.tool,
        ...(versions.model === undefined
          ? {}
          : { modelSettingsDigest: sha256(canonicalJson(versions.model)) }),
        ...(versions.prompt === undefined
          ? {}
          : { promptSettingsDigest: sha256(canonicalJson(versions.prompt)) }),
      },
    };
    return { key, manifest, ok: true };
  } catch {
    return failure(
      'INVALID_JSON_VALUE',
      'Cache key inputs must contain only finite, acyclic JSON values'
    );
  }
}
