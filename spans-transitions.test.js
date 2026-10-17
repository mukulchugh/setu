import { expect, test } from 'bun:test';
import {
  evaluateDependencyReadiness,
  validateCoordinatorGeneration,
  validateSpanDependencies,
} from './spans-transitions.js';

function call(name, input) {
  switch (name) {
    case 'evaluateDependencyReadiness':
      return evaluateDependencyReadiness(input);
    case 'validateCoordinatorGeneration':
      return validateCoordinatorGeneration(input);
    case 'validateSpanDependencies':
      return validateSpanDependencies(input);
    default:
      throw new Error(`Unknown transition: ${name}`);
  }
}

test('an empty dependency list is ready', () => {
  expect(
    call('evaluateDependencyReadiness', {
      acceptedCompletions: [],
      dependencies: [],
    })
  ).toEqual({ ok: true, ready: true, waitingFor: [] });
});

test('validates chain and diamond dependency graphs', () => {
  const spans = [
    { dependencies: [], spanId: 'root' },
    { dependencies: ['root'], spanId: 'left' },
    { dependencies: ['root'], spanId: 'right' },
  ];

  expect(
    call('validateSpanDependencies', {
      dependencies: ['left', 'right'],
      spanId: 'leaf',
      spans,
    })
  ).toEqual({ ok: true });
  expect(
    call('validateSpanDependencies', {
      dependencies: ['root'],
      spanId: 'right',
      spans: [
        { dependencies: [], spanId: 'root' },
        { dependencies: ['root'], spanId: 'middle' },
      ],
    })
  ).toEqual({ ok: true });
  expect(
    call('evaluateDependencyReadiness', {
      acceptedCompletions: [
        { spanId: 'left', verified: true },
        { spanId: 'right', verified: true },
      ],
      dependencies: ['left', 'right'],
    })
  ).toEqual({ ok: true, ready: true, waitingFor: [] });
});

test('rejects self and indirect dependency cycles', () => {
  expect(
    call('validateSpanDependencies', {
      dependencies: ['same'],
      spanId: 'same',
      spans: [],
    })
  ).toMatchObject({ code: 'DEPENDENCY_SELF', ok: false });
  expect(
    call('validateSpanDependencies', {
      dependencies: ['second'],
      spanId: 'first',
      spans: [
        { dependencies: ['third'], spanId: 'second' },
        { dependencies: ['first'], spanId: 'third' },
      ],
    })
  ).toMatchObject({ code: 'DEPENDENCY_CYCLE', ok: false });
});

test('rejects duplicate span IDs and missing dependency IDs', () => {
  expect(
    call('validateSpanDependencies', {
      dependencies: [],
      spanId: 'new',
      spans: [
        { dependencies: [], spanId: 'repeated' },
        { dependencies: [], spanId: 'repeated' },
      ],
    })
  ).toMatchObject({ code: 'SPAN_ID_DUPLICATE', ok: false });
  expect(
    call('validateSpanDependencies', {
      dependencies: [],
      spanId: 'already-present',
      spans: [{ dependencies: [], spanId: 'already-present' }],
    })
  ).toMatchObject({ code: 'SPAN_ID_DUPLICATE', ok: false });
  expect(
    call('validateSpanDependencies', {
      dependencies: ['missing'],
      spanId: 'new',
      spans: [],
    })
  ).toMatchObject({ code: 'DEPENDENCY_MISSING', ok: false });
});

test('requires independent verification of every sibling dependency', () => {
  expect(
    call('evaluateDependencyReadiness', {
      acceptedCompletions: [
        { spanId: 'sibling-a', verified: true },
        { spanId: 'sibling-b', verified: false },
      ],
      dependencies: ['sibling-b', 'sibling-a'],
    })
  ).toEqual({
    ok: true,
    ready: false,
    waitingFor: ['sibling-b'],
  });
});

test('waiting dependencies have deterministic order', () => {
  expect(
    call('evaluateDependencyReadiness', {
      acceptedCompletions: [{ spanId: 'mu', verified: true }],
      dependencies: ['zeta', 'alpha', 'mu'],
    })
  ).toEqual({
    ok: true,
    ready: false,
    waitingFor: ['alpha', 'zeta'],
  });
});

test('accepts equal nonnegative safe coordinator generations', () => {
  expect(
    call('validateCoordinatorGeneration', {
      currentGeneration: 0,
      expectedGeneration: 0,
    })
  ).toEqual({ ok: true });
  expect(
    call('validateCoordinatorGeneration', {
      currentGeneration: Number.MAX_SAFE_INTEGER,
      expectedGeneration: Number.MAX_SAFE_INTEGER,
    })
  ).toEqual({ ok: true });
});

test('rejects stale and invalid coordinator generations', () => {
  expect(
    call('validateCoordinatorGeneration', {
      currentGeneration: 4,
      expectedGeneration: 3,
    })
  ).toMatchObject({ code: 'STALE_GENERATION', ok: false });

  for (const [expectedGeneration, currentGeneration] of [
    [-1, 0],
    [0, -1],
    [1.5, 1],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1],
    ['1', 1],
  ]) {
    expect(
      call('validateCoordinatorGeneration', {
        currentGeneration,
        expectedGeneration,
      })
    ).toMatchObject({ code: 'GENERATION_INVALID', ok: false });
  }
});

test('a stale generation cannot change accepted readiness input', () => {
  const acceptedCompletions = [{ spanId: 'child', verified: false }];
  const acceptedBefore = structuredClone(acceptedCompletions);

  // The caller must reject a stale result before it enters this accepted snapshot.
  expect(
    call('validateCoordinatorGeneration', {
      currentGeneration: 6,
      expectedGeneration: 5,
    })
  ).toMatchObject({ code: 'STALE_GENERATION', ok: false });
  expect(
    call('evaluateDependencyReadiness', {
      acceptedCompletions,
      dependencies: ['child'],
    })
  ).toEqual({ ok: true, ready: false, waitingFor: ['child'] });
  expect(acceptedCompletions).toEqual(acceptedBefore);
});

test('dependency and completion validation do not mutate inputs', () => {
  const graphInput = {
    dependencies: ['left', 'right'],
    spanId: 'leaf',
    spans: [
      { dependencies: [], spanId: 'left' },
      { dependencies: [], spanId: 'right' },
    ],
  };
  const completionsInput = {
    acceptedCompletions: [{ spanId: 'left', verified: true }],
    dependencies: ['left', 'right'],
  };
  const graphBefore = structuredClone(graphInput);
  const completionsBefore = structuredClone(completionsInput);

  call('validateSpanDependencies', graphInput);
  call('evaluateDependencyReadiness', completionsInput);

  expect(graphInput).toEqual(graphBefore);
  expect(completionsInput).toEqual(completionsBefore);
});
