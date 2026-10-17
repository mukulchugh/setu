import { describe, expect, test } from 'bun:test';
import {
  isSpansRedactionSafeKey,
  redactSpansValue,
  validateSpansSourcePath,
} from './spans-redaction.js';

const REDACTED = '[REDACTED]';
const CYCLIC_ERROR = /cyclic/i;
const JSON_COMPATIBLE_ERROR = /JSON-compatible/i;
const CREDENTIAL_ERROR = /credential|secret|private/i;

test('identifiers used as object keys follow the redaction field policy', () => {
  for (const value of ['api_key', 'Password', 'access-token']) {
    expect(isSpansRedactionSafeKey(value)).toBe(false);
  }
  for (const value of ['span-1', 'action.plan:2', 'review']) {
    expect(isSpansRedactionSafeKey(value)).toBe(true);
  }
  expect(isSpansRedactionSafeKey('api_key=seeded')).toBe(false);
  expect(isSpansRedactionSafeKey(null)).toBe(false);
});

describe('redactSpansValue', () => {
  test('redacts known secret fields recursively in objects and arrays', () => {
    const input = {
      authorization: 'Bearer field-secret',
      nested: [
        { Password: 'pw-secret' },
        {
          APIKey: 'api-secret-variant',
          accessToken: 'access-secret',
          api_key: 'api-secret',
        },
        {
          access_token: 'access-secret-variant',
          private_key: 'private-secret',
          refresh_token: 'refresh-secret',
        },
      ],
    };

    expect(redactSpansValue(input)).toEqual({
      authorization: REDACTED,
      nested: [
        { Password: REDACTED },
        {
          APIKey: REDACTED,
          accessToken: REDACTED,
          api_key: REDACTED,
        },
        {
          access_token: REDACTED,
          private_key: REDACTED,
          refresh_token: REDACTED,
        },
      ],
    });
  });

  test('redacts recognizable bearer, API key, and multiline private key text', () => {
    const input = [
      'Header: Bearer seeded-bearer-token',
      'apiKey = seeded-api-key-1234567890',
      '-----BEGIN RSA PRIVATE KEY-----\nseeded-private-key-body\n-----END RSA PRIVATE KEY-----',
    ];
    const output = redactSpansValue(input);

    expect(output[0]).toBe(`Header: Bearer ${REDACTED}`);
    expect(output[1]).toBe(`apiKey = ${REDACTED}`);
    expect(output[2]).toBe(REDACTED);
  });

  test('redacts quoted secret assignments with spaces and newlines', () => {
    const input = [
      'password="synthetic secret words"',
      "api_key='another seeded\nsecret value'",
      'private_key = "line one\nline two seeded words"',
      'This prose says password matters, and [REDACTED] stays visible.',
    ];
    const output = redactSpansValue(input);

    expect(output).toEqual([
      `password="${REDACTED}"`,
      `api_key='${REDACTED}'`,
      `private_key = "${REDACTED}"`,
      'This prose says password matters, and [REDACTED] stays visible.',
    ]);
    const serialized = JSON.stringify(output);
    for (const seededWord of [
      'synthetic',
      'another seeded',
      'secret value',
      'line one',
      'line two',
    ]) {
      expect(serialized).not.toContain(seededWord);
    }
  });

  test('preserves benign prose and explicit redaction markers', () => {
    const input = {
      earlier: '[REDACTED] and <redacted>',
      message: 'The key idea is to keep the API simple.',
    };

    expect(redactSpansValue(input)).toEqual(input);
  });

  test('is deterministic and leaves the caller object unchanged', () => {
    const input = {
      child: { apiKey: 'secret-value' },
      message: 'Bearer stable-token',
    };
    const before = structuredClone(input);

    const first = redactSpansValue(input);
    const second = redactSpansValue(input);

    expect(first).toEqual(second);
    expect(input).toEqual(before);
    expect(first).not.toBe(input);
    expect(first.child).not.toBe(input.child);
  });

  test('rejects cyclic and unsupported non-JSON values clearly', () => {
    const cyclic = {};
    cyclic.self = cyclic;

    expect(() => redactSpansValue(cyclic)).toThrow(CYCLIC_ERROR);
    expect(() => redactSpansValue({ value: undefined })).toThrow(
      JSON_COMPATIBLE_ERROR
    );
    expect(() => redactSpansValue(new Date())).toThrow(JSON_COMPATIBLE_ERROR);
  });

  test('removes a seeded token from the redacted serialized output', () => {
    const output = JSON.stringify(
      redactSpansValue({
        credentials: { api_key: 'seeded-token-abc' },
        text: 'Authorization: Bearer seeded-token-abc',
      })
    );

    expect(output).not.toContain('seeded-token-abc');
  });
});

describe('validateSpansSourcePath', () => {
  test('rejects .env variants and known credential locations', () => {
    for (const path of [
      '/project/.env',
      '/project/.env.local',
      '/project/.env.production',
      '/home/user/.aws/credentials',
      '/project/credentials/archived/session.json',
      '/home/user/.config/gcloud/application_default_credentials.json',
      '/home/user/.ssh/id_ed25519',
      'C:\\Users\\user\\.ssh\\id_rsa',
      '/project/auth.json',
      '/tmp/.credentials.json',
      '/project/.credentials.production.json',
      '/project/credentials.yaml',
      '/project/credential-file.json',
    ]) {
      const result = validateSpansSourcePath(path);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('CREDENTIAL_SOURCE');
      expect(result.error).toMatch(CREDENTIAL_ERROR);
    }
  });

  test('allows benign filenames and reports successful validation', () => {
    expect(validateSpansSourcePath('/project/session-history.json')).toEqual({
      ok: true,
    });
    expect(validateSpansSourcePath('/project/env-notes.txt')).toEqual({
      ok: true,
    });
    expect(validateSpansSourcePath('/project/credentials-notes.txt')).toEqual({
      ok: true,
    });
  });
});

test('repeated boundary redaction is idempotent for assignments and generic tokens', () => {
  const input = {
    note: 'api_key=synthetic_key token=synthetic_token password="two words"',
    secret: 'private-value',
  };
  const once = redactSpansValue(input);
  expect(once.note).not.toContain('synthetic');
  expect(once.secret).toBe('[REDACTED]');
  expect(redactSpansValue(once)).toEqual(once);
  expect(redactSpansValue(redactSpansValue(once))).toEqual(once);
});
