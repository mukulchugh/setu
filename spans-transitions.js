const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isSpanId = (value) => typeof value === 'string' && value.length > 0;

function invalid(code, error) {
  return { code, error, ok: false };
}

function validDependencyList(value) {
  return Array.isArray(value) && value.every(isSpanId);
}

function validSpanNode(span) {
  return (
    isRecord(span) &&
    isSpanId(span.spanId) &&
    validDependencyList(span.dependencies)
  );
}

function hasDependencyCycle(graph) {
  const remainingDependencies = new Map();
  const dependents = new Map();
  for (const [spanId, dependencies] of graph) {
    remainingDependencies.set(spanId, dependencies.length);
    for (const dependencyId of dependencies) {
      const list = dependents.get(dependencyId) ?? [];
      list.push(spanId);
      dependents.set(dependencyId, list);
    }
  }

  const ready = [...remainingDependencies]
    .filter(([, count]) => count === 0)
    .map(([spanId]) => spanId);
  let visited = 0;
  while (ready.length > 0) {
    const spanId = ready.pop();
    visited += 1;
    for (const dependentId of dependents.get(spanId) ?? []) {
      const remaining = remainingDependencies.get(dependentId) - 1;
      remainingDependencies.set(dependentId, remaining);
      if (remaining === 0) {
        ready.push(dependentId);
      }
    }
  }
  return visited !== graph.size;
}

export function validateSpanDependencies(input) {
  if (
    !(
      isRecord(input) &&
      isSpanId(input.spanId) &&
      validDependencyList(input.dependencies) &&
      Array.isArray(input.spans)
    )
  ) {
    return invalid(
      'DEPENDENCY_INPUT_INVALID',
      'spanId, dependencies, and spans must use the expected format.'
    );
  }

  // spans lists the other graph nodes; spanId and dependencies describe the
  // candidate node being checked.
  const graph = new Map();
  for (const span of input.spans) {
    if (!validSpanNode(span)) {
      return invalid(
        'DEPENDENCY_INPUT_INVALID',
        'Each span must have a spanId and dependency list.'
      );
    }
    if (graph.has(span.spanId)) {
      return invalid('SPAN_ID_DUPLICATE', 'Span IDs must be unique.');
    }
    graph.set(span.spanId, [...span.dependencies]);
  }

  if (graph.has(input.spanId)) {
    return invalid('SPAN_ID_DUPLICATE', 'Span IDs must be unique.');
  }
  graph.set(input.spanId, [...input.dependencies]);

  for (const [currentSpanId, dependencies] of graph) {
    if (dependencies.includes(currentSpanId)) {
      return invalid('DEPENDENCY_SELF', 'A span cannot depend on itself.');
    }
  }

  for (const dependencies of graph.values()) {
    if (dependencies.some((dependencyId) => !graph.has(dependencyId))) {
      return invalid(
        'DEPENDENCY_MISSING',
        'Every dependency must name an existing span.'
      );
    }
  }

  if (hasDependencyCycle(graph)) {
    return invalid('DEPENDENCY_CYCLE', 'Dependency graph contains a cycle.');
  }
  return { ok: true };
}

export function validateCoordinatorGeneration(input) {
  if (
    !(
      isRecord(input) &&
      isValidGeneration(input.expectedGeneration) &&
      isValidGeneration(input.currentGeneration)
    )
  ) {
    return invalid(
      'GENERATION_INVALID',
      'Coordinator generations must be nonnegative safe integers.'
    );
  }
  if (input.expectedGeneration !== input.currentGeneration) {
    return invalid('STALE_GENERATION', 'The coordinator generation is stale.');
  }
  return { ok: true };
}

function isValidGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evaluateDependencyReadiness(input) {
  if (!isReadinessInput(input)) {
    return invalid(
      'DEPENDENCY_INPUT_INVALID',
      'dependencies and acceptedCompletions must use the expected format.'
    );
  }

  // The caller supplies an already-accepted snapshot and fences result
  // acceptance by coordinator generation before updating that snapshot.
  const verifiedSpanIds = new Set(
    input.acceptedCompletions
      .filter((completion) => completion.verified === true)
      .map((completion) => completion.spanId)
  );
  const waitingFor = [...new Set(input.dependencies)]
    .filter((dependencyId) => !verifiedSpanIds.has(dependencyId))
    .sort();

  return { ok: true, ready: waitingFor.length === 0, waitingFor };
}

function isReadinessInput(input) {
  return (
    isRecord(input) &&
    validDependencyList(input.dependencies) &&
    Array.isArray(input.acceptedCompletions) &&
    input.acceptedCompletions.every(isCompletionRecord)
  );
}

function isCompletionRecord(completion) {
  return (
    isRecord(completion) &&
    isSpanId(completion.spanId) &&
    typeof completion.verified === 'boolean'
  );
}
