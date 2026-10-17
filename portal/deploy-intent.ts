export interface DeploymentIntent {
  name: string;
  provider: 'vercel' | 'netlify' | 'convex';
  repo: string;
  target: string;
}
export type DeploymentContext = DeploymentIntent & {
  branch: string;
  identity: object;
  destination: {
    id: string;
    label: string;
    environment: string;
    projectId?: string;
    orgId?: string;
  };
  deploymentState: unknown;
};
export interface DeploymentResult {
  code?: string;
  error?: string;
  networkUncertain?: boolean;
  ok: boolean;
}
export type DeploymentPreflight = DeploymentResult & {
  requiresConfirmation?: boolean;
  expectedContext?: DeploymentContext;
};
export interface DeploymentIntentState {
  context?: DeploymentContext;
  intent?: DeploymentIntent;
  message?: string;
  phase: 'idle' | 'reading' | 'ready' | 'submitting' | 'error' | 'uncertain';
  requiresConfirmation?: boolean;
}
const key = (intent: DeploymentIntent) =>
  JSON.stringify([intent.provider, intent.repo, intent.name, intent.target]);

function validContext(
  intent: DeploymentIntent,
  response: DeploymentPreflight
): response is DeploymentPreflight & {
  requiresConfirmation: boolean;
  expectedContext: DeploymentContext;
} {
  const context = response.expectedContext;
  return !!(
    response.ok &&
    typeof response.requiresConfirmation === 'boolean' &&
    context &&
    key(context) === key(intent) &&
    typeof context.branch === 'string' &&
    context.branch &&
    context.identity &&
    typeof context.identity === 'object' &&
    !Array.isArray(context.identity) &&
    // biome-ignore lint/suspicious/noUnnecessaryConditions: expectedContext is untrusted preflight transport input; malformed destination must reject rather than throw in createDeploymentIntent.
    typeof context.destination?.id === 'string' &&
    context.destination.id &&
    typeof context.destination.label === 'string' &&
    context.destination.label &&
    typeof context.destination.environment === 'string' &&
    context.destination.environment &&
    Object.hasOwn(context, 'deploymentState')
  );
}

// Only a valid current preflight may reach dispatch. The context is passed
// back unchanged; the server owns its final comparison under admission.
export function createDeploymentIntent(io: {
  preflight: (
    intent: DeploymentIntent,
    signal: AbortSignal
  ) => Promise<DeploymentPreflight>;
  dispatch: (context: DeploymentContext) => Promise<DeploymentResult>;
  publish: (state: DeploymentIntentState) => void;
  result: (intent: DeploymentIntent, result: DeploymentResult) => void;
}) {
  let state: DeploymentIntentState = { phase: 'idle' },
    generation = 0;
  let read: AbortController | null = null,
    submitting = false,
    stopped = false;
  const reviewAgain = new Set<string>();
  const publish = (next: DeploymentIntentState) => {
    state = next;
    if (!stopped) {
      io.publish(next);
    }
  };

  async function preflight(
    intent: DeploymentIntent,
    requireReview: boolean,
    message?: string
  ) {
    read?.abort();
    const controller = new AbortController();
    read = controller;
    generation += 1;
    const own = generation;
    publish({ intent, message, phase: 'reading' });
    let response: DeploymentPreflight;
    try {
      response = await io.preflight(intent, controller.signal);
    } catch {
      response = {
        error:
          'Could not check this deployment target. Retry the preflight when the portal is available.',
        ok: false,
      };
    }
    if (stopped || own !== generation || controller.signal.aborted) {
      return;
    }
    read = null;
    if (!validContext(intent, response)) {
      const failure = {
        ...response,
        error:
          response.error ||
          'This portal did not return a verified deployment context. Update the portal before deploying.',
        ok: false,
      };
      publish({ intent, message: failure.error, phase: 'error' });
      io.result(intent, failure);
      return;
    }
    const context = response.expectedContext;
    publish({
      context,
      intent,
      message,
      phase: 'ready',
      requiresConfirmation: response.requiresConfirmation,
    });
    if (
      !(requireReview || response.requiresConfirmation) &&
      context.destination.environment !== 'production' &&
      intent.target !== 'production'
    ) {
      submit();
    }
  }
  async function submit() {
    if (
      stopped ||
      submitting ||
      state.phase !== 'ready' ||
      !state.context ||
      !state.intent
    ) {
      return;
    }
    submitting = true;
    const { context, intent } = state;
    publish({ ...state, message: undefined, phase: 'submitting' });
    let result: DeploymentResult;
    try {
      result = await io.dispatch(context);
    } catch {
      result = {
        error: 'Outcome not confirmed. Refresh status before trying again.',
        networkUncertain: true,
        ok: false,
      };
    }
    submitting = false;
    if (stopped) {
      return;
    }
    io.result(intent, result);
    if (result.ok) {
      reviewAgain.delete(key(intent));
      publish({ phase: 'idle' });
      return;
    }
    reviewAgain.add(key(intent));
    if (!state.intent) {
      return; // Closing a submitted dialog never cancels the request.
    }
    if (result.networkUncertain) {
      publish({
        intent,
        message:
          'Outcome not confirmed. Refresh deployment status before trying again. No request will be replayed automatically.',
        phase: 'uncertain',
      });
    } else if (result.code === 'DEPLOY_CONTEXT_CHANGED') {
      await preflight(
        intent,
        true,
        'The deployment context changed. Review the refreshed destination and confirm again.'
      );
    } else {
      publish({
        intent,
        message:
          result.error ||
          'Deployment was not accepted. Refresh the target context before trying again.',
        phase: 'error',
      });
    }
  }
  return {
    begin(intent: DeploymentIntent) {
      if (submitting) {
        return false;
      }
      if (
        state.phase === 'reading' &&
        state.intent &&
        key(state.intent) === key(intent)
      ) {
        return false;
      }
      preflight(intent, reviewAgain.has(key(intent)));
      return true;
    },
    close() {
      if (!submitting) {
        generation += 1;
        read?.abort();
        read = null;
      }
      publish({ phase: 'idle' });
    },
    confirm: () => {
      submit();
    },
    getState: () => state,
    refresh() {
      if (state.intent && !submitting && state.phase !== 'reading') {
        preflight(
          state.intent,
          true,
          'Review the current destination before submitting.'
        );
      }
    },
    stop() {
      stopped = true;
      generation += 1;
      read?.abort();
    },
  };
}
