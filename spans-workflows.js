// Built-in Spans workflow templates. This module is pure: it renders previews
// from its own catalog and never reads or writes storage, starts runs or
// agents, runs commands, installs skills or plugins, or grants approval. A
// preview's draft is a createSpansDrafts input for the caller to review and,
// if it chooses, store. Placeholders are filled only from caller substitutions.

import { createHash } from 'node:crypto';
import { redactSpansValue } from './spans-redaction.js';

export const SPANS_WORKFLOW_LIMITS = Object.freeze({
  goalLength: 8000,
  ownerLength: 64,
  placeholderLength: 480,
  projectLength: 128,
  titleLength: 1000,
  worktreeLength: 1024,
});

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const placeholderPattern = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const requestFields = Object.freeze([
  'owner',
  'project',
  'runId',
  'substitutions',
  'templateId',
  'templateVersion',
  'worktree',
]);

const errors = Object.freeze({
  SPANS_WORKFLOW_DIGEST_INVALID:
    'Preview digest must be a sha256 value from a workflow preview.',
  SPANS_WORKFLOW_DIGEST_MISMATCH:
    'Preview digest no longer matches the reviewed inputs.',
  SPANS_WORKFLOW_FIELD_UNSUPPORTED:
    'Workflow preview request names an unsupported field.',
  SPANS_WORKFLOW_INVALID: 'Invalid workflow preview request.',
  SPANS_WORKFLOW_PLACEHOLDER_MISSING:
    'Every placeholder in this template needs a value.',
  SPANS_WORKFLOW_PLACEHOLDER_UNKNOWN:
    'Substitution names a placeholder this template does not declare.',
  SPANS_WORKFLOW_TOO_LARGE: 'Rendered workflow preview exceeds its bounds.',
  SPANS_WORKFLOW_UNKNOWN: 'Unknown workflow template.',
  SPANS_WORKFLOW_VERSION_UNKNOWN: 'Unknown version for this workflow template.',
});

const refusal = (code, extra = {}) => ({
  code,
  error: errors[code],
  ...extra,
  ok: false,
});

function placeholder(name, description, maxLength) {
  return { description, maxLength, name };
}

function task(spanId, title, dependencies, acceptance) {
  return { acceptance, dependencies, spanId, title };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

// Every placeholder token must be declared, and every declared placeholder
// must appear in the goal or a span title. Acceptance text carries no tokens.
export const SPANS_WORKFLOW_CATALOG = deepFreeze([
  {
    goal: 'Deliver {{change}} so that {{behavior}}. Writing spans may edit only within: {{scope}}.',
    id: 'engineering.feature',
    kind: 'engineering',
    placeholders: [
      placeholder('change', 'Short name of the change', 160),
      placeholder(
        'behavior',
        'Observable behavior the change must produce',
        480
      ),
      placeholder(
        'scope',
        'Files or modules the change may touch, split so writing spans do not overlap',
        480
      ),
    ],
    spans: [
      task(
        'plan',
        'Confirm file ownership for {{change}} and list its behavioral checks',
        [],
        [
          'Plan names the exact files or modules each writing span owns',
          'Each behavioral check states an observable outcome from the goal',
        ]
      ),
      task(
        'tests',
        'Write behavioral tests that fail for: {{behavior}}',
        ['plan'],
        [
          'Tests fail before the change, with the exact test command, exit status and output recorded',
        ]
      ),
      task(
        'implement',
        'Implement {{change}} within {{scope}} until the tests pass',
        ['tests'],
        [
          'Writer claim and separate checkout are recorded before the first edit',
          'Changed paths stay inside the owned scope',
          'Tests pass on the implementing tree with recorded output',
        ]
      ),
      task(
        'review',
        'Review {{change}} independently against the plan and the goal',
        ['implement'],
        [
          'Reviewer records the reviewed tree identity and every finding',
          'Security, privacy, data-loss and failed-acceptance findings block completion',
        ]
      ),
      task(
        'verify',
        'Rerun the behavioral tests on the integrated tree for {{change}}',
        ['implement', 'review'],
        [
          'Exact command, exit status and output recorded for the integrated tree',
          'Any later edit reopens the review and this verification',
        ]
      ),
    ],
    summary: 'Plan, test, implement, review and verify one engineering change.',
    title: 'Engineering feature',
    version: 1,
  },
  {
    goal: 'Fix this defect: {{symptom}}. Expected behavior: {{expected}}. Investigate and edit only within: {{area}}.',
    id: 'engineering.bugfix',
    kind: 'engineering',
    placeholders: [
      placeholder('symptom', 'Observed failure, as reported', 320),
      placeholder('expected', 'Correct behavior', 320),
      placeholder('area', 'Module or flow where the failure occurs', 240),
    ],
    spans: [
      task(
        'reproduce',
        'Reproduce the reported failure in {{area}}',
        [],
        [
          'Reproduction records the failing check or manual steps with the observed output',
        ]
      ),
      task(
        'cause',
        'Find the root cause of: {{symptom}}',
        ['reproduce'],
        [
          'Cause points to specific code or data inside the owned area',
          'Ruled-out hypotheses are recorded with their evidence',
        ]
      ),
      task(
        'fix',
        'Make the smallest change in {{area}} that delivers {{expected}}',
        ['cause'],
        [
          'Writer claim and separate checkout are recorded before the first edit',
          'Reproduction passes on the fixed tree with recorded output',
        ]
      ),
      task(
        'regression',
        'Add a regression check that fails on the pre-fix behavior',
        ['cause'],
        [
          'Regression check fails on the pre-fix tree and passes on the fixed tree',
        ]
      ),
      task(
        'review',
        'Review the fix and the regression check independently',
        ['fix', 'regression'],
        [
          'Reviewer records the reviewed tree identity and every finding',
          'Blocking findings stop completion until resolved or re-reviewed',
        ]
      ),
    ],
    summary:
      'Reproduce, diagnose, fix and regression-check one reported defect.',
    title: 'Engineering bug fix',
    version: 1,
  },
  {
    goal: 'Answer this research question: {{question}}. The answer is for: {{audience}}. Read only this approved source set: {{sources}}.',
    id: 'research.source-review',
    kind: 'research',
    placeholders: [
      placeholder('question', 'Research question to answer', 320),
      placeholder('audience', 'Who the answer is for', 160),
      placeholder(
        'sources',
        'Approved source set, described in words, with no credentials or private files',
        480
      ),
    ],
    spans: [
      task(
        'scope',
        'Write the question, inclusion criteria and what would change the answer',
        [],
        ['Criteria are written before any source is read']
      ),
      task(
        'collect',
        'Collect each approved source with its locator, retrieval date and access route',
        ['scope'],
        [
          'Every source has a locator and a retrieval date',
          'Unavailable sources are labeled unavailable, not skipped',
        ]
      ),
      task(
        'extract',
        'Extract the claims that bear on {{question}}',
        ['collect'],
        [
          'Every claim links to a source record',
          'Paraphrases are marked as paraphrases',
        ]
      ),
      task(
        'crosscheck',
        'Check each load-bearing claim against a second independent source',
        ['extract'],
        [
          'Load-bearing claims show two independent sources or are marked single-source',
        ]
      ),
      task(
        'answer',
        'Write the answer for {{audience}} with confidence levels and open questions',
        ['crosscheck'],
        [
          'Each conclusion cites its claim records',
          'Unknowns are stated as unknown, not filled in',
        ]
      ),
    ],
    summary:
      'Answer a research question from one approved source set, with no repository target.',
    title: 'Research source review',
    version: 1,
  },
  {
    goal: 'Triage {{queue}} for {{window}} using this agreed rule: {{priority_rule}}. This plan makes no external change.',
    id: 'triage.issue-queue',
    kind: 'triage',
    placeholders: [
      placeholder('queue', 'Issue queue or inbox to triage', 240),
      placeholder('window', 'Time window or item set to include', 160),
      placeholder('priority_rule', 'Agreed priority rule', 320),
    ],
    spans: [
      task(
        'inventory',
        'List every item in {{queue}} for {{window}} with its source link',
        [],
        [
          'Item count is recorded',
          'Items that could not be opened are listed as unread',
        ]
      ),
      task(
        'classify',
        'Classify each item by type and severity under {{priority_rule}}',
        ['inventory'],
        [
          'Each item has one category and a stated reason',
          'Uncertain items are marked unclear, not guessed',
        ]
      ),
      task(
        'duplicates',
        'Group likely duplicates and link each group to its canonical item',
        ['inventory'],
        [
          'Each group lists the matching evidence',
          'No item is closed by this plan',
        ]
      ),
      task(
        'assign',
        'Propose an owner and next step for each classified item',
        ['classify', 'duplicates'],
        [
          'Proposals are drafts for a person to confirm',
          'No assignment is applied by this plan',
        ]
      ),
      task(
        'summary',
        'Write the triage summary and list every item that needs a human decision',
        ['assign'],
        [
          'Summary counts match the inventory',
          'Each human decision is listed with its reason',
        ]
      ),
    ],
    summary:
      'Inventory, classify and summarize one issue queue. Makes no external change.',
    title: 'Issue queue triage',
    version: 1,
  },
  {
    goal: 'Prepare a decision brief on: {{decision}}. Options under consideration: {{options}}. Constraints: {{constraints}}.',
    id: 'business.decision-brief',
    kind: 'business',
    placeholders: [
      placeholder('decision', 'Decision to make', 320),
      placeholder(
        'options',
        'Options under consideration, described in words',
        480
      ),
      placeholder('constraints', 'Budget, timing or policy constraints', 480),
    ],
    spans: [
      task(
        'frame',
        'State the decision, its owner and the criteria for choosing',
        [],
        ['Criteria are written before options are scored']
      ),
      task(
        'options',
        'Describe each option against the criteria with every assumption labeled',
        ['frame'],
        [
          'Each assumption is labeled sourced, estimated or unknown',
          'Missing prices and figures stay unknown rather than estimated silently',
        ]
      ),
      task(
        'risks',
        'List the risks and the reversibility of each option',
        ['frame'],
        ['Irreversible steps are flagged', 'No risk is dropped for brevity']
      ),
      task(
        'recommend',
        'Recommend one option with its tradeoffs against the criteria',
        ['options', 'risks'],
        [
          'Recommendation cites the scored criteria',
          'Dissent and rejected options are recorded',
        ]
      ),
      task(
        'challenge',
        'Ask a named reviewer to challenge the recommendation before it is shared',
        ['recommend'],
        [
          'Reviewer decision is recorded',
          'This plan sends no message outside the workspace',
        ]
      ),
    ],
    summary:
      'Frame, compare and challenge one business decision before it is shared.',
    title: 'Business decision brief',
    version: 1,
  },
]);

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isText(value, maxLength) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

// Reads only enumerable own data properties. Accessors, symbols and inherited
// keys refuse the whole request; unknown keys are reported without echoing them.
function readFields(record, allowed, unsupportedCode) {
  try {
    if (!isPlainRecord(record)) {
      return refusal('SPANS_WORKFLOW_INVALID');
    }
    const fields = new Map();
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== 'string') {
        return refusal('SPANS_WORKFLOW_INVALID');
      }
      if (!allowed.includes(key)) {
        return refusal(unsupportedCode);
      }
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'))) {
        return refusal('SPANS_WORKFLOW_INVALID', { field: key });
      }
      fields.set(key, descriptor.value);
    }
    return { fields, ok: true };
  } catch {
    return refusal('SPANS_WORKFLOW_INVALID');
  }
}

function findTemplate(templateId, templateVersion) {
  if (typeof templateId !== 'string') {
    return refusal('SPANS_WORKFLOW_INVALID', { field: 'templateId' });
  }
  if (!Number.isSafeInteger(templateVersion) || templateVersion < 1) {
    return refusal('SPANS_WORKFLOW_INVALID', { field: 'templateVersion' });
  }
  const exact = SPANS_WORKFLOW_CATALOG.find(
    (item) => item.id === templateId && item.version === templateVersion
  );
  if (exact) {
    return { ok: true, template: exact };
  }
  const known = SPANS_WORKFLOW_CATALOG.some((item) => item.id === templateId);
  return refusal(
    known ? 'SPANS_WORKFLOW_VERSION_UNKNOWN' : 'SPANS_WORKFLOW_UNKNOWN',
    { field: 'templateId' }
  );
}

function readOptionalText(fields, key, maxLength) {
  const value = fields.get(key);
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  return isText(value, maxLength)
    ? { ok: true, value }
    : refusal('SPANS_WORKFLOW_INVALID', { field: key });
}

function readSubstitutions(item, raw) {
  const names = item.placeholders.map((slot) => slot.name);
  const read = readFields(raw, names, 'SPANS_WORKFLOW_PLACEHOLDER_UNKNOWN');
  if (read.ok === false) {
    return read;
  }
  const missing = names.filter((name) => !read.fields.has(name));
  if (missing.length > 0) {
    return refusal('SPANS_WORKFLOW_PLACEHOLDER_MISSING', { missing });
  }
  const values = new Map();
  for (const slot of item.placeholders) {
    const value = read.fields.get(slot.name);
    if (!isText(value, slot.maxLength)) {
      return refusal('SPANS_WORKFLOW_INVALID', { field: slot.name });
    }
    values.set(slot.name, value);
  }
  return { ok: true, values };
}

function readRequest(raw, allowed) {
  const read = readFields(raw, allowed, 'SPANS_WORKFLOW_FIELD_UNSUPPORTED');
  if (read.ok === false) {
    return read;
  }
  const { fields } = read;
  const found = findTemplate(
    fields.get('templateId'),
    fields.get('templateVersion')
  );
  if (found.ok === false) {
    return found;
  }
  const runId = fields.get('runId');
  if (typeof runId !== 'string' || !identifierPattern.test(runId)) {
    return refusal('SPANS_WORKFLOW_INVALID', { field: 'runId' });
  }
  const owner = fields.get('owner');
  if (!isText(owner, SPANS_WORKFLOW_LIMITS.ownerLength)) {
    return refusal('SPANS_WORKFLOW_INVALID', { field: 'owner' });
  }
  const project = readOptionalText(
    fields,
    'project',
    SPANS_WORKFLOW_LIMITS.projectLength
  );
  if (project.ok === false) {
    return project;
  }
  const worktree = readOptionalText(
    fields,
    'worktree',
    SPANS_WORKFLOW_LIMITS.worktreeLength
  );
  if (worktree.ok === false) {
    return worktree;
  }
  const substitutions = readSubstitutions(
    found.template,
    fields.get('substitutions')
  );
  if (substitutions.ok === false) {
    return substitutions;
  }
  return {
    digest: fields.get('digest'),
    ok: true,
    owner,
    project: project.value,
    runId,
    template: found.template,
    values: substitutions.values,
    worktree: worktree.value,
  };
}

// One pass over the template text. Values are inserted as-is and never scanned
// again, so a substitution cannot introduce or expand another placeholder.
function renderText(text, values) {
  return text.replace(placeholderPattern, (token, name) =>
    values.has(name) ? values.get(name) : token
  );
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

function digestOf(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function buildPreview(request) {
  const { owner, project, runId, template, values, worktree } = request;
  const evidence = template.spans.flatMap((span) =>
    span.acceptance.map((line) => `- ${span.spanId}: ${line}`)
  );
  const goal = `${renderText(template.goal, values)}\n\nAcceptance evidence:\n${evidence.join('\n')}`;
  const spans = template.spans.map((span) => ({
    dependencies: [...span.dependencies],
    spanId: span.spanId,
    title: renderText(span.title, values),
  }));
  const draft = redactSpansValue({
    goal,
    owner,
    project,
    runId,
    spans,
    worktree,
  });
  if (draft.runId !== runId) {
    return refusal('SPANS_WORKFLOW_INVALID', { field: 'runId' });
  }
  if (
    draft.goal.length > SPANS_WORKFLOW_LIMITS.goalLength ||
    draft.spans.some(
      (span) => span.title.length > SPANS_WORKFLOW_LIMITS.titleLength
    )
  ) {
    return refusal('SPANS_WORKFLOW_TOO_LARGE');
  }
  const acceptance = template.spans.map((span) => ({
    requirements: [...span.acceptance],
    spanId: span.spanId,
  }));
  return {
    acceptance,
    digest: digestOf({
      acceptance,
      draft,
      templateId: template.id,
      templateVersion: template.version,
    }),
    draft,
    ok: true,
    previewOnly: true,
    template: {
      id: template.id,
      kind: template.kind,
      title: template.title,
      version: template.version,
    },
  };
}

// Renders a preview for a caller to review. Nothing is stored or started.
export function previewSpansWorkflow(raw) {
  try {
    const request = readRequest(raw, requestFields);
    return request.ok === false ? request : buildPreview(request);
  } catch {
    return refusal('SPANS_WORKFLOW_INVALID');
  }
}

// Re-renders the reviewed inputs and compares the digest the caller saw.
export function verifySpansWorkflowPreview(raw) {
  try {
    const request = readRequest(raw, [...requestFields, 'digest']);
    if (request.ok === false) {
      return request;
    }
    if (
      typeof request.digest !== 'string' ||
      !digestPattern.test(request.digest)
    ) {
      return refusal('SPANS_WORKFLOW_DIGEST_INVALID', { field: 'digest' });
    }
    const preview = buildPreview(request);
    if (preview.ok === false) {
      return preview;
    }
    return preview.digest === request.digest
      ? preview
      : refusal('SPANS_WORKFLOW_DIGEST_MISMATCH', { field: 'digest' });
  } catch {
    return refusal('SPANS_WORKFLOW_INVALID');
  }
}

// Fresh metadata for CLI, MCP and UI pickers. Callers cannot change the catalog.
export function listSpansWorkflows() {
  return SPANS_WORKFLOW_CATALOG.map((item) => ({
    id: item.id,
    kind: item.kind,
    placeholders: item.placeholders.map((slot) => ({
      description: slot.description,
      maxLength: slot.maxLength,
      name: slot.name,
    })),
    spanCount: item.spans.length,
    summary: item.summary,
    title: item.title,
    version: item.version,
  }));
}
