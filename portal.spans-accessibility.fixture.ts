import { expect, mock } from 'bun:test';
import type { SpansEvent, SpansRecord } from './portal/spans-types';

interface TestNode {
  props: Record<string, unknown>;
  type: string | ((props: Record<string, unknown>) => unknown);
}

function element(
  type: TestNode['type'],
  props: Record<string, unknown> = {}
): TestNode {
  return { props, type };
}

function passthrough(props: Record<string, unknown>) {
  return element('div', props);
}

mock.module('preact/jsx-dev-runtime', () => ({
  Fragment: Symbol('Fragment'),
  jsx: element,
  jsxDEV: element,
  jsxs: element,
}));
mock.module('preact/hooks', () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
  useId: () => 'fixture-id',
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, () => undefined],
}));
mock.module('./portal/ui', () => ({
  inputCls: 'fixture-input',
  PageHeader: passthrough,
  Section: passthrough,
}));
mock.module('./portal/ui/button', () => ({
  Button: (props: Record<string, unknown>) => element('button', props),
}));
mock.module('./portal/ui/badge', () => ({
  Badge: (props: Record<string, unknown>) => element('span', props),
}));
mock.module('./portal/components/spans-panels', () => ({
  SpansAgentsPanel: passthrough,
  SpansPlanPanel: passthrough,
  SpansRecoveryPanel: passthrough,
  SpansResourcesPanel: passthrough,
  SpansUsagePanel: passthrough,
}));

const importedRecord: SpansRecord = {
  generation: 1,
  revision: 1,
  runId: 'imported-run',
  view: {
    goal: 'Imported conversation',
    kind: 'imported',
    processState: 'completed',
    provider: 'codex',
    state: 'completed',
  },
};

const artifactId = `sha256:${'a'.repeat(64)}`;
const importedMessage: SpansEvent = {
  eventId: 'event-1',
  payload: {
    artifactId,
    byteEnd: 40,
    byteStart: 0,
    nativeId: 'native-message-1',
    parserVersion: 'codex-jsonl-v1',
    provider: 'codex',
    sourceGeneration: 2,
    sourceId: 'source-codex-1',
    summary: 'A retained imported message',
  },
  runId: 'imported-run',
  sequence: 1,
  type: 'source.message',
};

function children(value: unknown): unknown[] {
  if (typeof value === 'string' || typeof value === 'number') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    !('type' in value) ||
    !('props' in value)
  ) {
    return [];
  }
  const { props } = value as TestNode;
  return Array.isArray(props.children) ? props.children : [props.children];
}

function walk(value: unknown, nodes: TestNode[], text: string[]): void {
  if (typeof value === 'string' || typeof value === 'number') {
    text.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, nodes, text);
    }
    return;
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    !('type' in value) ||
    !('props' in value)
  ) {
    return;
  }
  const vnode = value as TestNode;
  nodes.push(vnode);
  const componentName =
    typeof vnode.type === 'function' ? vnode.type.name : undefined;
  if (
    componentName &&
    [
      'RunRow',
      'ConversationEvent',
      'MessageEventContent',
      'SummaryField',
    ].includes(componentName)
  ) {
    const render = vnode.type as (props: Record<string, unknown>) => unknown;
    walk(render(vnode.props), nodes, text);
    return;
  }
  if (componentName === 'Button') {
    walk(element('button', vnode.props), nodes, text);
    return;
  }
  if (componentName === 'Badge') {
    walk(element('span', vnode.props), nodes, text);
    return;
  }
  for (const child of children(vnode.props.children)) {
    walk(child, nodes, text);
  }
}

function tree(value: unknown) {
  const nodes: TestNode[] = [];
  const text: string[] = [];
  walk(value, nodes, text);
  return { nodes, text: text.join(' ').replace(/\s+/g, ' ') };
}

function findElement(
  nodes: TestNode[],
  type: string,
  predicate: (props: Record<string, unknown>) => boolean = () => true
) {
  return nodes.find((node) => node.type === type && predicate(node.props));
}

async function checkSpansListAccessibility() {
  const { SpansList } = await import('./portal/components/spans-list');
  const output = SpansList({
    archiveNotInitialized: false,
    error: null,
    hasMore: false,
    hasPrevious: false,
    loading: false,
    onBack: () => undefined,
    onNext: () => undefined,
    onPhaseChange: () => undefined,
    onPrevious: () => undefined,
    onQueryChange: () => undefined,
    onRefresh: () => undefined,
    onSelect: () => undefined,
    phase: 'past',
    query: '',
    records: [
      importedRecord,
      {
        ...importedRecord,
        runId: 'completed-run',
        view: { goal: 'Completed native run', state: 'completed' },
      },
    ],
    stale: false,
  });
  const rendered = tree(output);
  expect(rendered.text).toContain('Imported history');
  expect(rendered.text).toContain('Completed');

  const search = findElement(rendered.nodes, 'input');
  expect(search?.props.id).toBe('spans-query');
  expect(
    rendered.nodes.some(
      (node) => node.type === 'label' && node.props.htmlFor === search?.props.id
    )
  ).toBe(true);
  const phaseButton = findElement(
    rendered.nodes,
    'button',
    (props) => props['aria-pressed'] === true
  );
  expect(phaseButton?.props.type).toBe('button');
  expect(phaseButton?.props.class).toContain('min-h-11');
  expect(
    rendered.nodes.find((node) => node.type === 'ul')?.props['aria-label']
  ).toBe('Spans runs');
}

async function checkImportedDetailAccessibility() {
  const { SpansDetail } = await import('./portal/components/spans-detail');
  const rendered = tree(
    SpansDetail({
      conversation: null,
      error: null,
      evidence: null,
      loading: false,
      onBack: () => undefined,
      onRefresh: () => undefined,
      record: importedRecord,
      stale: false,
    })
  );
  expect(rendered.text).toContain('Imported conversation · read-only');
  expect(rendered.text).toContain('Setu did not execute or verify');
  expect(rendered.text).toContain('Recorded source state');
  expect(rendered.text).toContain('Setu process state');
  expect(rendered.text).toContain('Not run by Setu');
  expect(rendered.text).not.toContain('Process state completed');

  const pressedTabs = rendered.nodes.filter(
    (node) => node.type === 'button' && node.props['aria-pressed'] === true
  );
  expect(pressedTabs).toHaveLength(1);
  expect(pressedTabs[0]?.props['aria-controls']).toBe(
    rendered.nodes.find((node) => node.type === 'section')?.props.id
  );
}

async function checkConversationAccessibility() {
  const { SpansConversation } = await import(
    './portal/components/spans-conversation'
  );
  const rendered = tree(
    SpansConversation({
      error: null,
      events: [importedMessage],
      hasMore: false,
      loading: false,
      onLoadMore: () => undefined,
      readArtifact: async () => ({
        artifactId,
        mediaType: 'text/plain',
        ok: true,
        runId: importedMessage.runId,
        text: 'saved message',
      }),
      runId: importedMessage.runId,
      stale: false,
    })
  );
  for (const provenance of [
    'Provider: codex',
    'Source: source-codex-1',
    'Source generation: 2',
    'Parser: codex-jsonl-v1',
    'Source bytes: 0–40',
    'Source message ID: native-message-1',
  ]) {
    expect(rendered.text).toContain(provenance);
  }
  const messageButton = findElement(
    rendered.nodes,
    'button',
    (props) => props['aria-expanded'] === false
  );
  expect(messageButton?.props['aria-controls']).toBeUndefined();
  expect(messageButton?.props.class).toContain('min-h-11');
  expect(
    rendered.nodes.some(
      (node) =>
        node.type === 'ol' && node.props['aria-label'] === 'Conversation events'
    )
  ).toBe(true);
}

async function checkEvidenceAccessibility() {
  const { SpansEvidence } = await import('./portal/components/spans-evidence');
  const rendered = tree(
    SpansEvidence({
      artifactId: null,
      events: [importedMessage],
      onArtifactChange: () => undefined,
      readArtifact: async () => ({
        artifactId,
        mediaType: 'application/json',
        ok: true,
        runId: importedMessage.runId,
        text: '{"role":"assistant"}',
      }),
      runId: importedMessage.runId,
    })
  );
  expect(rendered.text).toContain('Provider: codex');
  expect(rendered.text).toContain('Source: source-codex-1');
  expect(rendered.text).toContain('Parser: codex-jsonl-v1');
  expect(rendered.text).toContain('Bytes: 0–40');
  expect(rendered.text).toContain('Cited by #1');

  const evidenceButton = findElement(
    rendered.nodes,
    'button',
    (props) => props['aria-label'] === `View evidence ${artifactId}`
  );
  expect(evidenceButton?.props['aria-controls']).toBe('spans-evidence-viewer');
  expect(evidenceButton?.props['aria-expanded']).toBe(false);
  expect(
    rendered.nodes.some(
      (node) =>
        node.type === 'div' &&
        node.props.id === evidenceButton?.props['aria-controls']
    )
  ).toBe(true);
}

await checkSpansListAccessibility();
await checkImportedDetailAccessibility();
await checkConversationAccessibility();
await checkEvidenceAccessibility();
