import { useEffect, useRef, useState } from 'preact/hooks';
import {
  createSpansPlanningDraft,
  createSpansRequestGuard,
  listSpansPlanningWorkflows,
  previewSpansPlanningWorkflow,
  type SpansWorkflowInput,
  type SpansWorkflowPreview,
  type SpansWorkflowTemplate,
  serializeSpansWorkflowInput,
} from '../spans-planning';
import { inputCls } from '../ui';
import { Button } from '../ui/button';

interface FormState {
  owner: string;
  project: string;
  runId: string;
  substitutions: Record<string, string>;
  templateId: string;
  worktree: string;
}

interface ReviewedPreview {
  input: SpansWorkflowInput;
  result: SpansWorkflowPreview;
}

const initialForm: FormState = {
  owner: '',
  project: '',
  runId: '',
  substitutions: {},
  templateId: '',
  worktree: '',
};

function buildInput(
  form: FormState,
  template: SpansWorkflowTemplate
): SpansWorkflowInput {
  return serializeSpansWorkflowInput({
    owner: form.owner,
    project: form.project,
    runId: form.runId,
    substitutions: Object.fromEntries(
      template.placeholders.map(({ name }) => [
        name,
        form.substitutions[name] ?? '',
      ])
    ),
    templateId: template.id,
    templateVersion: template.version,
    worktree: form.worktree,
  });
}

export function SpansPlanning({
  onCreated,
}: {
  onCreated: (runId: string) => void;
}) {
  const [templates, setTemplates] = useState<SpansWorkflowTemplate[]>([]);
  const [form, setForm] = useState(initialForm);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<ReviewedPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const templatesGuard = useRef(createSpansRequestGuard());
  const previewGuard = useRef(createSpansRequestGuard());
  const mounted = useRef(false);
  const saveTicket = useRef(0);
  const selected = templates.find((item) => item.id === form.templateId);
  let saveLabel = 'Save draft';
  if (saveError) {
    saveLabel = 'Retry exact save';
  }
  if (saving) {
    saveLabel = 'Saving draft…';
  }

  const loadTemplates = async () => {
    const request = templatesGuard.current.begin();
    setLoadingTemplates(true);
    setTemplatesFailed(false);
    try {
      const result = await listSpansPlanningWorkflows(request.signal);
      if (templatesGuard.current.isCurrent(request.ticket)) {
        setTemplates(result);
      }
    } catch {
      if (templatesGuard.current.isCurrent(request.ticket)) {
        setTemplatesFailed(true);
      }
    } finally {
      if (templatesGuard.current.isCurrent(request.ticket)) {
        setLoadingTemplates(false);
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    loadTemplates();
    return () => {
      mounted.current = false;
      saveTicket.current += 1;
      templatesGuard.current.invalidate();
      previewGuard.current.invalidate();
    };
  }, []);

  const invalidatePreview = () => {
    previewGuard.current.invalidate();
    setPreview(null);
    setPreviewError(null);
    setSaveError(null);
    setPreviewBusy(false);
  };

  const edit = (update: (current: FormState) => FormState) => {
    invalidatePreview();
    setFormError(null);
    setForm(update);
  };

  const submitPreview = (event: SubmitEvent) => {
    event.preventDefault();
    setFormError(null);
    previewCurrent();
  };

  const reportInvalidForm = () => {
    setFormError(
      'Complete the required fields and correct any invalid values.'
    );
  };

  const previewCurrent = async () => {
    if (!selected) {
      setPreviewError('Choose a workflow template before previewing.');
      return;
    }
    const input = buildInput(form, selected);
    const request = previewGuard.current.begin();
    setPreview(null);
    setPreviewError(null);
    setSaveError(null);
    setPreviewBusy(true);
    try {
      const result = await previewSpansPlanningWorkflow(input, request.signal);
      if (previewGuard.current.isCurrent(request.ticket)) {
        setPreview({ input, result });
      }
    } catch (error) {
      if (previewGuard.current.isCurrent(request.ticket)) {
        setPreviewError(
          error instanceof Error
            ? error.message
            : 'Spans preview is unavailable. Review the fields and try again.'
        );
      }
    } finally {
      if (previewGuard.current.isCurrent(request.ticket)) {
        setPreviewBusy(false);
      }
    }
  };

  const saveDraft = async () => {
    if (!preview || saving) {
      return;
    }
    saveTicket.current += 1;
    const ticket = saveTicket.current;
    setSaving(true);
    setSaveError(null);
    try {
      // This is the original reviewed form snapshot plus its digest. The
      // redacted display object is intentionally never sent to create.
      const created = await createSpansPlanningDraft(
        preview.input,
        preview.result.digest
      );
      if (mounted.current && ticket === saveTicket.current) {
        onCreated(created.runId);
      }
    } catch (error) {
      if (mounted.current && ticket === saveTicket.current) {
        setSaveError(
          error instanceof Error
            ? error.message
            : 'The Spans planning request may not have completed. Retry this exact save.'
        );
      }
    } finally {
      if (mounted.current && ticket === saveTicket.current) {
        setSaving(false);
      }
    }
  };

  return (
    <section
      aria-labelledby="spans-planning-title"
      class="mx-auto max-w-4xl px-4 py-6 sm:px-6"
    >
      <header class="mb-6">
        <h1
          class="font-semibold text-xl text-zinc-900 dark:text-zinc-100"
          id="spans-planning-title"
        >
          Plan a workflow
        </h1>
        <p class="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
          Review the redacted plan before saving. Saving creates a Planned
          record only; it does not start agents or change worktrees.
        </p>
      </header>

      {templatesFailed && (
        <div class="read-notice mb-4" role="alert">
          <p>Spans workflows are unavailable. Try again.</p>
          <Button
            compact
            disabled={loadingTemplates}
            onClick={() => loadTemplates()}
            variant="secondary"
          >
            Retry workflow list
          </Button>
        </div>
      )}

      <form onInvalidCapture={reportInvalidForm} onSubmit={submitPreview}>
        <fieldset
          aria-busy={loadingTemplates || saving}
          class="min-w-0"
          disabled={saving}
        >
          <legend class="sr-only">Workflow plan details</legend>
          <div class="grid min-w-0 gap-x-5 gap-y-4 sm:grid-cols-2">
            <label
              class="min-w-0 text-sm text-zinc-700 sm:col-span-2 dark:text-zinc-200"
              htmlFor="spans-planning-template"
            >
              Workflow template
              <select
                class={`${inputCls} mt-1 block w-full`}
                disabled={loadingTemplates || templates.length === 0}
                id="spans-planning-template"
                onChange={(event) => {
                  const templateId = event.currentTarget.value;
                  const template = templates.find(
                    (item) => item.id === templateId
                  );
                  edit((current) => ({
                    ...current,
                    substitutions: template
                      ? Object.fromEntries(
                          template.placeholders.map(({ name }) => [name, ''])
                        )
                      : {},
                    templateId,
                  }));
                }}
                required
                value={form.templateId}
              >
                <option value="">
                  {loadingTemplates
                    ? 'Loading workflows…'
                    : 'Choose a workflow'}
                </option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.title} (v{template.version})
                  </option>
                ))}
              </select>
              {selected && (
                <span class="mt-1 block text-xs text-zinc-600 dark:text-zinc-300">
                  {selected.summary} {selected.spanCount} planned spans.
                </span>
              )}
            </label>

            <label
              class="min-w-0 text-sm text-zinc-700 dark:text-zinc-200"
              htmlFor="spans-planning-owner"
            >
              Owner
              <input
                autoComplete="off"
                class={`${inputCls} mt-1 block w-full`}
                id="spans-planning-owner"
                maxLength={64}
                onInput={(event) => {
                  const owner = event.currentTarget.value;
                  edit((current) => ({ ...current, owner }));
                }}
                required
                value={form.owner}
              />
            </label>
            <label
              class="min-w-0 text-sm text-zinc-700 dark:text-zinc-200"
              htmlFor="spans-planning-run-id"
            >
              Run ID
              <input
                autoComplete="off"
                class={`${inputCls} mt-1 block w-full font-mono`}
                id="spans-planning-run-id"
                maxLength={128}
                onInput={(event) => {
                  const runId = event.currentTarget.value;
                  edit((current) => ({ ...current, runId }));
                }}
                pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"
                required
                value={form.runId}
              />
            </label>
            <label
              class="min-w-0 text-sm text-zinc-700 dark:text-zinc-200"
              htmlFor="spans-planning-project"
            >
              Project{' '}
              <span class="font-normal text-zinc-600 dark:text-zinc-300">
                (optional)
              </span>
              <input
                autoComplete="off"
                class={`${inputCls} mt-1 block w-full`}
                id="spans-planning-project"
                maxLength={128}
                onInput={(event) => {
                  const project = event.currentTarget.value;
                  edit((current) => ({ ...current, project }));
                }}
                value={form.project}
              />
            </label>
            <label
              class="min-w-0 text-sm text-zinc-700 dark:text-zinc-200"
              htmlFor="spans-planning-worktree"
            >
              Worktree{' '}
              <span class="font-normal text-zinc-600 dark:text-zinc-300">
                (optional)
              </span>
              <input
                autoComplete="off"
                class={`${inputCls} mt-1 block w-full`}
                id="spans-planning-worktree"
                maxLength={1024}
                onInput={(event) => {
                  const worktree = event.currentTarget.value;
                  edit((current) => ({ ...current, worktree }));
                }}
                value={form.worktree}
              />
            </label>
          </div>

          {selected && selected.placeholders.length > 0 && (
            <fieldset class="mt-5 min-w-0 border-zinc-200/70 border-t pt-4 dark:border-white/10">
              <legend class="font-medium text-sm text-zinc-900 dark:text-zinc-100">
                Template fields
              </legend>
              <div class="mt-3 grid min-w-0 gap-x-5 gap-y-4 sm:grid-cols-2">
                {selected.placeholders.map((placeholder) => {
                  const { description, maxLength, name } = placeholder;
                  const substitution = form.substitutions[name] ?? '';
                  return (
                    <label
                      class="min-w-0 text-sm text-zinc-700 dark:text-zinc-200"
                      htmlFor={`spans-planning-${name}`}
                      key={name}
                    >
                      {name}
                      <span class="mt-0.5 block text-xs text-zinc-600 dark:text-zinc-300">
                        {description}
                      </span>
                      {maxLength > 240 ? (
                        <textarea
                          class={`${inputCls} mt-1 block min-h-24 w-full resize-y`}
                          id={`spans-planning-${name}`}
                          maxLength={maxLength}
                          onInput={(event) => {
                            const { value } = event.currentTarget;
                            edit((current) => ({
                              ...current,
                              substitutions: {
                                ...current.substitutions,
                                [name]: value,
                              },
                            }));
                          }}
                          required
                          value={substitution}
                        />
                      ) : (
                        <input
                          class={`${inputCls} mt-1 block w-full`}
                          id={`spans-planning-${name}`}
                          maxLength={maxLength}
                          onInput={(event) => {
                            const { value } = event.currentTarget;
                            edit((current) => ({
                              ...current,
                              substitutions: {
                                ...current.substitutions,
                                [name]: value,
                              },
                            }));
                          }}
                          required
                          value={substitution}
                        />
                      )}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
        </fieldset>

        <div class="mt-5 flex flex-wrap items-center gap-3">
          <Button
            disabled={loadingTemplates || previewBusy || saving}
            type="submit"
          >
            {previewBusy ? 'Preparing preview…' : 'Preview plan'}
          </Button>
          {previewBusy && (
            <span
              class="text-sm text-zinc-600 dark:text-zinc-300"
              role="status"
            >
              Preparing a redacted preview…
            </span>
          )}
        </div>

        {previewError && (
          <p class="mt-3 text-signal-red text-sm" role="alert">
            {previewError}
          </p>
        )}
        {formError && (
          <p class="mt-3 text-signal-red text-sm" role="alert">
            {formError}
          </p>
        )}
      </form>

      {preview && (
        <section
          aria-busy={saving}
          aria-labelledby="spans-preview-title"
          class="mt-6 min-w-0 border-zinc-200/70 border-t pt-5 dark:border-white/10"
        >
          <div class="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
            <h2
              class="font-semibold text-lg text-zinc-900 dark:text-zinc-100"
              id="spans-preview-title"
            >
              Reviewed preview
            </h2>
            <span class="font-mono text-xs text-zinc-600 dark:text-zinc-300">
              {`${preview.result.template.title} · version ${preview.result.template.version}`}
            </span>
          </div>
          <dl class="mt-4 grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2">
            <div class="min-w-0">
              <dt class="font-semibold text-xs text-zinc-600 dark:text-zinc-300">
                Run ID
              </dt>
              <dd class="mt-1 break-all font-mono text-sm text-zinc-900 dark:text-zinc-100">
                {preview.result.draft.runId}
              </dd>
            </div>
            <div class="min-w-0">
              <dt class="font-semibold text-xs text-zinc-600 dark:text-zinc-300">
                Owner
              </dt>
              <dd class="mt-1 break-words text-sm text-zinc-900 dark:text-zinc-100">
                {preview.result.draft.owner}
              </dd>
            </div>
            {(preview.result.draft.project ||
              preview.result.draft.worktree) && (
              <div class="min-w-0 sm:col-span-2">
                <dt class="font-semibold text-xs text-zinc-600 dark:text-zinc-300">
                  Target
                </dt>
                <dd class="mt-1 break-all text-sm text-zinc-900 dark:text-zinc-100">
                  {[preview.result.draft.project, preview.result.draft.worktree]
                    .filter(Boolean)
                    .join(' / ')}
                </dd>
              </div>
            )}
          </dl>
          <div class="mt-5 min-w-0">
            <h3 class="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
              Goal
            </h3>
            <p class="mt-1 max-w-3xl whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-200">
              {preview.result.draft.goal}
            </p>
          </div>
          <div class="mt-5 min-w-0">
            <h3 class="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
              Spans and dependencies
            </h3>
            <ol class="mt-2 divide-y divide-zinc-200/70 dark:divide-white/10">
              {preview.result.draft.spans.map((span) => {
                const acceptance = preview.result.acceptance.find(
                  (item) => item.spanId === span.spanId
                );
                return (
                  <li class="min-w-0 py-3" key={span.spanId}>
                    <p class="break-words font-medium text-sm text-zinc-900 dark:text-zinc-100">
                      {span.title}
                    </p>
                    <p class="mt-1 break-words text-xs text-zinc-600 dark:text-zinc-300">
                      {span.dependencies.length
                        ? `Depends on: ${span.dependencies.join(', ')}`
                        : 'No dependencies'}
                    </p>
                    {acceptance && (
                      <div class="mt-2">
                        <h4 class="font-semibold text-xs text-zinc-700 dark:text-zinc-200">
                          Acceptance
                        </h4>
                        <ul class="mt-1 list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-200">
                          {acceptance.requirements.map((requirement) => (
                            <li class="break-words" key={requirement}>
                              {requirement}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
          {saveError && (
            <p class="mt-3 text-signal-red text-sm" role="alert">
              {saveError}
            </p>
          )}
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <Button disabled={saving} onClick={() => saveDraft()}>
              {saveLabel}
            </Button>
            {saving && (
              <span
                class="text-sm text-zinc-600 dark:text-zinc-300"
                role="status"
              >
                Saving the reviewed draft…
              </span>
            )}
            <span class="text-xs text-zinc-600 dark:text-zinc-300">
              New drafts stay Planned. Saving does not dispatch or approve work.
            </span>
          </div>
        </section>
      )}
    </section>
  );
}
