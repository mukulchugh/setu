import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { SpansJson } from '../spans-types';
import { Button } from '../ui/button';

export const SPANS_PANEL_ENTRY_LIMIT = 50;
export const SPANS_PANEL_TEXT_LIMIT = 4096;

export interface SpansPanelEntry {
  key: string;
  value: SpansJson;
}

export interface SpansPanelSelection {
  entries: SpansPanelEntry[];
  malformed: boolean;
  present: boolean;
  truncated: boolean;
}

export interface SpansPanelField {
  label: string;
  value: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function selectSpansPanelEntries(value: unknown): SpansPanelSelection {
  if (value === undefined || value === null) {
    return { entries: [], malformed: false, present: false, truncated: false };
  }
  if (!(Array.isArray(value) || isRecord(value))) {
    return { entries: [], malformed: true, present: true, truncated: false };
  }
  const all: SpansPanelEntry[] = Array.isArray(value)
    ? value.map((entry, index) => ({
        key: String(index),
        value: entry as SpansJson,
      }))
    : Object.keys(value).map((key) => ({
        key,
        value: value[key] as SpansJson,
      }));
  return { entries: all, malformed: false, present: true, truncated: false };
}

function clippedText(value: string): string {
  const clipped = value.slice(0, SPANS_PANEL_TEXT_LIMIT);
  return clipped.length < value.length
    ? `${clipped}… (truncated)`
    : clipped || '(empty)';
}

function serializedText(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string') {
      const clipped = serialized.slice(0, SPANS_PANEL_TEXT_LIMIT);
      return clipped.length < serialized.length
        ? `${clipped}… (truncated)`
        : clipped;
    }
  } catch {
    return 'Unavailable';
  }
  return 'Unavailable';
}

function valueText(value: unknown): string {
  if (value === undefined || value === null) {
    return 'Unknown';
  }
  if (typeof value === 'string') {
    return clippedText(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'Unavailable';
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
  ) {
    return valueText(value.length ? value.join(', ') : '(none)');
  }
  if (Array.isArray(value) || isRecord(value)) {
    return serializedText(value);
  }
  return 'Unavailable';
}

function ownField(
  value: unknown,
  key: string,
  label: string
): SpansPanelField | null {
  if (!(isRecord(value) && Object.hasOwn(value, key))) {
    return null;
  }
  return { label, value: valueText(value[key]) };
}

function fieldsFor(
  value: unknown,
  definitions: [string, string][]
): SpansPanelField[] {
  return definitions.flatMap(([key, label]) => {
    const field = ownField(value, key, label);
    return field ? [field] : [];
  });
}

function describedFields(
  value: unknown,
  definitions: [string, string][]
): SpansPanelField[] {
  return definitions.map(([key, label]) => {
    const field = ownField(value, key, label);
    return field ?? { label, value: 'Unknown' };
  });
}

export function selectSpansPanelFields(value: unknown): SpansPanelField[] {
  return fieldsFor(value, [
    ['title', 'Title'],
    ['goal', 'Goal'],
    ['state', 'State'],
    ['dependencies', 'Dependencies'],
    ['actionId', 'Action ID'],
    ['spanId', 'Span ID'],
    ['attemptId', 'Attempt'],
    ['outcomeArtifactIds', 'Outcome evidence'],
    ['acceptedActionId', 'Accepted action'],
    ['acceptedCheckpoint', 'Accepted checkpoint'],
    ['acceptedEvidenceId', 'Accepted evidence'],
  ]);
}

export function selectSpansActionFields(value: unknown): SpansPanelField[] {
  return [
    ...describedFields(value, [
      ['actionId', 'Action ID'],
      ['spanId', 'Span ID'],
      ['attemptId', 'Attempt'],
      ['state', 'Action state'],
    ]),
    ownField(value, 'outcomeArtifactIds', 'Observed outcome evidence') ??
      ownField(value, 'outcome', 'Observed outcome') ?? {
        label: 'Observed outcome evidence',
        value: 'Unknown',
      },
    {
      label: 'Dispatch receipt',
      value: isRecord(value)
        ? valueText(value.dispatchReceipt ?? value.receipt)
        : 'Unknown',
    },
    {
      label: 'Explicit acknowledgment',
      value: isRecord(value)
        ? valueText(value.explicitAcknowledgment ?? value.acknowledgement)
        : 'Unknown',
    },
  ];
}

export function selectSpansUsageFields(value: unknown): SpansPanelField[] {
  return [
    ...describedFields(value, [['state', 'Reservation state']]),
    ...describedFields(value, [
      ['reservationMicro', 'Reserved amount (micro-units)'],
      ['actualMicro', 'Actual amount (micro-units)'],
    ]),
  ];
}

export function selectSpansPlan(view: Record<string, SpansJson>) {
  return {
    checkpoint: view.checkpoint,
    planHistory: selectSpansPanelEntries(view.planHistory),
    planVersion: view.planVersion,
    spans: selectSpansPanelEntries(view.spans),
  };
}

export function selectSpansAgentData(view: Record<string, SpansJson>) {
  return {
    actions: selectSpansPanelEntries(view.actions),
    agents: selectSpansPanelEntries(view.agents),
    assignments: selectSpansPanelEntries(view.assignments),
  };
}

export function selectSpansRecovery(view: Record<string, SpansJson>) {
  return {
    checkpoint: view.checkpoint,
    processState: view.processState,
    reason: view.reason,
    recoveryState: view.recoveryState,
    state: view.state ?? view.status,
  };
}

export function selectSpansAcceptance(view: Record<string, SpansJson>) {
  const spans = selectSpansPanelEntries(view.spans);
  const accepted = spans.entries.filter(
    ({ value }) =>
      isRecord(value) &&
      typeof value.acceptedActionId === 'string' &&
      value.acceptedActionId.length > 0 &&
      typeof value.acceptedEvidenceId === 'string' &&
      value.acceptedEvidenceId.length > 0
  );
  return { ...spans, entries: accepted };
}

export function selectSpansUnresolvedActions(view: Record<string, SpansJson>) {
  const actions = selectSpansPanelEntries(view.actions);
  return {
    ...actions,
    entries: actions.entries.filter(
      ({ value }) =>
        isRecord(value) &&
        ['intent', 'unknown', 'unresolved'].includes(String(value.state))
    ),
  };
}

export function selectSpansResources(view: Record<string, SpansJson>) {
  return selectSpansPanelEntries(view.resources);
}

export function selectSpansUsage(view: Record<string, SpansJson>) {
  const { usage } = view;
  if (isRecord(usage) && Object.hasOwn(usage, 'reservations')) {
    return selectSpansPanelEntries(usage.reservations);
  }
  if (
    isRecord(usage) &&
    ['actualMicro', 'reservationMicro', 'state'].some((key) =>
      Object.hasOwn(usage, key)
    )
  ) {
    return {
      entries: [{ key: 'Usage', value: usage as SpansJson }],
      malformed: false,
      present: true,
      truncated: false,
    };
  }
  return selectSpansPanelEntries(usage);
}

export function selectSpansUsagePolicy(view: Record<string, SpansJson>) {
  const { usage } = view;
  return isRecord(usage) ? usage.policy : undefined;
}

export function selectSpansPolicyFields(value: unknown): SpansPanelField[] {
  if (isRecord(value)) {
    return Object.entries(value).map(([key, entry]) => ({
      label: key,
      value: valueText(entry),
    }));
  }
  return value === undefined
    ? []
    : [{ label: 'Policy', value: valueText(value) }];
}

export function selectSpansAcceptedDecisions(view: Record<string, SpansJson>) {
  return selectSpansPanelEntries(view.acceptedDecisions);
}

function Empty({ children }: { children: ComponentChildren }) {
  return (
    <p class="py-4 text-sm text-zinc-600 dark:text-zinc-300">{children}</p>
  );
}

function Section({
  children,
  title,
}: {
  children: ComponentChildren;
  title: string;
}) {
  return (
    <section class="min-w-0 border-zinc-200/70 border-b pb-4 last:border-0 dark:border-white/10">
      <h2 class="font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      {children}
    </section>
  );
}

function FieldList({ fields }: { fields: SpansPanelField[] }) {
  if (fields.length === 0) {
    return <Empty>Unavailable in the saved record.</Empty>;
  }
  return (
    <dl class="mt-2 grid min-w-0 gap-x-6 sm:grid-cols-2">
      {fields.map(({ label, value }, index) => (
        <div class="min-w-0 py-2" key={`${label}:${index}`}>
          <dt class="break-all font-semibold text-xs text-zinc-600 dark:text-zinc-300">
            {label}
          </dt>
          <dd class="mt-1 break-words text-sm text-zinc-900 dark:text-zinc-100">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

type PanelFieldSelector = (value: unknown) => SpansPanelField[];

function Entries({
  empty,
  fields,
  selection,
}: {
  empty: string;
  fields: PanelFieldSelector;
  selection: SpansPanelSelection;
}) {
  const [shown, setShown] = useState(SPANS_PANEL_ENTRY_LIMIT);
  if (!selection.present) {
    return <Empty>{empty}</Empty>;
  }
  if (selection.malformed) {
    return <Empty>Unavailable: saved data has an unsupported shape.</Empty>;
  }
  if (selection.entries.length === 0) {
    return <Empty>{empty}</Empty>;
  }
  const visible = selection.entries.slice(0, shown);
  return (
    <>
      <ul class="mt-2 divide-y divide-zinc-200/70 dark:divide-white/10">
        {visible.map(({ key, value }) => (
          <li class="min-w-0 py-3" key={key}>
            <p class="break-all font-medium text-sm text-zinc-900 dark:text-zinc-100">
              {key}
            </p>
            <RecordFields fields={fields} value={value} />
          </li>
        ))}
      </ul>
      {visible.length < selection.entries.length && (
        <Button
          class="mt-2"
          compact
          onClick={() => setShown((count) => count + SPANS_PANEL_ENTRY_LIMIT)}
          variant="secondary"
        >
          Show more ({selection.entries.length - visible.length} remaining)
        </Button>
      )}
    </>
  );
}

function selectedFields(
  fields: PanelFieldSelector,
  value: unknown
): SpansPanelField[] {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  ) {
    return [{ label: 'Recorded value', value: valueText(value) }];
  }
  return fields(value);
}

export function selectSpansOtherFields(
  value: unknown,
  selected: SpansPanelField[]
): SpansPanelField[] {
  if (!isRecord(value)) {
    return [];
  }
  const selectedLabels = new Set(selected.map(({ label }) => label));
  const fieldLabels: Record<string, string> = {
    acceptedActionId: 'Accepted action',
    acceptedCheckpoint: 'Accepted checkpoint',
    acceptedEvidenceId: 'Accepted evidence',
    actionId: 'Action ID',
    actualMicro: 'Actual amount (micro-units)',
    attemptId: 'Attempt',
    availability: 'Availability',
    bytes: 'Observed bytes',
    capacity: 'Observed capacity',
    client: 'Client',
    dependencies: 'Dependencies',
    effort: 'Effort',
    goal: 'Goal',
    kind: 'Resource kind',
    model: 'Model',
    name: 'Name',
    outcomeArtifactIds: 'Outcome evidence',
    path: 'Path',
    provider: 'Provider',
    reservationMicro: 'Reserved amount (micro-units)',
    resourceId: 'Resource ID',
    root: 'Root',
    session: 'Session',
    sessionId: 'Session ID',
    spanId: 'Span ID',
    state: 'State',
    status: 'Status',
    text: 'Decision text',
    title: 'Title',
  };
  return Object.entries(value)
    .filter(([key]) => {
      const label = fieldLabels[key];
      if (!label) {
        return true;
      }
      return !(
        selectedLabels.has(label) ||
        (key === 'title' &&
          (selectedLabels.has('Decision title') ||
            selectedLabels.has('Span title')))
      );
    })
    .map(([key, entry]) => ({ label: key, value: valueText(entry) }))
    .filter(({ label }) => !selectedLabels.has(label));
}

function RecordFields({
  fields,
  value,
}: {
  fields: PanelFieldSelector;
  value: unknown;
}) {
  const selected = selectedFields(fields, value);
  if (!isRecord(value)) {
    return <FieldList fields={selected} />;
  }
  const extras = selectSpansOtherFields(value, selected);
  return (
    <>
      <FieldList fields={selected} />
      {extras.length > 0 && (
        <details class="mt-2 text-sm">
          <summary class="cursor-pointer font-medium text-zinc-700 dark:text-zinc-200">
            Other recorded fields ({extras.length})
          </summary>
          <FieldList fields={extras} />
        </details>
      )}
    </>
  );
}

function DirectFields({
  fields,
}: {
  fields: { label: string; value: unknown }[];
}) {
  return (
    <FieldList
      fields={fields.map(({ label, value }) => ({
        label,
        value: valueText(value),
      }))}
    />
  );
}

function spanFields(value: unknown): SpansPanelField[] {
  return fieldsFor(value, [
    ['title', 'Span title'],
    ['state', 'Span state'],
    ['dependencies', 'Dependencies'],
    ['acceptedActionId', 'Accepted action'],
    ['acceptedCheckpoint', 'Accepted checkpoint'],
    ['acceptedEvidenceId', 'Accepted evidence'],
  ]);
}

export function selectSpansResourceFields(value: unknown): SpansPanelField[] {
  return fieldsFor(value, [
    ['resourceId', 'Resource ID'],
    ['kind', 'Resource kind'],
    ['name', 'Name'],
    ['path', 'Path'],
    ['root', 'Root'],
    ['bytes', 'Observed bytes'],
    ['capacity', 'Observed capacity'],
    ['status', 'Status'],
  ]);
}

export function selectSpansAgentFields(value: unknown): SpansPanelField[] {
  return fieldsFor(value, [
    ['client', 'Client'],
    ['provider', 'Provider'],
    ['model', 'Model'],
    ['effort', 'Effort'],
    ['session', 'Session'],
    ['sessionId', 'Session ID'],
    ['state', 'State'],
    ['availability', 'Availability'],
  ]);
}

export function selectSpansDecisionFields(value: unknown): SpansPanelField[] {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return [{ label: 'Decision', value: valueText(value) }];
  }
  return fieldsFor(value, [
    ['title', 'Decision title'],
    ['text', 'Decision text'],
  ]);
}

export function SpansPlanPanel({ view }: { view: Record<string, SpansJson> }) {
  const plan = selectSpansPlan(view);
  return (
    <div class="space-y-5">
      <Section title="Plan version">
        <DirectFields
          fields={[
            { label: 'Plan version', value: plan.planVersion },
            { label: 'Checkpoint', value: plan.checkpoint },
            { label: 'Goal', value: view.goal },
          ]}
        />
      </Section>
      <Section title="Accepted decisions">
        <Entries
          empty="No accepted decisions are recorded."
          fields={selectSpansDecisionFields}
          selection={selectSpansAcceptedDecisions(view)}
        />
      </Section>
      <Section title="Workstreams">
        <Entries
          empty="No workstreams are recorded."
          fields={spanFields}
          selection={plan.spans}
        />
      </Section>
      <Section title="Plan history">
        <Entries
          empty="Plan history is unavailable in the saved record."
          fields={selectSpansPanelFields}
          selection={plan.planHistory}
        />
      </Section>
    </div>
  );
}

export function SpansAgentsPanel({
  view,
}: {
  view: Record<string, SpansJson>;
}) {
  const data = selectSpansAgentData(view);
  return (
    <div class="space-y-5">
      <Section title="Agent roster">
        <Entries
          empty="Agent identity and availability are unavailable in this record."
          fields={selectSpansAgentFields}
          selection={data.agents}
        />
      </Section>
      <Section title="Assignments">
        <Entries
          empty="Assignments are unavailable in the saved record."
          fields={selectSpansPanelFields}
          selection={data.assignments}
        />
      </Section>
      <Section title="Actions">
        <Entries
          empty="No actions are recorded."
          fields={selectSpansActionFields}
          selection={data.actions}
        />
      </Section>
    </div>
  );
}

export function SpansRecoveryPanel({
  view,
}: {
  view: Record<string, SpansJson>;
}) {
  const recovery = selectSpansRecovery(view);
  return (
    <div class="space-y-5">
      <p class="text-sm text-zinc-600 dark:text-zinc-300">
        Process exit and action outcomes do not establish accepted work.
      </p>
      <Section title="Recorded recovery state">
        <DirectFields
          fields={[
            { label: 'Run state', value: recovery.state },
            { label: 'Recovery state', value: recovery.recoveryState },
            { label: 'Process state', value: recovery.processState },
            { label: 'Reason', value: recovery.reason },
            { label: 'Checkpoint', value: recovery.checkpoint },
          ]}
        />
      </Section>
      <Section title="Actions requiring reconciliation">
        <Entries
          empty="No unresolved actions."
          fields={selectSpansActionFields}
          selection={selectSpansUnresolvedActions(view)}
        />
      </Section>
      <Section title="Recorded acceptance">
        <Entries
          empty="No accepted completion is recorded."
          fields={spanFields}
          selection={selectSpansAcceptance(view)}
        />
      </Section>
    </div>
  );
}

export function SpansResourcesPanel({
  view,
}: {
  view: Record<string, SpansJson>;
}) {
  return (
    <Section title="Recorded resources">
      <Entries
        empty="Resources are unavailable in the saved record."
        fields={selectSpansResourceFields}
        selection={selectSpansResources(view)}
      />
    </Section>
  );
}

export function SpansUsagePanel({ view }: { view: Record<string, SpansJson> }) {
  return (
    <div class="space-y-5">
      <Section title="Usage policy">
        <FieldList
          fields={selectSpansPolicyFields(selectSpansUsagePolicy(view))}
        />
      </Section>
      <Section title="Usage reservations">
        <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          Amounts are shown in micro-units; currency and pricing are not
          recorded here.
        </p>
        <Entries
          empty="Usage reservations are unavailable in the saved record."
          fields={selectSpansUsageFields}
          selection={selectSpansUsage(view)}
        />
      </Section>
    </div>
  );
}
