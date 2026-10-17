import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansDrafts } from './spans-drafts.js';
import { openSpansStore } from './spans-store.js';

const roots = new Set();

afterEach(() => {
  for (const root of roots) {
    fs.rmSync(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-spans-drafts-'));
  roots.add(root);
  const store = openSpansStore({ root });
  return { drafts: createSpansDrafts({ store }), root, store };
}

function draft(runId = 'run-draft-1', overrides = {}) {
  return {
    goal: 'Prepare the offline implementation',
    owner: 'codex',
    runId,
    spans: [
      { dependencies: [], spanId: 'plan', title: 'Plan the work' },
      { dependencies: ['plan'], spanId: 'review', title: 'Review the work' },
    ],
    ...overrides,
  };
}

describe('offline Spans drafts', () => {
  test('creates a planned run in a temporary non-Git root', () => {
    const { drafts, root, store } = fixture();
    try {
      expect(fs.existsSync(join(root, '.git'))).toBe(false);
      const input = draft('no-git-run', {
        project: 'quivly-app',
        worktree: '/unused/inert/descriptor',
      });
      const result = drafts.createRun(input);
      expect(result.ok).toBe(true);
      expect(result.run).toEqual({
        actions: {},
        checkpoint: 0,
        generation: 0,
        goal: input.goal,
        owner: input.owner,
        planVersion: 1,
        project: input.project,
        runId: 'no-git-run',
        spans: {
          plan: {
            dependencies: [],
            spanId: 'plan',
            state: 'planned',
            title: 'Plan the work',
          },
          review: {
            dependencies: ['plan'],
            spanId: 'review',
            state: 'planned',
            title: 'Review the work',
          },
        },
        state: 'planned',
        worktree: input.worktree,
      });
      expect(fs.existsSync(join(root, '.git'))).toBe(false);
      const events = store.readEvents({ runId: 'no-git-run' });
      expect(events.events).toHaveLength(1);
      expect(events.events[0].type).toBe('spans.plan.created');
    } finally {
      store.close();
    }
  });

  test('refuses duplicate IDs, missing edges, self edges, and cycles', () => {
    const { drafts, store } = fixture();
    try {
      expect(
        drafts.createRun(
          draft('duplicate-id', {
            spans: [
              { dependencies: [], spanId: 'same', title: 'One' },
              { dependencies: [], spanId: 'same', title: 'Two' },
            ],
          })
        ).ok
      ).toBe(false);
      expect(
        drafts.createRun(
          draft('missing-edge', {
            spans: [{ dependencies: ['absent'], spanId: 'one', title: 'One' }],
          })
        ).code
      ).toBe('SPANS_DRAFT_DEPENDENCY_MISSING');
      expect(
        drafts.createRun(
          draft('self-edge', {
            spans: [{ dependencies: ['one'], spanId: 'one', title: 'One' }],
          })
        ).code
      ).toBe('SPANS_DRAFT_DEPENDENCY_SELF');
      expect(
        drafts.createRun(
          draft('cycle', {
            spans: [
              { dependencies: ['two'], spanId: 'one', title: 'One' },
              { dependencies: ['one'], spanId: 'two', title: 'Two' },
            ],
          })
        ).code
      ).toBe('SPANS_DRAFT_DEPENDENCY_CYCLE');
      expect(store.listRuns().runs).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('bounds span titles and dependencies and rejects repeated edges', () => {
    const { drafts, store } = fixture();
    try {
      expect(
        drafts.createRun(
          draft('long-title', {
            spans: [
              { dependencies: [], spanId: 'one', title: 'x'.repeat(16_001) },
            ],
          })
        ).ok
      ).toBe(false);
      expect(
        drafts.createRun(
          draft('long-dependencies', {
            spans: [
              {
                dependencies: Array.from(
                  { length: 201 },
                  (_, index) => `dep-${index}`
                ),
                spanId: 'one',
                title: 'One',
              },
            ],
          })
        ).ok
      ).toBe(false);
      expect(
        drafts.createRun(
          draft('duplicate-dependency', {
            spans: [
              { dependencies: [], spanId: 'one', title: 'One' },
              { dependencies: ['one', 'one'], spanId: 'two', title: 'Two' },
            ],
          })
        ).ok
      ).toBe(false);
      expect(store.listRuns().runs).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('redacts text before both the model view and event are persisted', () => {
    const { drafts, store } = fixture();
    try {
      const secret = 'sk-proj-abcdefghijklmnop';
      const result = drafts.createRun(
        draft('redacted-run', {
          goal: `Use api_key="${secret}" for the fixture`,
          spans: [
            { dependencies: [], spanId: 'one', title: `password=${secret}` },
          ],
        })
      );
      expect(result.ok).toBe(true);
      expect(result.run.goal).not.toContain(secret);
      expect(result.run.spans.one.title).not.toContain(secret);
      const [event] = store.readEvents({ runId: 'redacted-run' }).events;
      expect(JSON.stringify(event.payload)).not.toContain(secret);
      expect(event.payload.goal).toContain('[REDACTED]');
    } finally {
      store.close();
    }
  });

  test('replays an identical initial draft and conflicts on changed input', () => {
    const { drafts, store } = fixture();
    try {
      const input = draft('replay-run');
      const first = drafts.createRun(input);
      const replay = drafts.createRun(input);
      expect(replay.ok).toBe(true);
      expect(replay.replayed).toBe(true);
      expect(replay.revision).toBe(first.revision);
      expect(
        drafts.createRun(
          draft('replay-run', {
            goal: 'A different goal',
          })
        )
      ).toMatchObject({
        code: 'SPANS_DRAFT_CONFLICT',
        ok: false,
      });
      expect(store.readEvents({ runId: 'replay-run' }).events).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test('revises with CAS, keeps earlier events, and rejects competing stale revise', () => {
    const { drafts, store } = fixture();
    try {
      drafts.createRun(draft('revision-run'));
      const revised = drafts.revisePlan({
        expectedGeneration: 0,
        expectedRevision: 1,
        goal: 'Review an updated plan',
        runId: 'revision-run',
        spans: [{ dependencies: [], spanId: 'updated', title: 'Updated span' }],
      });
      expect(revised).toMatchObject({
        generation: 1,
        ok: true,
        planVersion: 2,
        revision: 2,
      });
      expect(
        drafts.revisePlan({
          expectedGeneration: 0,
          expectedRevision: 1,
          goal: 'Competing plan',
          runId: 'revision-run',
          spans: [{ dependencies: [], spanId: 'other', title: 'Other span' }],
        })
      ).toMatchObject({ code: 'SPANS_DRAFT_STALE', ok: false });
      const events = store.readEvents({ runId: 'revision-run' });
      expect(events.events.map((event) => event.type)).toEqual([
        'spans.plan.created',
        'spans.plan.revised',
      ]);
      expect(events.events[0].payload.goal).toBe(
        'Prepare the offline implementation'
      );
      expect(store.readRun({ runId: 'revision-run' }).view.goal).toBe(
        'Review an updated plan'
      );
    } finally {
      store.close();
    }
  });

  test('refuses plan edits after an action record exists', () => {
    const { drafts, store } = fixture();
    try {
      drafts.createRun(draft('actions-run'));
      const current = store.readRun({ runId: 'actions-run' });
      const view = {
        ...current.view,
        actions: { 'action-1': { state: 'intent' } },
      };
      expect(
        store.commitRun({
          events: [],
          expectedGeneration: current.generation,
          expectedRevision: current.revision,
          runId: 'actions-run',
          view,
        }).ok
      ).toBe(true);
      expect(
        drafts.revisePlan({
          expectedGeneration: 0,
          expectedRevision: 2,
          goal: 'Change after action intent',
          runId: 'actions-run',
          spans: [{ dependencies: [], spanId: 'new', title: 'New span' }],
        })
      ).toMatchObject({ code: 'SPANS_DRAFT_ACTIONS_EXIST', ok: false });
    } finally {
      store.close();
    }
  });
});
