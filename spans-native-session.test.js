import { describe, expect, test } from 'bun:test';
import {
  createNativeSessionObserver,
  MAX_NATIVE_SESSION_LINE_BYTES,
} from './spans-native-session.js';

const CLAUDE_INIT = Object.freeze({
  cwd: '/tmp/setu-native-session-fixture',
  model: 'claude-sonnet-4-5-20250929',
  permissionMode: 'default',
  session_id: 'claude-session-fixture-001',
  subtype: 'init',
  tools: Object.freeze(['Read', 'Edit', 'Write']),
  type: 'system',
});

const CLAUDE_RESULT = Object.freeze({
  is_error: false,
  result: 'fixture response',
  session_id: 'claude-session-fixture-002',
  subtype: 'success',
  total_cost_usd: 0.01,
  type: 'result',
});

const ndjson = (event) => `${JSON.stringify(event)}\n`;

describe('native session stdout observer', () => {
  test('observes a Claude init session ID once from NDJSON', () => {
    const observer = createNativeSessionObserver();

    expect(observer.push(ndjson(CLAUDE_INIT))).toBe(CLAUDE_INIT.session_id);
    expect(observer.push(ndjson(CLAUDE_RESULT))).toBeNull();
    expect(observer.finish()).toBeNull();
  });

  test('accepts arbitrary text pieces after the caller decodes split UTF-8', () => {
    const observer = createNativeSessionObserver();
    const event = Object.freeze({
      ...CLAUDE_INIT,
      cwd: '/tmp/résumé/工作',
      session_id: 'claude-session-utf8-fixture',
    });
    const bytes = new TextEncoder().encode(ndjson(event));
    const decoder = new TextDecoder();
    let result = null;

    for (let offset = 0; offset < bytes.length; offset += 1) {
      const text = decoder.decode(bytes.subarray(offset, offset + 1), {
        stream: true,
      });
      result = observer.push(text) ?? result;
    }
    result = observer.push(decoder.decode()) ?? result;

    expect(result).toBe(event.session_id);
    expect(observer.available).toBe(true);
  });

  test('ignores malformed, null, primitive, array, and invalid ID records', () => {
    const observer = createNativeSessionObserver();
    const invalidEvents = [
      'not-json\n',
      'null\n',
      '42\n',
      'true\n',
      '[]\n',
      `${JSON.stringify({ session_id: null })}\n`,
      `${JSON.stringify({ session_id: '' })}\n`,
      `${JSON.stringify({ session_id: ' leading-space' })}\n`,
      `${JSON.stringify({ session_id: 'control\u0001id' })}\n`,
      `${JSON.stringify({ session_id: '__proto__' })}\n`,
      `${JSON.stringify({ session_id: 'sk-proj-12345678901234567890' })}\n`,
      `${JSON.stringify({ session_id: 'x'.repeat(257) })}\n`,
    ].join('');

    expect(observer.push(invalidEvents)).toBeNull();
    expect(observer.push(ndjson(CLAUDE_INIT))).toBe(CLAUDE_INIT.session_id);
  });

  test('skips a UTF-8 oversized line through its newline and sees the next line', () => {
    const observer = createNativeSessionObserver();
    const oversized = JSON.stringify({
      extra: 'é'.repeat(MAX_NATIVE_SESSION_LINE_BYTES / 2),
      session_id: 'must-not-be-observed',
    });
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(
      MAX_NATIVE_SESSION_LINE_BYTES
    );
    expect(oversized.length).toBeLessThan(MAX_NATIVE_SESSION_LINE_BYTES);

    expect(observer.push(`${oversized}\n${ndjson(CLAUDE_INIT)}`)).toBe(
      CLAUDE_INIT.session_id
    );
  });

  test('checks a final unterminated JSON line on finish', () => {
    const observer = createNativeSessionObserver();
    const record = JSON.stringify(CLAUDE_INIT);

    expect(observer.push(record.slice(0, 17))).toBeNull();
    expect(observer.push(record.slice(17))).toBeNull();
    expect(observer.finish()).toBe(CLAUDE_INIT.session_id);
    expect(observer.finish()).toBeNull();
    expect(observer.push(ndjson(CLAUDE_RESULT))).toBeNull();
  });

  test('returns only the first supported ID when records compete', () => {
    const observer = createNativeSessionObserver();
    const first = ndjson(CLAUDE_INIT);
    const second = ndjson(CLAUDE_RESULT);

    expect(observer.push(first.slice(0, 9))).toBeNull();
    expect(observer.push(first.slice(9) + second)).toBe(CLAUDE_INIT.session_id);
    expect(observer.finish()).toBeNull();
  });

  test('marks an invalid input unavailable without throwing', () => {
    const observer = createNativeSessionObserver();

    expect(observer.push(null)).toBeNull();
    expect(observer.available).toBe(false);
    expect(observer.push(ndjson(CLAUDE_INIT))).toBeNull();
    expect(observer.finish()).toBeNull();
  });
});
