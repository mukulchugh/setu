import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSpansPlanningDraft,
  createSpansRequestGuard,
  decodeSpansPlanningCreated,
  decodeSpansWorkflowList,
  decodeSpansWorkflowPreview,
  previewSpansPlanningWorkflow,
  type SpansWorkflowInput,
  serializeSpansWorkflowCreate,
  serializeSpansWorkflowInput,
} from './portal/spans-planning';
import { Button } from './portal/ui/button';
import { createSpansPlanning } from './spans-planning.js';
import { openSpansStore } from './spans-store.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const input: SpansWorkflowInput = {
  owner: 'Mukul',
  runId: 'research-1',
  substitutions: {
    audience: 'Team',
    question: 'What changed?',
    sources: 'Fixture set',
  },
  templateId: 'research.source-review',
  templateVersion: 1,
};

const workflowList = {
  ok: true,
  templates: [
    {
      id: 'research.source-review',
      kind: 'research',
      placeholders: [
        { description: 'Question', maxLength: 320, name: 'question' },
        { description: 'Audience', maxLength: 160, name: 'audience' },
        { description: 'Source set', maxLength: 480, name: 'sources' },
      ],
      spanCount: 5,
      summary: 'Review approved sources.',
      title: 'Source review',
      version: 1,
    },
  ],
};

const previewResponse = {
  acceptance: [
    {
      requirements: ['Criteria are written before sources are read'],
      spanId: 'scope',
    },
  ],
  digest: `sha256:${'a'.repeat(64)}`,
  draft: {
    goal: 'Answer this research question: What changed? (redacted)',
    owner: 'Mukul',
    project: null,
    runId: 'research-1',
    spans: [
      {
        dependencies: [],
        spanId: 'scope',
        title: 'Write the question and criteria',
      },
    ],
    worktree: null,
  },
  ok: true,
  previewOnly: true,
  template: {
    id: 'research.source-review',
    kind: 'research',
    title: 'Source review',
    version: 1,
  },
};

test('workflow list decoder accepts declared templates and rejects unsafe shapes', () => {
  expect(decodeSpansWorkflowList(workflowList)[0]).toMatchObject({
    id: 'research.source-review',
    spanCount: 5,
    version: 1,
  });
  for (const damaged of [
    { ...workflowList, ok: false },
    { ...workflowList, extra: 'not part of the contract' },
    {
      ...workflowList,
      templates: [workflowList.templates[0], workflowList.templates[0]],
    },
    {
      ...workflowList,
      templates: [
        {
          ...workflowList.templates[0],
          placeholders: [{ description: 'x', maxLength: 2, name: 'bad-name' }],
        },
      ],
    },
    {
      ok: true,
      templates: Array.from({ length: 101 }, (_, index) => ({
        ...workflowList.templates[0],
        id: `template-${index}`,
      })),
    },
  ]) {
    expect(() => decodeSpansWorkflowList(damaged)).toThrow(
      'Spans workflows are unavailable. Try again.'
    );
  }
});

test('real catalog preview decodes and exact replay returns the revised current run', () => {
  const root = mkdtempSync(join(tmpdir(), 'spans-planning-client-'));
  const store = openSpansStore({ root });
  try {
    const planning = createSpansPlanning({ store });
    const listed = planning.listWorkflows();
    const templates = decodeSpansWorkflowList(listed);
    const template = templates.find((item) => item.id === input.templateId);
    expect(template).toBeDefined();
    expect(template?.spanCount).toBeGreaterThan(1);

    const actualInput = { ...input, runId: 'workflow-replay-run' };
    const preview = planning.previewWorkflow(actualInput);
    const reviewed = decodeSpansWorkflowPreview(preview, actualInput);
    const originalCreate = { ...actualInput, digest: reviewed.digest };
    const created = planning.createFromWorkflow(originalCreate);
    expect(created.ok).toBe(true);

    const revised = planning.revisePlan({
      expectedGeneration: created.generation,
      expectedRevision: created.revision,
      goal: `${created.run.goal} Revised`,
      runId: actualInput.runId,
      spans: Object.values(created.run.spans).map((span, index) => ({
        dependencies: span.dependencies,
        spanId: span.spanId,
        title: index === 0 ? `${span.title} revised` : span.title,
      })),
    });
    expect(revised.ok).toBe(true);

    const replay = planning.createFromWorkflow(originalCreate);
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      revision: revised.revision,
      run: { planVersion: 2, runId: actualInput.runId, state: 'planned' },
    });
    expect(decodeSpansPlanningCreated(replay, actualInput.runId)).toMatchObject(
      {
        replayed: true,
        revision: revised.revision,
        runId: actualInput.runId,
      }
    );

    const activeReplay = {
      ...replay,
      run: {
        ...replay.run,
        actions: {
          scope: {
            attempt: 1,
            state: 'running',
            updatedAt: '2026-10-16T10:00:00Z',
          },
        },
        checkpoint: 3,
        generation: replay.run.generation + 1,
        spans: {
          ...replay.run.spans,
          scope: {
            ...replay.run.spans.scope,
            attempt: 1,
            startedAt: '2026-10-16T10:00:00Z',
            state: 'running',
          },
        },
        state: 'running',
      },
    };
    expect(
      decodeSpansPlanningCreated(activeReplay, actualInput.runId)
    ).toMatchObject({
      generation: activeReplay.run.generation,
      replayed: true,
      revision: revised.revision,
      runId: actualInput.runId,
    });
    expect(() =>
      decodeSpansPlanningCreated(activeReplay, 'another-run')
    ).toThrow(
      'The planned draft could not be confirmed. Retry this exact save.'
    );
    expect(() =>
      decodeSpansPlanningCreated(
        { ...activeReplay, generation: activeReplay.run.generation + 1 },
        actualInput.runId
      )
    ).toThrow(
      'The planned draft could not be confirmed. Retry this exact save.'
    );
    expect(() =>
      decodeSpansPlanningCreated(
        { ...activeReplay, revision: 0 },
        actualInput.runId
      )
    ).toThrow(
      'The planned draft could not be confirmed. Retry this exact save.'
    );
    expect(() =>
      decodeSpansPlanningCreated(
        {
          ...activeReplay,
          replayed: false,
        },
        actualInput.runId
      )
    ).toThrow(
      'The planned draft could not be confirmed. Retry this exact save.'
    );
  } finally {
    store.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test('preview decoder binds the exact run and template and bounds rendered data', () => {
  expect(decodeSpansWorkflowPreview(previewResponse, input).draft.runId).toBe(
    input.runId
  );
  expect(() =>
    decodeSpansWorkflowPreview(
      {
        ...previewResponse,
        draft: { ...previewResponse.draft, runId: 'other' },
      },
      input
    )
  ).toThrow('Spans preview is unavailable. Review the fields and try again.');
  expect(() =>
    decodeSpansWorkflowPreview(
      {
        ...previewResponse,
        draft: {
          ...previewResponse.draft,
          spans: [
            { dependencies: ['missing'], spanId: 'scope', title: 'Plan' },
          ],
        },
      },
      input
    )
  ).toThrow('Spans preview is unavailable. Review the fields and try again.');
  expect(() =>
    decodeSpansWorkflowPreview(
      { ...previewResponse, digest: 'server detail / private path' },
      input
    )
  ).toThrow('Spans preview is unavailable. Review the fields and try again.');
});

test('serialization omits empty targets and creates from original reviewed inputs plus digest', async () => {
  const withEmptyTargets = { ...input, project: '', worktree: '' };
  expect(serializeSpansWorkflowInput(withEmptyTargets)).toEqual(input);
  const createBody = JSON.parse(
    serializeSpansWorkflowCreate(withEmptyTargets, previewResponse.digest)
  ) as Record<string, unknown>;
  expect(createBody).toEqual({ ...input, digest: previewResponse.digest });
  expect(createBody).not.toHaveProperty('draft');
  expect(createBody).not.toHaveProperty('goal');

  const calls: { body: string; path: string; signal?: AbortSignal | null }[] =
    [];
  globalThis.fetch = ((path: string | URL | Request, init?: RequestInit) => {
    calls.push({
      body: String(init?.body ?? ''),
      path: String(path),
      signal: init?.signal,
    });
    return Promise.resolve(
      Response.json({
        generation: 0,
        ok: true,
        replayed: false,
        revision: 1,
        run: {
          actions: {},
          checkpoint: 0,
          generation: 0,
          goal: 'Research fixture goal',
          owner: input.owner,
          planVersion: 1,
          project: null,
          runId: input.runId,
          spans: {
            scope: {
              dependencies: [],
              spanId: 'scope',
              state: 'planned',
              title: 'Write the question and criteria',
            },
          },
          state: 'planned',
          worktree: null,
        },
      })
    );
  }) as typeof fetch;
  const created = await createSpansPlanningDraft(input, previewResponse.digest);
  expect(created).toMatchObject({
    replayed: false,
    revision: 1,
    runId: input.runId,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe('/api/spans/workflows/create');
  expect(JSON.parse(calls[0].body)).toEqual({
    ...input,
    digest: previewResponse.digest,
  });
});

test('preview requests forward cancellation and validate before returning data', async () => {
  const controller = new AbortController();
  const calls: { body: string; path: string; signal?: AbortSignal | null }[] =
    [];
  globalThis.fetch = ((path: string | URL | Request, init?: RequestInit) => {
    calls.push({
      body: String(init?.body ?? ''),
      path: String(path),
      signal: init?.signal,
    });
    return Promise.resolve(Response.json(previewResponse));
  }) as typeof fetch;
  const result = await previewSpansPlanningWorkflow(input, controller.signal);
  expect(result.previewOnly).toBe(true);
  expect(calls[0].path).toBe('/api/spans/workflows/preview');
  expect(JSON.parse(calls[0].body)).toEqual(input);
  expect(calls[0].signal).toBe(controller.signal);
});

test('request guard aborts prior work and fences late responses after invalidation', () => {
  const guard = createSpansRequestGuard();
  const first = guard.begin();
  const second = guard.begin();
  expect(first.signal.aborted).toBe(true);
  expect(guard.isCurrent(first.ticket)).toBe(false);
  expect(guard.isCurrent(second.ticket)).toBe(true);
  guard.invalidate();
  expect(second.signal.aborted).toBe(true);
  expect(guard.isCurrent(second.ticket)).toBe(false);
});

test('transport and response failures expose fixed safe messages', async () => {
  globalThis.fetch = (() =>
    Promise.reject(new Error('/private/home/session-secret'))) as typeof fetch;
  await expect(
    createSpansPlanningDraft(input, previewResponse.digest)
  ).rejects.toThrow(
    'The Spans planning request may not have completed. Try again.'
  );

  globalThis.fetch = (() =>
    Promise.resolve(
      new Response('provider secret /private/path', { status: 500 })
    )) as typeof fetch;
  await expect(
    createSpansPlanningDraft(input, previewResponse.digest)
  ).rejects.toThrow(
    'The Spans planning request could not be completed. Try again.'
  );

  globalThis.fetch = (() =>
    Promise.resolve(new Response('x'.repeat(128 * 1024 + 1)))) as typeof fetch;
  await expect(
    createSpansPlanningDraft(input, previewResponse.digest)
  ).rejects.toThrow('The Spans planning response was too large. Try again.');
});

test('workflow submit type reaches the Base UI button primitive', () => {
  const button = Button({ children: 'Preview plan', type: 'submit' });
  expect(button.props.type).toBe('submit');
});
