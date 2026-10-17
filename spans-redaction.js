const REDACTION_MARKER = '[REDACTED]';

const SECRET_FIELD_NAMES = new Set([
  'authorization',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'privatekey',
]);

const SECRET_ASSIGNMENT =
  /(["']?)(authorization|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)\1(\s*[:=]\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\[REDACTED\]|(?:Bearer\s+)?[^\s,;}\]]+))/gi;
const BEARER_TOKEN =
  /\bBearer\s+(?!\[REDACTED\]|<redacted>|\*{3})([A-Za-z0-9._~+/-]+=*)/gi;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;
const RECOGNIZABLE_API_KEY =
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g;
const ARRAY_INDEX = /^\d+$/;
const CREDENTIAL_FILENAME =
  /^\.?credentials?(?:$|[._-](?:json|json5|jsonl|ya?ml|toml|ini|conf|pem|key|p12|pfx)(?:$|[._-])|[-_]file(?:$|[._-]))/;

function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactAssignment(
  _match,
  keyQuote,
  field,
  separator,
  doubleQuoted,
  singleQuoted
) {
  let replacement = REDACTION_MARKER;
  if (doubleQuoted !== undefined) {
    replacement = `"${REDACTION_MARKER}"`;
  } else if (singleQuoted !== undefined) {
    replacement = `'${REDACTION_MARKER}'`;
  }

  return `${keyQuote}${field}${keyQuote}${separator}${replacement}`;
}

function redactText(value) {
  return value
    .replace(PRIVATE_KEY_BLOCK, REDACTION_MARKER)
    .replace(SECRET_ASSIGNMENT, redactAssignment)
    .replace(BEARER_TOKEN, () => `Bearer ${REDACTION_MARKER}`)
    .replace(RECOGNIZABLE_API_KEY, REDACTION_MARKER);
}

function invalidJsonValue(reason) {
  return new TypeError(
    `redactSpansValue requires a JSON-compatible value: ${reason}`
  );
}

function hasExtraArrayProperties(value) {
  return Reflect.ownKeys(value).some((key) => {
    if (key === 'length') {
      return false;
    }
    return (
      typeof key !== 'string' ||
      !ARRAY_INDEX.test(key) ||
      String(Number(key)) !== key ||
      Number(key) >= value.length
    );
  });
}

function copyArray(value, copy) {
  if (hasExtraArrayProperties(value)) {
    throw invalidJsonValue('arrays with extra properties are unsupported');
  }

  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw invalidJsonValue('sparse arrays are unsupported');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor.enumerable && Object.hasOwn(descriptor, 'value'))) {
      throw invalidJsonValue(
        'non-enumerable array items and accessors are unsupported'
      );
    }
    result.push(copy(descriptor.value));
  }
  return result;
}

function copyObject(value, copy) {
  if (!isPlainObject(value)) {
    throw invalidJsonValue('only plain objects are supported');
  }

  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw invalidJsonValue('symbol keys are unsupported');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor.enumerable && Object.hasOwn(descriptor, 'value'))) {
      throw invalidJsonValue(
        'non-enumerable properties and accessors are unsupported'
      );
    }
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const child = SECRET_FIELD_NAMES.has(normalizedKey)
      ? REDACTION_MARKER
      : copy(descriptor.value);
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: child,
      writable: true,
    });
  }
  return result;
}

/** Return a deterministic, redacted JSON-compatible copy without changing input. */
export function redactSpansValue(value) {
  const ancestors = new Set();

  function copy(current) {
    if (current === null || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'string') {
      return redactText(current);
    }
    if (typeof current === 'number' && Number.isFinite(current)) {
      return current;
    }
    if (typeof current !== 'object') {
      throw invalidJsonValue(`unsupported ${typeof current}`);
    }

    if (ancestors.has(current)) {
      throw new TypeError('redactSpansValue does not accept cyclic values');
    }
    ancestors.add(current);

    try {
      if (Array.isArray(current)) {
        return copyArray(current, copy);
      }
      return copyObject(current, copy);
    } finally {
      ancestors.delete(current);
    }
  }

  return copy(value);
}

const CREDENTIAL_FILENAMES = new Set([
  'auth.json',
  'credentials',
  'credentials.json',
  'application_default_credentials.json',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

/** Pure filename screening only; it does not resolve or inspect the path. */
export function validateSpansSourcePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    return {
      code: 'SOURCE_PATH_INVALID',
      error: 'Source path must be a non-empty string without NUL characters.',
      ok: false,
    };
  }

  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const blocked = segments.some((segment) => {
    const name = segment.toLowerCase();
    return (
      name === '.envrc' ||
      name === '.env' ||
      name.startsWith('.env.') ||
      name === '.ssh' ||
      CREDENTIAL_FILENAMES.has(name) ||
      name.startsWith('.credentials.') ||
      CREDENTIAL_FILENAME.test(name) ||
      name.endsWith('.pem') ||
      name.endsWith('.p12') ||
      name.endsWith('.pfx') ||
      name.endsWith('.key') ||
      name === 'credentials'
    );
  });

  if (blocked) {
    return {
      code: 'CREDENTIAL_SOURCE',
      error: 'Source path names a known credential or private-key location.',
      ok: false,
    };
  }

  return { ok: true };
}
