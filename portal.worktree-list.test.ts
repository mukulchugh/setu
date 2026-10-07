import { describe, expect, test } from 'bun:test';
import {
  commandSelection,
  lifecycleControl,
  projectWorktrees,
  type WorktreeListRow,
  worktreeState,
} from './portal/worktree-list';

const options = {
  ahead: false,
  dirty: false,
  page: 0,
  project: 'all',
  search: '',
  sort: 'name' as const,
};
function row(
  name: string,
  fields: Partial<WorktreeListRow> = {}
): WorktreeListRow {
  return {
    active: false,
    ahead: 0,
    createdAt: null,
    dirty: 0,
    domain: `${name}.local`,
    key: `alpha/${name}`,
    label: 'Alpha',
    lastCommitAt: null,
    name,
    repo: 'alpha',
    ...fields,
  };
}
const operational = [
  row('running', { active: true }),
  row('starting', { starting: true }),
  row('stopping', { active: true, stopping: true }),
  row('queued', { queued: true, queuePosition: 1 }),
];
const stopped = Array.from({ length: 40 }, (_, i) =>
  row(`stopped-${String(i).padStart(2, '0')}`, {
    ahead: i % 3,
    dirty: i % 2,
    repo: 'beta',
  })
);

describe('worktree list scope', () => {
  test('unknown ownership stays global and cannot offer a fresh Start', () => {
    const unknown = row('held', {
      operation: { kind: 'sync', phase: 'unknown' },
    });
    const runtime = row('runtime', { phase: 'unknown', starting: true });
    const result = projectWorktrees([unknown, runtime, ...stopped], {
      ...options,
      project: 'beta',
      search: 'absent',
    });
    expect(result.active.map((w) => w.name)).toEqual(['held', 'runtime']);
    expect(worktreeState(unknown)).toBe('attention');
    expect(lifecycleControl(unknown)).toEqual({
      action: null,
      label: 'Needs attention',
    });
    expect(lifecycleControl(runtime)).toEqual({
      action: 'stop',
      label: 'Retry Stop',
    });
  });
  test('project, dirty, ahead, search and pagination never hide active work', () => {
    for (const filter of [
      { project: 'beta' },
      { dirty: true },
      { ahead: true },
      { search: 'nothing matches' },
      { page: 1 },
      { ahead: true, dirty: true, page: 1, project: 'beta', search: 'stopped' },
    ]) {
      const result = projectWorktrees([...operational, ...stopped], {
        ...options,
        ...filter,
      });
      expect(result.active.map((w) => w.key).sort()).toEqual(
        operational.map((w) => w.key).sort()
      );
    }
  });
  test('stopped results alone are paginated at 18, counted and clamped', () => {
    const second = projectWorktrees([...operational, ...stopped], {
      ...options,
      page: 1,
    });
    expect(second.pageRows).toEqual(stopped.slice(18, 36));
    expect(second.stoppedTotal).toBe(40);
    expect(second.pageCount).toBe(3);
    const shrunk = projectWorktrees([...operational, ...stopped.slice(0, 3)], {
      ...options,
      page: 2,
    });
    expect(shrunk.page).toBe(0);
    expect(shrunk.pageRows).toHaveLength(3);
    const empty = projectWorktrees([...operational, ...stopped], {
      ...options,
      search: 'running',
    });
    expect(empty.stopped).toHaveLength(0);
    expect(empty.active).toHaveLength(4);
  });
  test('state precedence makes overlapping lifecycle flags exclusive', () => {
    expect(
      worktreeState(
        row('a', { active: true, queued: true, starting: true, stopping: true })
      )
    ).toBe('stopping');
    expect(
      worktreeState(row('a', { active: true, queued: true, starting: true }))
    ).toBe('starting');
    expect(worktreeState(row('a', { active: true, queued: true }))).toBe(
      'running'
    );
    expect(worktreeState(row('a', { queued: true }))).toBe('queued');
    expect(worktreeState(row('a'))).toBe('stopped');
  });
  test('active order ignores stopped sort, follows queue position and preserves input', () => {
    const rows = [
      row('q-unknown', { queued: true }),
      row('q-second', { queued: true, queuePosition: 2 }),
      ...operational,
      operational[0],
      ...stopped,
    ];
    const original = rows.slice();
    const first = projectWorktrees(rows, options);
    const recent = projectWorktrees(rows, { ...options, sort: 'recent' });
    expect(first.active).toEqual(recent.active);
    expect(first.active.filter((w) => w.queued).map((w) => w.name)).toEqual([
      'queued',
      'q-second',
      'q-unknown',
    ]);
    expect(
      first.active.filter((w) => w.key === operational[0].key)
    ).toHaveLength(1);
    expect(rows).toEqual(original);
  });
  test('lifecycle command shared by card/detail cancels queued and never restarts stopping work', () => {
    expect(lifecycleControl(row('a', { queued: true }))).toEqual({
      action: 'stop',
      label: 'Cancel queue',
    });
    expect(lifecycleControl(row('a', { starting: true })).action).toBe('stop');
    expect(
      lifecycleControl(row('a', { active: true, stopping: true }))
    ).toEqual({ action: null, label: 'Stopping…' });
    expect(lifecycleControl(row('a', { active: true })).action).toBe('stop');
    expect(lifecycleControl(row('a')).action).toBe('start');
    expect(lifecycleControl(row('a'), true)).toEqual({
      action: null,
      label: 'Starting…',
    });
  });
  test('command selection uses identity through updates, clamps removed matches and searches all rows', () => {
    const a = row('a'),
      b = row('b', { active: true });
    expect(commandSelection([a, b], '', b.key).selected).toBe(b);
    expect(commandSelection([b, a], '', b.key).selected).toBe(b);
    expect(commandSelection([a], '', b.key).selected).toBe(a);
    expect(commandSelection([a, b], 'missing', b.key).selected).toBeUndefined();
    expect(commandSelection([...stopped, b], 'b.local', null).selected).toBe(b);
    const many = commandSelection(stopped, '', null);
    expect(many.results).toHaveLength(8);
    expect(many.matchCount).toBe(40);
  });
});

test('snapshot reconciliation preserves unchanged rows while delivering nested state and order changes', async () => {
  const { reuseWorktreeRows } = await import('./portal/worktree-list');
  const stoppedRow = {
    key: 'repo/stopped',
    active: false,
    sidecars: [{ name: 'worker', active: false }],
  };
  const active = { key: 'repo/active', active: true, memMb: 100, sidecars: [] };
  const previous = [stoppedRow, active];
  expect(
    reuseWorktreeRows(previous, JSON.parse(JSON.stringify(previous)))
  ).toBe(previous);
  const next = reuseWorktreeRows(previous, [
    JSON.parse(JSON.stringify(stoppedRow)),
    { ...active, memMb: 200 },
  ]);
  expect(next[0]).toBe(stoppedRow);
  expect(next[1]).not.toBe(active);
  expect(next[1].memMb).toBe(200);
  const nested = reuseWorktreeRows(previous, [
    { ...stoppedRow, sidecars: [{ name: 'worker', active: true }] },
    active,
  ]);
  expect(nested[0]).not.toBe(stoppedRow);
  expect(nested[0].sidecars[0].active).toBe(true);
  const moved = reuseWorktreeRows(previous, [active, stoppedRow]);
  expect(moved.map((item) => item.key)).toEqual([
    'repo/active',
    'repo/stopped',
  ]);
  expect(moved[1]).toBe(stoppedRow);
  expect(reuseWorktreeRows(previous, [stoppedRow])).toEqual([stoppedRow]);
  expect(previous[0].sidecars[0].active).toBe(false);
});
