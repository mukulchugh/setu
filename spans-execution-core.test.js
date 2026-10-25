import { afterEach, describe, expect, test } from 'bun:test';
import {
  createExecutionFixture,
  PROFILE,
  TARGET,
} from './spans-execution.test-support.js';
import { exactRequest } from './spans-execution-core.js';

let fixture;

afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

describe('exactRequest public boundary', () => {
  test('accepts JSON-shaped requests and copies bounded arrays', () => {
    const artifactIds = Array.from(
      { length: 64 },
      (_, index) => `artifact-${index}`
    );
    const criteria = ['Check the captured output.'];
    const input = Object.assign(Object.create(null), {
      artifactIds,
      criteria,
      generation: 1,
      optional: undefined,
      outcome: 'completed',
      runId: 'run-1',
    });

    const result = exactRequest(
      input,
      ['generation', 'outcome', 'runId'],
      ['artifactIds', 'criteria', 'optional']
    );

    expect(result).toEqual({
      artifactIds,
      criteria,
      generation: 1,
      outcome: 'completed',
      runId: 'run-1',
    });
    expect(result.artifactIds).not.toBe(artifactIds);
    expect(result.criteria).not.toBe(criteria);
    expect(Object.getPrototypeOf(result.artifactIds)).toBe(Array.prototype);
    expect(Object.hasOwn(result, 'optional')).toBe(false);
    expect(exactRequest({ runId: 'run-2' }, ['runId'])).toEqual({
      runId: 'run-2',
    });
  });

  test('refuses outer proxies without running traps and handles revoked proxies', () => {
    let traps = 0;
    const hostile = new Proxy(
      { runId: 'run-1' },
      {
        get() {
          traps += 1;
          throw new Error('get');
        },
        getOwnPropertyDescriptor() {
          traps += 1;
          throw new Error('descriptor');
        },
        getPrototypeOf() {
          traps += 1;
          throw new Error('getPrototypeOf');
        },
        ownKeys() {
          traps += 1;
          throw new Error('ownKeys');
        },
      }
    );
    const revoked = Proxy.revocable({ runId: 'run-1' }, {});
    revoked.revoke();

    expect(() => exactRequest(hostile, ['runId'])).not.toThrow();
    expect(exactRequest(hostile, ['runId'])).toBeNull();
    expect(() => exactRequest(revoked.proxy, ['runId'])).not.toThrow();
    expect(exactRequest(revoked.proxy, ['runId'])).toBeNull();
    expect(traps).toBe(0);
  });

  test('refuses accessor properties and unknown or symbol keys without invoking them', () => {
    let getterCalls = 0;
    const accessor = { runId: 'run-1' };
    Object.defineProperty(accessor, 'extra', {
      enumerable: true,
      get() {
        getterCalls += 1;
      },
    });
    const symbolKey = { runId: 'run-1', [Symbol('extra')]: true };

    expect(exactRequest(accessor, ['runId'])).toBeNull();
    expect(exactRequest(symbolKey, ['runId'])).toBeNull();
    expect(getterCalls).toBe(0);
  });

  test('rejects hostile, accessor, sparse, extended and over-limit arrays without callbacks', () => {
    let traps = 0;
    let callbacks = 0;
    const proxyArray = new Proxy(['criterion'], {
      get() {
        traps += 1;
        throw new Error('get');
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error('getPrototypeOf');
      },
      ownKeys() {
        traps += 1;
        throw new Error('ownKeys');
      },
    });
    const revokedArray = Proxy.revocable(['criterion'], {});
    revokedArray.revoke();
    const indexGetter = [];
    Object.defineProperty(indexGetter, '0', {
      enumerable: true,
      get() {
        callbacks += 1;
        return 'criterion';
      },
    });
    indexGetter.length = 1;
    const customEvery = ['criterion'];
    Object.defineProperty(customEvery, 'every', {
      value() {
        callbacks += 1;
        return true;
      },
    });
    const customPrototype = Object.create(Array.prototype);
    customPrototype.every = () => {
      callbacks += 1;
      return true;
    };
    const customProtoArray = Object.setPrototypeOf(
      ['criterion'],
      customPrototype
    );
    const sparse = [];
    sparse.length = 1;
    const extra = ['criterion'];
    extra.extra = true;
    const symbol = ['criterion'];
    symbol[Symbol('extra')] = true;
    const tooLong = Array.from({ length: 65 }, () => 'criterion');
    const hostileItem = {
      toString() {
        callbacks += 1;
        return 'criterion';
      },
    };

    for (const criteria of [
      proxyArray,
      revokedArray.proxy,
      indexGetter,
      customEvery,
      customProtoArray,
      sparse,
      extra,
      symbol,
      tooLong,
      [hostileItem],
      [null],
      [1],
    ]) {
      expect(() => exactRequest({ criteria }, [], ['criteria'])).not.toThrow();
      expect(exactRequest({ criteria }, [], ['criteria'])).toBeNull();
    }
    expect(traps).toBe(0);
    expect(callbacks).toBe(0);
  });

  test('service review refuses invalid criteria before admission or provider activity', async () => {
    fixture = createExecutionFixture();
    let getterCalls = 0;
    let admissionCalls = 0;
    const admission = new Proxy(
      { ...fixture.admission },
      {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === 'status') {
            return (...args) => {
              admissionCalls += 1;
              return value.apply(target, args);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }
    );
    const service = fixture.createService({ admission });
    const criteria = [];
    Object.defineProperty(criteria, '0', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'should not be read';
      },
    });
    criteria.length = 1;

    const result = await service.review({
      criteria,
      instructions: 'Review this change.',
      profile: PROFILE,
      runId: 'run-1',
      spanId: 'build',
      target: TARGET,
      wallClockMs: 30_000,
    });

    expect(result).toMatchObject({
      code: 'SPANS_EXEC_REQUEST_INVALID',
      ok: false,
    });
    expect(getterCalls).toBe(0);
    expect(admissionCalls).toBe(0);
    expect(fixture.providerPids()).toEqual([]);
  });

  test('service report refuses artifact index getters before reading them', async () => {
    fixture = createExecutionFixture();
    const service = fixture.createService();
    let getterCalls = 0;
    const artifactIds = [];
    Object.defineProperty(artifactIds, '0', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'artifact-1';
      },
    });
    artifactIds.length = 1;

    const result = await service.report({
      actionId: 'action-1',
      artifactIds,
      generation: 0,
      outcome: 'completed',
      runId: 'run-1',
    });

    expect(result).toMatchObject({
      code: 'SPANS_EXEC_REQUEST_INVALID',
      ok: false,
    });
    expect(getterCalls).toBe(0);
    expect(fixture.providerPids()).toEqual([]);
  });
});
