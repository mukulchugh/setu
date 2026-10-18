// The attention list as a person sees it: the provider hook events Setu already records, and the attention
// requests Links retains, in one list. Opening a request is the existing focus action with the exact
// conversation attached. Nothing here writes: reading never notifies, and nothing starts a turn.

// What the response says about the Links part of the list: where to continue, or why it is missing.
function linksPart(mine) {
  if (!mine.ok) {
    return { code: mine.code, error: mine.error, state: 'unavailable' };
  }
  return {
    hasMore: mine.hasMore,
    next: mine.next,
    notifications: mine.notifications,
    state: 'ok',
  };
}

export function createLinksAttention({ links, focus, listProvider } = {}) {
  if (
    !(
      typeof links?.attentionList === 'function' &&
      typeof links.attentionTarget === 'function' &&
      typeof focus === 'function' &&
      typeof listProvider === 'function'
    )
  ) {
    throw new TypeError(
      'The attention composition needs Links, the focus action and the provider list'
    );
  }

  // Provider events keep their own order and meaning; Links entries join them by time. Links being down
  // never hides a provider event, and is said, not guessed at. The message text is the person's own view:
  // a reader asks for it by name (`withMessage: true`) and every other reader gets none.
  //
  // `before` (a cursor from `links.next`) and `limit` page the retained requests. An older page carries only
  // Links entries: the provider events are listed once, with the first page, and are not repeated.
  async function list(input = {}, { withMessage = false } = {}) {
    const mine = await links.attentionList({
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      withMessage,
    });
    if (!mine.ok && mine.code === 'LINKS_INVALID') {
      return mine;
    }
    const page = { links: linksPart(mine) };
    if (input.before !== undefined) {
      // Listed oldest to newest like the first page, so the pages read as one timeline.
      const events = mine.ok
        ? [...mine.entries].sort((a, b) => a.at - b.at)
        : [];
      return { events, ok: true, ...page };
    }
    const provider = await listProvider(input);
    if (!provider.ok) {
      return provider;
    }
    const events = mine.ok
      ? [...provider.events, ...mine.entries].sort((a, b) => a.at - b.at)
      : provider.events;
    return { ...provider, events, ...page };
  }

  // Verify the exact conversation, then use the existing focus action, which verifies the session, checkout
  // and terminal again at the effect and records the outcome like any other focus.
  async function open({ attentionId, source } = {}) {
    const verified = await links.attentionTarget({ attentionId });
    if (!verified.ok) {
      return verified;
    }
    return await focus({ ...verified.focus, source });
  }

  return Object.freeze({ list, open });
}
