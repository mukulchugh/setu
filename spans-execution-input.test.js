import { describe, expect, test } from 'bun:test';
import { hashArtifact } from './spans-artifacts.js';
import {
  buildSpansExecutionInput,
  SPANS_EXECUTION_INPUT_MEDIA_TYPE,
} from './spans-execution-input.js';

const selector = (spanId = 'verify') => ({
  actionId: 'action-1',
  attemptId: 'attempt-1',
  generation: 0,
  planVersion: 1,
  runId: 'run-1',
  spanId,
});

function runWith(spans, extraView = {}) {
  const view = {
    generation: 0,
    goal: 'Ship the fixture',
    planVersion: 1,
    runId: 'run-1',
    spans,
    ...extraView,
  };
  return { generation: 0, ok: true, view };
}

describe('buildSpansExecutionInput', () => {
  test('keeps accepted dependency evidence in the canonical per-span context', () => {
    const result = buildSpansExecutionInput({
      run: runWith(
        {
          build: {
            acceptedActionId: 'action-build',
            acceptedCheckpoint: 2,
            acceptedEvidenceId: 'evidence-build',
            dependencies: [],
            spanId: 'build',
            state: 'completed',
            title: 'Build',
          },
          verify: {
            dependencies: ['build'],
            spanId: 'verify',
            title: 'Verify',
          },
        },
        {
          actions: {
            'action-build': {
              actionId: 'action-build',
              outcomeArtifactIds: ['artifact-build'],
              spanId: 'build',
              state: 'completed',
            },
          },
        }
      ),
      selector: selector(),
    });

    expect(result.ok).toBe(true);
    const context = JSON.parse(result.text);
    expect(context.dependencyEvidence).toEqual([
      {
        acceptedActionId: 'action-build',
        acceptedCheckpoint: 2,
        acceptedEvidenceId: 'evidence-build',
        artifactIds: ['artifact-build'],
        spanId: 'build',
        state: 'completed',
        title: 'Build',
      },
    ]);
    expect(result).toMatchObject({
      artifactId: `sha256:${hashArtifact(SPANS_EXECUTION_INPUT_MEDIA_TYPE, result.text)}`,
      mediaType: SPANS_EXECUTION_INPUT_MEDIA_TYPE,
    });
  });

  test('does not include mutable execution maps in the per-span context', () => {
    const run = runWith({
      verify: { dependencies: [], spanId: 'verify', title: 'Verify' },
    });
    const first = buildSpansExecutionInput({ run, selector: selector() });
    run.view.execution = { approval: true, version: 999 };
    run.view.executions = { callerControlled: { approved: true } };
    const second = buildSpansExecutionInput({ run, selector: selector() });

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      artifactId: first.artifactId,
      text: first.text,
    });
    expect(second.text).not.toContain('approved');
  });

  test('refuses imported state markers and never invokes accessors or proxies', () => {
    const base = runWith({
      verify: { dependencies: [], spanId: 'verify', title: 'Verify' },
    });
    expect(
      buildSpansExecutionInput({
        run: { ...base, view: { ...base.view, state: 'imported' } },
        selector: selector(),
      }).ok
    ).toBe(false);
    expect(
      buildSpansExecutionInput({
        run: { ...base, view: { ...base.view, readOnly: true } },
        selector: selector(),
      }).ok
    ).toBe(false);

    let getterCalls = 0;
    const args = Object.defineProperties(
      {},
      {
        run: {
          enumerable: true,
          get() {
            getterCalls += 1;
            return base;
          },
        },
        selector: { enumerable: true, value: selector() },
      }
    );
    expect(buildSpansExecutionInput(args).ok).toBe(false);
    expect(getterCalls).toBe(0);

    let proxyCalls = 0;
    const proxied = new Proxy(base, {
      getPrototypeOf() {
        proxyCalls += 1;
        throw new Error('trap');
      },
      ownKeys() {
        proxyCalls += 1;
        throw new Error('trap');
      },
    });
    expect(
      buildSpansExecutionInput({ run: proxied, selector: selector() }).ok
    ).toBe(false);
    expect(proxyCalls).toBe(0);
  });
});
