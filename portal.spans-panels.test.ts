import { describe, expect, test } from 'bun:test';
import {
  SPANS_PANEL_ENTRY_LIMIT,
  selectSpansAcceptance,
  selectSpansAcceptedDecisions,
  selectSpansActionFields,
  selectSpansAgentData,
  selectSpansAgentFields,
  selectSpansDecisionFields,
  selectSpansOtherFields,
  selectSpansPanelEntries,
  selectSpansPanelFields,
  selectSpansPlan,
  selectSpansRecovery,
  selectSpansResourceFields,
  selectSpansResources,
  selectSpansUnresolvedActions,
  selectSpansUsage,
  selectSpansUsageFields,
  selectSpansUsagePolicy,
} from './portal/components/spans-panels';
import type { SpansJson } from './portal/spans-types';

describe('Spans detail panel selectors', () => {
  test('missing and malformed panel data stays unavailable', () => {
    expect(selectSpansPanelEntries(undefined)).toEqual({
      entries: [],
      malformed: false,
      present: false,
      truncated: false,
    });
    expect(selectSpansPanelEntries(null).present).toBe(false);
    expect(selectSpansPanelEntries('wrong shape').malformed).toBe(true);
    expect(selectSpansPanelEntries(42).malformed).toBe(true);
  });

  test('retains stale and unknown state as recorded instead of normalizing it', () => {
    const recovery = selectSpansRecovery({
      processState: null,
      state: 'stale',
    } as Record<string, SpansJson>);
    expect(recovery.state).toBe('stale');
    expect(recovery.processState).toBeNull();
    expect(recovery.recoveryState).toBeUndefined();
  });

  test('reads reservation rows and policy from the actual usage contract', () => {
    const direct = selectSpansUsage({
      usage: { actualMicro: 0, reservationMicro: 125, state: 'reserved' },
    } as Record<string, SpansJson>);
    expect(direct.entries).toEqual([
      {
        key: 'Usage',
        value: { actualMicro: 0, reservationMicro: 125, state: 'reserved' },
      },
    ]);
    const keyed = selectSpansUsage({
      usage: {
        session: { actualMicro: 0, reservationMicro: 125, state: 'reserved' },
      },
    } as Record<string, SpansJson>);
    expect(keyed.entries[0]?.key).toBe('session');
    const contract = selectSpansUsage({
      usage: {
        policy: { limitMicro: 900, mode: 'hard' },
        reservations: {
          attempt1: {
            actualMicro: 0,
            reservationMicro: 125,
            state: 'reserved',
          },
        },
      },
    } as Record<string, SpansJson>);
    expect(contract.entries).toEqual([
      {
        key: 'attempt1',
        value: { actualMicro: 0, reservationMicro: 125, state: 'reserved' },
      },
    ]);
    expect(
      selectSpansUsagePolicy({
        usage: { policy: { limitMicro: 900, mode: 'hard' }, reservations: {} },
      } as Record<string, SpansJson>)
    ).toEqual({ limitMicro: 900, mode: 'hard' });
    expect(
      selectSpansUsageFields({
        actualMicro: 0,
        reservationMicro: 125,
        state: 'reserved',
      })
    ).toEqual([
      { label: 'Reservation state', value: 'reserved' },
      { label: 'Reserved amount (micro-units)', value: '125' },
      { label: 'Actual amount (micro-units)', value: '0' },
    ]);
    expect(selectSpansPanelEntries(undefined).present).toBe(false);
  });

  test('keeps accepted decisions, agent and resource records available', () => {
    const acceptedDecisions = Object.fromEntries([
      [
        'typed',
        {
          extra: 'retained',
          text: 'Use the approved cap.',
          title: 'Budget',
        },
      ],
      ['legacy', 'Keep history'],
    ]);
    const view = {
      acceptedDecisions,
      agents: {
        codex: {
          client: 'codex',
          effort: 'high',
          extra: 'kept',
          model: 'selected',
          provider: 'openai',
          session: 's1',
          state: 'connected',
        },
      },
      resources: {
        archive: {
          bytes: 1234,
          capacity: 5000,
          extra: 'kept',
          status: 'available',
        },
      },
    } as Record<string, SpansJson>;
    const decisions = view.acceptedDecisions as Record<string, SpansJson>;
    const agents = view.agents as Record<string, SpansJson>;
    const resources = view.resources as Record<string, SpansJson>;

    expect(
      selectSpansAcceptedDecisions(view).entries.map(({ key }) => key)
    ).toEqual(['typed', 'legacy']);
    expect(selectSpansDecisionFields(decisions.typed)).toEqual([
      { label: 'Decision title', value: 'Budget' },
      { label: 'Decision text', value: 'Use the approved cap.' },
    ]);
    expect(selectSpansDecisionFields(decisions.legacy)).toEqual([
      { label: 'Decision', value: 'Keep history' },
    ]);
    expect(selectSpansAgentFields(agents.codex)).toEqual([
      { label: 'Client', value: 'codex' },
      { label: 'Provider', value: 'openai' },
      { label: 'Model', value: 'selected' },
      { label: 'Effort', value: 'high' },
      { label: 'Session', value: 's1' },
      { label: 'State', value: 'connected' },
    ]);
    expect(
      selectSpansOtherFields(agents.codex, selectSpansAgentFields(agents.codex))
    ).toEqual([{ label: 'extra', value: 'kept' }]);
    expect(selectSpansResourceFields(resources.archive)).toEqual([
      { label: 'Observed bytes', value: '1234' },
      { label: 'Observed capacity', value: '5000' },
      { label: 'Status', value: 'available' },
    ]);
    expect(selectSpansResources(view).entries).toHaveLength(1);
  });

  test('process exit and action outcome do not imply accepted completion', () => {
    const view = {
      actions: { action1: { state: 'completed' } },
      processState: 'exited',
      spans: { span1: { state: 'running' } },
      state: 'running',
    } as Record<string, SpansJson>;
    expect(selectSpansRecovery(view).processState).toBe('exited');
    expect(selectSpansRecovery(view).state).toBe('running');
    expect(selectSpansAcceptance(view).entries).toEqual([]);
    expect(selectSpansUnresolvedActions(view).entries).toEqual([]);
  });

  test('keeps acceptance receipt references distinct from acknowledgements', () => {
    const fields = selectSpansActionFields({
      acceptedActionId: 'action-1',
      acceptedEvidenceId: 'evidence-1',
      acknowledgement: 'client-ack-1',
      receipt: 'store-receipt-1',
    });
    expect(fields.slice(-2)).toEqual([
      { label: 'Dispatch receipt', value: 'store-receipt-1' },
      { label: 'Explicit acknowledgment', value: 'client-ack-1' },
    ]);
    expect(selectSpansActionFields({}).slice(-2)).toEqual([
      { label: 'Dispatch receipt', value: 'Unknown' },
      { label: 'Explicit acknowledgment', value: 'Unknown' },
    ]);
  });

  test('filters reconciliation to unresolved states and requires acceptance references', () => {
    const actions = {
      done: { actionId: 'a3', state: 'completed' },
      pending: { actionId: 'a1', attemptId: 'try-1', state: 'intent' },
      unknown: { actionId: 'a2', state: 'unknown' },
    };
    const view = {
      actions: {
        ...actions,
      },
      spans: {
        accepted: {
          acceptedActionId: 'a3',
          acceptedEvidenceId: 'e3',
          state: 'completed',
        },
        incomplete: { acceptedActionId: 'a4', state: 'completed' },
      },
    } as unknown as Record<string, SpansJson>;
    expect(
      selectSpansUnresolvedActions(view).entries.map(({ key }) => key)
    ).toEqual(['pending', 'unknown']);
    expect(selectSpansAcceptance(view).entries.map(({ key }) => key)).toEqual([
      'accepted',
    ]);
    expect(selectSpansActionFields(actions.pending).slice(0, 4)).toEqual([
      { label: 'Action ID', value: 'a1' },
      { label: 'Span ID', value: 'Unknown' },
      { label: 'Attempt', value: 'try-1' },
      { label: 'Action state', value: 'intent' },
    ]);
  });

  test('keeps typed fields allowlisted and makes every entry reachable', () => {
    const dangerous = '<img src=x onerror=alert(1)> javascript:alert(1)';
    expect(selectSpansPanelFields({ summary: dangerous })).toEqual([]);

    const oversized = Array.from(
      { length: SPANS_PANEL_ENTRY_LIMIT + 7 },
      (_, i) => i
    );
    const selected = selectSpansPanelEntries(oversized);
    expect(selected.entries).toHaveLength(SPANS_PANEL_ENTRY_LIMIT + 7);
    expect(selected.truncated).toBe(false);
    expect(selected.entries[0]).toEqual({ key: '0', value: 0 });

    expect(
      selectSpansPanelFields({ dependencies: ['x'.repeat(4096)] })[0]?.value
    ).toBe('x'.repeat(4096));
    expect(
      selectSpansPanelFields({ dependencies: ['x'.repeat(4097)] })[0]?.value
    ).toBe(`${'x'.repeat(4096)}… (truncated)`);
  });

  test('preserves every entry beyond the visible first page in panel lists', () => {
    const rows = Object.fromEntries(
      Array.from({ length: SPANS_PANEL_ENTRY_LIMIT + 7 }, (_, index) => [
        `row-${index}`,
        { state: index % 2 ? 'intent' : 'unknown' },
      ])
    );
    const view = {
      acceptedDecisions: rows,
      actions: rows,
      agents: rows,
      assignments: rows,
      planHistory: rows,
      resources: rows,
      spans: rows,
      usage: { policy: { mode: 'test' }, reservations: rows },
    } as unknown as Record<string, SpansJson>;
    expect(selectSpansAcceptedDecisions(view).entries).toHaveLength(
      SPANS_PANEL_ENTRY_LIMIT + 7
    );
    expect(selectSpansPlan(view).spans.entries).toHaveLength(
      SPANS_PANEL_ENTRY_LIMIT + 7
    );
    expect(selectSpansPlan(view).planHistory.entries).toHaveLength(
      SPANS_PANEL_ENTRY_LIMIT + 7
    );
    expect(selectSpansAgentData(view).agents.entries).toHaveLength(
      SPANS_PANEL_ENTRY_LIMIT + 7
    );
    expect(selectSpansAgentData(view).assignments.entries).toHaveLength(
      SPANS_PANEL_ENTRY_LIMIT + 7
    );
    expect(selectSpansAgentData(view).actions.entries).toHaveLength(
      SPANS_PANEL_ENTRY_LIMIT + 7
    );
    expect(selectSpansResources(view).entries).toHaveLength(
      SPANS_PANEL_ENTRY_LIMIT + 7
    );
    expect(selectSpansUnresolvedActions(view).entries).toHaveLength(
      SPANS_PANEL_ENTRY_LIMIT + 7
    );
    expect(selectSpansUsage(view).entries).toHaveLength(
      SPANS_PANEL_ENTRY_LIMIT + 7
    );
  });
});
