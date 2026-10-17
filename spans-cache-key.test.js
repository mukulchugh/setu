import { describe, expect, test } from 'bun:test';
import { buildSpansCacheKey } from './spans-cache-key.js';

const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function request(overrides = {}) {
  return {
    dependencies: [
      { digest: 'sha256:source-a', id: 'source:readme', kind: 'content' },
      {
        digest: 'sha256:corpus-a',
        generation: 'generation-1',
        id: 'corpus:notes',
        kind: 'corpus',
      },
    ],
    input: { options: { limit: 5, mode: 'exact' }, query: 'find notes' },
    scope: { access: 'read-only', environment: 'local-dev', project: 'setu' },
    versions: { parser: '1', skill: 'summarize-2', tool: 'search-3' },
    ...overrides,
  };
}

function key(overrides) {
  const result = buildSpansCacheKey(request(overrides));
  expect(result.ok).toBe(true);
  return result.key;
}

describe('buildSpansCacheKey', () => {
  test('canonicalizes object keys recursively without changing array order', () => {
    const first = request({
      input: Object.fromEntries([
        ['query', 'q'],
        [
          'options',
          Object.fromEntries([
            ['mode', 'exact'],
            ['limit', 5],
          ]),
        ],
      ]),
    });
    const reordered = request({
      input: Object.fromEntries([
        [
          'options',
          Object.fromEntries([
            ['limit', 5],
            ['mode', 'exact'],
          ]),
        ],
        ['query', 'q'],
      ]),
    });

    expect(buildSpansCacheKey(first).key).toBe(
      buildSpansCacheKey(reordered).key
    );
    expect(key({ input: { sequence: ['first', 'second'] } })).not.toBe(
      key({ input: { sequence: ['second', 'first'] } })
    );
  });

  test('changes when a dirty-file content digest changes', () => {
    const before = [
      { digest: 'sha256:dirty-v1', id: 'file:src/a.js', kind: 'content' },
    ];
    const after = [
      { digest: 'sha256:dirty-v2', id: 'file:src/a.js', kind: 'content' },
    ];

    expect(key({ dependencies: before })).not.toBe(
      key({ dependencies: after })
    );
  });

  test('changes for corpus membership additions or deletions', () => {
    const before = [
      {
        digest: 'sha256:members-a',
        generation: 'g1',
        id: 'corpus:docs',
        kind: 'corpus',
      },
    ];
    const added = [
      {
        digest: 'sha256:members-b',
        generation: 'g2',
        id: 'corpus:docs',
        kind: 'corpus',
      },
    ];
    const deleted = [
      {
        digest: 'sha256:members-c',
        generation: 'g3',
        id: 'corpus:docs',
        kind: 'corpus',
      },
    ];

    expect(key({ dependencies: before })).not.toBe(
      key({ dependencies: added })
    );
    expect(key({ dependencies: added })).not.toBe(
      key({ dependencies: deleted })
    );
  });

  test('changes cached empty-query results when the corpus changes', () => {
    const emptyResultInput = { query: 'no matching records' };
    const oldCorpus = [
      {
        digest: 'sha256:empty-members',
        generation: 0,
        id: 'corpus:archive',
        kind: 'corpus',
      },
    ];
    const newCorpus = [
      {
        digest: 'sha256:one-member',
        generation: 1,
        id: 'corpus:archive',
        kind: 'corpus',
      },
    ];

    expect(key({ dependencies: oldCorpus, input: emptyResultInput })).not.toBe(
      key({ dependencies: newCorpus, input: emptyResultInput })
    );
  });

  test('binds project, environment, access, tool, model and prompt settings', () => {
    const base = request({
      versions: {
        model: { id: 'model-a', temperature: 0 },
        parser: '1',
        prompt: 'prompt-a',
        skill: 'summarize-2',
        tool: 'search-3',
      },
    });
    const variants = [
      { ...base, scope: { ...base.scope, project: 'other-project' } },
      { ...base, scope: { ...base.scope, environment: 'production' } },
      { ...base, scope: { ...base.scope, access: 'restricted' } },
      { ...base, versions: { ...base.versions, tool: 'search-4' } },
      {
        ...base,
        versions: {
          ...base.versions,
          model: { id: 'model-b', temperature: 0 },
        },
      },
      { ...base, versions: { ...base.versions, prompt: 'prompt-b' } },
    ];
    const originalKey = buildSpansCacheKey(base).key;

    for (const variant of variants) {
      expect(buildSpansCacheKey(variant).key).not.toBe(originalKey);
    }
  });

  test('refuses unknown, unreadable and incomplete dependencies', () => {
    for (const dependency of [
      { id: 'source:unknown', kind: 'content', known: false },
      { id: 'source:unreadable', kind: 'content', readable: false },
      {
        complete: false,
        digest: 'sha256:x',
        id: 'source:incomplete',
        kind: 'content',
      },
      { id: 'source:no-digest', kind: 'content' },
      { digest: 'sha256:x', id: 'corpus:no-generation', kind: 'corpus' },
      { digest: 'sha256:x', id: 'source:unsupported', kind: 'arbitrary' },
    ]) {
      const result = buildSpansCacheKey(
        request({ dependencies: [dependency] })
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('DEPENDENCY_INCOMPLETE');
    }
  });

  test('rejects invalid JSON values instead of collapsing them', () => {
    const cycle = {};
    cycle.self = cycle;
    for (const input of [
      { number: Number.NaN },
      { number: Number.POSITIVE_INFINITY },
      { value: undefined },
      { value: () => 'not json' },
      cycle,
    ]) {
      const result = buildSpansCacheKey(request({ input }));
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_JSON_VALUE');
    }
  });

  test('refuses duplicate dependency identifiers', () => {
    const result = buildSpansCacheKey(
      request({
        dependencies: [
          { digest: 'sha256:a', id: 'file:a', kind: 'content' },
          { digest: 'sha256:b', id: 'file:a', kind: 'content' },
        ],
      })
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('DEPENDENCY_ID_DUPLICATE');
  });

  test('sorts dependency manifests by identifier and does not disclose inputs or environment values', () => {
    const result = buildSpansCacheKey(
      request({
        dependencies: [
          { digest: 'sha256:z', id: 'z-last', kind: 'content' },
          { digest: 'sha256:a', id: 'a-first', kind: 'content' },
        ],
        input: { secretSourceText: 'private transcript body' },
        scope: {
          access: 'access-token-like-value',
          environment: 'private-env-value',
          project: 'private-project-value',
        },
      })
    );

    expect(result.manifest.dependencies.map(({ id }) => id)).toEqual([
      'a-first',
      'z-last',
    ]);
    const manifestText = JSON.stringify(result.manifest);
    expect(manifestText).not.toContain('private transcript body');
    expect(manifestText).not.toContain('private-env-value');
    expect(manifestText).not.toContain('access-token-like-value');
    expect(manifestText).not.toContain('private-project-value');
    expect(result.manifest.scope.environmentDigest).toMatch(HEX_DIGEST_PATTERN);
  });

  test('records validity metadata without deriving freshness from the clock', () => {
    const result = buildSpansCacheKey(
      request({
        dependencies: [
          {
            id: 'source:revision',
            kind: 'revision',
            validUntil: '2030-01-01T00:00:00.000Z',
          },
        ],
      })
    );

    expect(result.ok).toBe(true);
    expect(result.manifest.dependencies[0].validUntil).toBe(
      '2030-01-01T00:00:00.000Z'
    );
  });

  test('rejects array properties beyond its actual indexed elements', () => {
    const sequence = [];
    sequence['4294967295'] = 'unserialized value';
    const result = buildSpansCacheKey(request({ input: { sequence } }));

    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_JSON_VALUE');
  });
});
