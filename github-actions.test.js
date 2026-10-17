import { expect, test } from 'bun:test';
import { createGithubActions } from './github-actions.js';

function asPromise(callback) {
  try {
    return Promise.resolve(callback());
  } catch (error) {
    return Promise.reject(error);
  }
}

function fixture() {
  const calls = [];
  const actions = createGithubActions({
    branch: async () => 'feature/review',
    run: (argv, options) =>
      asPromise(() => {
        calls.push({ argv, options });
        if (argv.slice(1, 3).join(' ') === 'workflow list') {
          return {
            code: 0,
            stdout: JSON.stringify([
              {
                id: 12,
                name: 'Tests',
                path: '.github/workflows/tests.yml',
                state: 'active',
              },
              {
                id: 13,
                name: 'Dormant',
                path: '.github/workflows/old.yml',
                state: 'disabled_manually',
              },
            ]),
          };
        }
        if (argv.slice(1, 3).join(' ') === 'run list') {
          return {
            code: 0,
            stdout: JSON.stringify([
              {
                databaseId: 100,
                headBranch: 'feature/review',
                status: 'completed',
              },
            ]),
          };
        }
        if (argv.slice(1, 3).join(' ') === 'workflow view') {
          return {
            code: 0,
            stdout: argv.some((part) => part.includes('tests.yml'))
              ? 'on: [push, workflow_dispatch]\n'
              : 'on: push\n',
          };
        }
        if (argv.slice(1, 3).join(' ') === 'workflow run') {
          return { code: 0, stdout: '' };
        }
        throw new Error(`unexpected command ${argv.join(' ')}`);
      }),
    target: () => ({ wtDir: '/worktrees/repo/feature-review' }),
  });
  return { actions, calls };
}

test('GitHub Actions lists dispatchable workflows and runs for the worktree branch', async () => {
  const { actions, calls } = fixture();
  expect(
    await actions.listWorkflows({ name: 'feature/review', repo: 'repo' })
  ).toEqual({
    ok: true,
    workflows: [{ id: 12, name: 'Tests', path: '.github/workflows/tests.yml' }],
  });
  expect(
    await actions.listRuns({ name: 'feature/review', repo: 'repo' })
  ).toMatchObject({
    ok: true,
    runs: [{ databaseId: 100, headBranch: 'feature/review' }],
  });
  expect(calls.at(-1).argv).toContain('--branch');
  expect(calls.at(-1).argv).toContain('feature/review');
  expect(
    calls.some(
      ({ argv }) =>
        argv.join(' ') ===
        'gh workflow view .github/workflows/tests.yml --yaml --ref feature/review'
    )
  ).toBeTrue();
});

test('GitHub workflow dispatch requires exact workflow/ref confirmation and explicit inputs', async () => {
  const { actions, calls } = fixture();
  const request = {
    inputs: { suite: 'unit' },
    name: 'feature/review',
    ref: 'feature/review',
    repo: 'repo',
    workflow: '12',
  };
  expect(await actions.dispatch(request)).toMatchObject({
    code: 'GITHUB_DISPATCH_CONFIRMATION_REQUIRED',
    ok: false,
  });
  expect(calls).toHaveLength(0);
  const preflight = await actions.dispatch(request);
  expect(preflight.confirmation).toMatchObject({
    ref: 'feature/review',
    workflow: '12',
  });
  expect(
    await actions.dispatch({
      ...request,
      confirmation: preflight.confirmation.token,
    })
  ).toMatchObject({
    deploymentApprovalRequired: true,
    dispatched: true,
    ok: true,
  });
  expect(calls.at(-1).argv).toEqual([
    'gh',
    'workflow',
    'run',
    '12',
    '--ref',
    'feature/review',
    '--raw-field',
    'suite=unit',
  ]);
});

test('GitHub Actions parses inline workflow dispatch syntax and rejects malformed API data', async () => {
  const calls = [];
  const actions = createGithubActions({
    branch: async () => 'topic',
    run: (argv) =>
      asPromise(() => {
        calls.push(argv);
        if (argv.slice(1, 3).join(' ') === 'workflow list') {
          return {
            code: 0,
            stdout: JSON.stringify([
              {
                id: 1,
                name: 'Inline map',
                path: '.github/workflows/inline.yml',
                state: 'active',
              },
              {
                id: 2,
                name: 'Scalar',
                path: '.github/workflows/scalar.yml',
                state: 'active',
              },
            ]),
          };
        }
        if (argv.some((part) => part.includes('inline.yml'))) {
          return { code: 0, stdout: 'on: { workflow_dispatch: {} }\n' };
        }
        if (argv.some((part) => part.includes('scalar.yml'))) {
          return { code: 0, stdout: 'on: workflow_dispatch\n' };
        }
        throw new Error(`unexpected command ${argv.join(' ')}`);
      }),
    target: () => ({ wtDir: '/fixture' }),
  });
  expect(
    await actions.listWorkflows({ name: 'topic', repo: 'repo' })
  ).toMatchObject({ ok: true, workflows: [{ id: 1 }, { id: 2 }] });
  expect(
    calls
      .filter((argv) => argv.slice(1, 3).join(' ') === 'workflow view')
      .every((argv) => argv.includes('--ref') && argv.includes('topic'))
  ).toBeTrue();
  const invalid = createGithubActions({
    branch: async () => 'topic',
    run: async () => ({ code: 0, stdout: 'null' }),
    target: () => ({ wtDir: '/fixture' }),
  });
  expect(
    await invalid.listWorkflows({ name: 'topic', repo: 'repo' })
  ).toMatchObject({ code: 'GITHUB_WORKFLOWS_UNAVAILABLE', ok: false });
});

test.each([
  { id: null },
  { id: undefined },
  { id: true },
  { id: {} },
  { id: [] },
])('workflow rows without a usable id stay skipped: %#', async ({ id }) => {
  const calls = [];
  const workflow = {
    id: 12,
    name: 'Tests',
    path: '.github/workflows/tests.yml',
    state: 'active',
  };
  const actions = createGithubActions({
    branch: () => Promise.resolve('topic'),
    run: (argv) => {
      calls.push(argv);
      return Promise.resolve({
        code: 0,
        stdout:
          argv[2] === 'list'
            ? JSON.stringify([{ id, state: 'active' }, workflow])
            : 'on: workflow_dispatch\n',
      });
    },
    target: () => ({ wtDir: '/fixture' }),
  });
  expect(await actions.listWorkflows({ name: 'topic', repo: 'repo' })).toEqual({
    ok: true,
    workflows: [{ id: 12, name: 'Tests', path: '.github/workflows/tests.yml' }],
  });
  expect(calls.filter((argv) => argv[2] === 'view')).toEqual([
    ['gh', 'workflow', 'view', workflow.path, '--yaml', '--ref', 'topic'],
  ]);
});
