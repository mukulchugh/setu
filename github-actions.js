import { createHash } from 'node:crypto';

const failure = (code, error) => ({ code, error, ok: false });
const inputNamePattern = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const workflowPathPattern = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;

function commandError(result, code, error) {
  if (result?.code !== 0 || result?.timedOut || result?.truncated) {
    return failure(code, error);
  }
  return null;
}

function parseJson(result, code, error) {
  const commandFailure = commandError(result, code, error);
  if (commandFailure) {
    return commandFailure;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return failure(code, error);
  }
}

function targetRequest(request) {
  return (
    request &&
    typeof request.repo === 'string' &&
    typeof request.name === 'string'
  );
}

function validInputs(inputs) {
  return (
    inputs &&
    typeof inputs === 'object' &&
    !Array.isArray(inputs) &&
    Object.entries(inputs).every(
      ([key, value]) => inputNamePattern.test(key) && typeof value === 'string'
    )
  );
}

function inputHash(inputs) {
  return createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries(inputs).sort())))
    .digest('hex');
}

function dispatchable(yaml) {
  try {
    const document = Bun.YAML.parse(yaml);
    const trigger = document?.on ?? document?.true;
    return (
      trigger === 'workflow_dispatch' ||
      (Array.isArray(trigger)
        ? trigger.includes('workflow_dispatch')
        : !!(
            trigger &&
            typeof trigger === 'object' &&
            Object.hasOwn(trigger, 'workflow_dispatch')
          ))
    );
  } catch {
    return false;
  }
}

export function createGithubActions({ target, branch, run, readWorkflow }) {
  async function workflowYaml(checkout, path, ref) {
    if (readWorkflow) {
      return readWorkflow(checkout, path, ref);
    }
    const result = await run(
      ['gh', 'workflow', 'view', path, '--yaml', '--ref', ref],
      { cwd: checkout.wtDir }
    );
    if (
      commandError(
        result,
        'GITHUB_WORKFLOW_UNVERIFIED',
        `Could not read workflow ${path} at ${ref}`
      ) ||
      typeof result.stdout !== 'string'
    ) {
      throw new Error('workflow source unavailable');
    }
    return result.stdout;
  }
  async function worktree(request) {
    if (!targetRequest(request)) {
      return failure('INVALID_WORKTREE', 'Select a repository and worktree');
    }
    const checkout = target(request.repo, request.name);
    const ref = await branch(checkout);
    if (!ref) {
      return failure(
        'GITHUB_BRANCH_UNKNOWN',
        'The worktree branch is unavailable'
      );
    }
    return { checkout, ref };
  }

  async function dispatchableWorkflow(context, workflow) {
    if (workflow?.path?.startsWith('dynamic/')) {
      return { kind: 'skip' };
    }
    if (
      workflow?.state !== 'active' ||
      !(typeof workflow.id === 'number' || typeof workflow.id === 'string')
    ) {
      return { kind: 'skip' };
    }
    if (
      !(
        typeof workflow.name === 'string' &&
        typeof workflow.path === 'string' &&
        workflowPathPattern.test(workflow.path)
      )
    ) {
      return {
        kind: 'failure',
        value: failure(
          'GITHUB_WORKFLOWS_UNAVAILABLE',
          'GitHub returned an invalid workflow record'
        ),
      };
    }
    let yaml;
    try {
      yaml = await workflowYaml(context.checkout, workflow.path, context.ref);
    } catch {
      return {
        kind: 'failure',
        value: failure(
          'GITHUB_WORKFLOW_UNVERIFIED',
          `Could not read workflow ${workflow.name} at ${context.ref}`
        ),
      };
    }
    return dispatchable(yaml)
      ? {
          kind: 'workflow',
          value: {
            id: workflow.id,
            name: workflow.name,
            path: workflow.path,
          },
        }
      : { kind: 'skip' };
  }

  async function listWorkflows(request) {
    const context = await worktree(request);
    if (context.ok === false) {
      return context;
    }
    const listed = parseJson(
      await run(
        ['gh', 'workflow', 'list', '--all', '--json', 'id,name,state,path'],
        { cwd: context.checkout.wtDir }
      ),
      'GITHUB_WORKFLOWS_UNAVAILABLE',
      'GitHub could not list workflows for this worktree'
    );
    if (!Array.isArray(listed)) {
      return listed?.ok === false
        ? listed
        : failure(
            'GITHUB_WORKFLOWS_UNAVAILABLE',
            'GitHub returned an invalid workflow list'
          );
    }
    const workflows = [];
    for (const workflow of listed) {
      // biome-ignore lint/performance/noAwaitInLoops: Workflow source checks retain CLI list order and stop at the first unverifiable workflow.
      const resolved = await dispatchableWorkflow(context, workflow);
      if (resolved.kind === 'failure') {
        return resolved.value;
      }
      if (resolved.kind === 'workflow') {
        workflows.push(resolved.value);
      }
    }
    return { ok: true, workflows };
  }

  async function listRuns(request) {
    const context = await worktree(request);
    if (context.ok === false) {
      return context;
    }
    const runs = parseJson(
      await run(
        [
          'gh',
          'run',
          'list',
          '--branch',
          context.ref,
          '--limit',
          '20',
          '--json',
          'databaseId,workflowName,status,conclusion,url,headBranch,createdAt,displayTitle,event',
        ],
        { cwd: context.checkout.wtDir }
      ),
      'GITHUB_RUNS_UNAVAILABLE',
      'GitHub could not list workflow runs for this worktree branch'
    );
    if (
      !(
        Array.isArray(runs) &&
        runs.every(
          (row) =>
            row &&
            typeof row === 'object' &&
            (typeof row.databaseId === 'number' ||
              typeof row.databaseId === 'string') &&
            typeof row.status === 'string' &&
            row.headBranch === context.ref
        )
      )
    ) {
      return failure(
        'GITHUB_RUNS_UNAVAILABLE',
        'GitHub returned an invalid run list'
      );
    }
    return { ok: true, runs };
  }

  async function dispatch(request) {
    if (
      !(
        typeof request?.workflow === 'string' &&
        request.workflow &&
        typeof request.ref === 'string' &&
        request.ref &&
        validInputs(request.inputs)
      )
    ) {
      return failure(
        'INVALID_GITHUB_DISPATCH',
        'Select a workflow, ref, and explicit string inputs'
      );
    }
    const confirmation = {
      inputsHash: inputHash(request.inputs),
      ref: request.ref,
      token: `workflow:${request.workflow};ref:${request.ref};inputs:${inputHash(request.inputs)}`,
      workflow: request.workflow,
    };
    if (request.confirmation !== confirmation.token) {
      return {
        ...failure(
          'GITHUB_DISPATCH_CONFIRMATION_REQUIRED',
          'Review this workflow, ref, and inputs before dispatching'
        ),
        confirmation,
      };
    }
    const available = await listWorkflows(request);
    if (!available.ok) {
      return available;
    }
    if (
      !available.workflows.some(
        (workflow) =>
          String(workflow.id) === request.workflow ||
          workflow.path === request.workflow
      )
    ) {
      return failure(
        'GITHUB_WORKFLOW_UNVERIFIED',
        'The selected workflow is not dispatchable for this worktree'
      );
    }
    const context = await worktree(request);
    if (context.ok === false) {
      return context;
    }
    if (context.ref !== request.ref) {
      return failure(
        'GITHUB_DISPATCH_REF_UNVERIFIED',
        'Dispatch ref must be this worktree branch'
      );
    }
    const result = await run(
      [
        'gh',
        'workflow',
        'run',
        request.workflow,
        '--ref',
        request.ref,
        ...Object.entries(request.inputs).flatMap(([key, value]) => [
          '--raw-field',
          `${key}=${value}`,
        ]),
      ],
      { cwd: context.checkout.wtDir }
    );
    const failed = commandError(
      result,
      'GITHUB_DISPATCH_FAILED',
      'GitHub did not accept the workflow dispatch'
    );
    if (failed) {
      return failed;
    }
    return {
      deploymentApprovalRequired: true,
      dispatched: true,
      message:
        'Workflow dispatch is not a deployment approval. Confirm any deployment separately.',
      ok: true,
      ref: request.ref,
      workflow: request.workflow,
    };
  }
  return Object.freeze({ dispatch, listRuns, listWorkflows });
}
