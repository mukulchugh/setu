// Offline Spans planning facade for portal, CLI and MCP. It composes the
// reviewed workflow previews with the caller-owned draft store and adds no
// state of its own. It never approves, dispatches, starts processes or agents,
// calls providers, reads configuration, imports or exports.

import { createSpansDrafts } from './spans-drafts.js';
import {
  listSpansWorkflows,
  previewSpansWorkflow,
  verifySpansWorkflowPreview,
} from './spans-workflows.js';

const planningFailure = Object.freeze({
  code: 'SPANS_PLANNING_FAILED',
  error: 'Spans planning could not complete.',
});

// An adapter exception becomes this one fixed refusal, so no store path, stack
// or caller value leaves the facade.
function guarded(operation) {
  try {
    return operation();
  } catch {
    return { ...planningFailure, ok: false };
  }
}

// The verifier reads the request once, before any store call. It re-renders the
// preview and compares the digest, so a missing or changed digest writes nothing.
function createFromVerifiedPreview(drafts, raw) {
  const verified = verifySpansWorkflowPreview(raw);
  return verified.ok === false ? verified : drafts.createRun(verified.draft);
}

// options must be exactly { store }; createSpansDrafts refuses anything else.
export function createSpansPlanning(options) {
  const drafts = createSpansDrafts(options);
  return Object.freeze({
    createDraft: (raw) => guarded(() => drafts.createRun(raw)),
    createFromWorkflow: (raw) =>
      guarded(() => createFromVerifiedPreview(drafts, raw)),
    listWorkflows: () =>
      guarded(() => ({ ok: true, templates: listSpansWorkflows() })),
    previewWorkflow: (raw) => guarded(() => previewSpansWorkflow(raw)),
    revisePlan: (raw) => guarded(() => drafts.revisePlan(raw)),
  });
}
