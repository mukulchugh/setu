import { afterEach, expect, test } from 'bun:test';
import { Component, h, options, type VNode } from 'preact';
import { createLinksService } from './links-service.js';
import { LinksPage, MessageDetail } from './portal/components/links-page';
import { type LinksMessage, linksTarget } from './portal/links-read';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    (globalThis as { window?: unknown }).window = undefined;
  }
});

const first = { name: 'topic', repo: 'repo', sessionId: 'session-a' };
const second = { name: 'topic', repo: 'repo', sessionId: 'session-b' };
const managedFirst = {
  ...first,
  lastHookAt: 1,
  nativeConversation: { provider: 'claude-code', state: 'bound' },
  ownership: 'owned',
  state: 'running',
  tool: 'claude-code',
};

const message = (state: string): LinksMessage => ({
  attemptId: state === 'handoff-unknown' ? 'attempt-1' : null,
  attempts: 0,
  body: 'Message',
  createdAt: 1,
  expiresAt: 2,
  messageId: 'message-1',
  reason: null,
  recipient: { provider: 'claude-code', sessionId: first.sessionId },
  redeliveries: 0,
  replyTo: null,
  runHint: null,
  sender: { kind: 'user' },
  size: 7,
  state,
  storedState: state,
  updatedAt: 1,
});

function installSessionStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    },
  });
  return values;
}

function renderComponent(component: any, props: object) {
  const vnode = h(component, props);
  (vnode as any).__c = new Component(vnode.props);
  const render = () => {
    (options as any).__r(vnode);
    return component(vnode.props);
  };
  return { render };
}

function renderWithHooks() {
  return renderComponent(LinksPage, { onBack: () => undefined, projects: [] });
}

function find(
  value: unknown,
  match: (vnode: VNode<any>) => boolean
): VNode<any> | undefined {
  if (!value || typeof value !== 'object') {
    return;
  }
  const vnode = value as VNode<any>;
  if (vnode.type && match(vnode)) {
    return vnode;
  }
  const children = vnode.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = find(child, match);
    if (found) {
      return found;
    }
  }
}

function detailButtons(
  state: string,
  target = first,
  busy: string | null = null,
  stale = false
) {
  const tree = MessageDetail({
    busy,
    loading: false,
    message: message(state),
    onAck: () => undefined,
    onCancel: () => undefined,
    onRedeliver: () => undefined,
    stale,
    target,
  });
  return {
    acknowledge: find(tree, (vnode) => vnode.props?.children === 'Acknowledge'),
    cancel: find(tree, (vnode) => vnode.props?.children === 'Cancel message'),
  };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test('message actions mirror engine eligibility and require the current recipient target', () => {
  expect(detailButtons('queued').acknowledge?.props.disabled).toBe(true);
  expect(detailButtons('queued').cancel?.props.disabled).toBe(false);
  expect(detailButtons('held').cancel?.props.disabled).toBe(false);
  expect(detailButtons('handed-off').acknowledge?.props.disabled).toBe(false);
  expect(detailButtons('handed-off').cancel?.props.disabled).toBe(true);
  expect(detailButtons('acknowledged').acknowledge?.props.disabled).toBe(false);
  expect(detailButtons('handoff-unknown').acknowledge?.props.disabled).toBe(
    true
  );
  expect(detailButtons('handoff-unknown').cancel?.props.disabled).toBe(true);
  expect(detailButtons('cancelled').acknowledge?.props.disabled).toBe(true);
  expect(detailButtons('cancelled').cancel?.props.disabled).toBe(true);
  expect(
    detailButtons('handed-off', { ...first, sessionId: second.sessionId })
      .acknowledge?.props.disabled
  ).toBe(true);
  expect(
    detailButtons('handed-off', first, null, true).acknowledge?.props.disabled
  ).toBe(true);
  expect(
    detailButtons('queued', first, null, true).cancel?.props.disabled
  ).toBe(true);
});

test('message action busy labels match their current mutation names', () => {
  const acknowledging = MessageDetail({
    busy: 'Acknowledge',
    loading: false,
    message: message('handed-off'),
    onAck: () => undefined,
    onCancel: () => undefined,
    onRedeliver: () => undefined,
    target: first,
  });
  const cancelling = MessageDetail({
    busy: 'Cancel',
    loading: false,
    message: message('queued'),
    onAck: () => undefined,
    onCancel: () => undefined,
    onRedeliver: () => undefined,
    target: first,
  });
  expect(
    find(acknowledging, (vnode) => vnode.props?.children === 'Acknowledging…')
  ).toBeDefined();
  expect(
    find(cancelling, (vnode) => vnode.props?.children === 'Cancelling…')
  ).toBeDefined();
});

test('a send does not start until its recovery key is saved, then retries after storage recovers', async () => {
  const values = installSessionStorage();
  const storageAvailable = { current: false };
  let posted = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => {
          if (Boolean(storageAvailable.current) === false) {
            throw new Error('storage unavailable');
          }
          values.set(key, value);
        },
      },
    },
  });
  globalThis.fetch = (() => {
    posted += 1;
    return Promise.resolve(Response.json({ ok: true, state: 'queued' }));
  }) as typeof fetch;
  const page = renderWithHooks();
  let tree = page.render();
  const picker = find(
    tree,
    (vnode) =>
      typeof vnode.type === 'function' && vnode.type.name === 'SessionPicker'
  );
  picker?.props.onSelect(first);
  await flush();
  tree = page.render();
  find(tree, (vnode) => vnode.type === 'textarea')?.props.onInput({
    currentTarget: { value: 'keep this draft' },
  });
  await flush();
  tree = page.render();
  find(
    tree,
    (vnode) => vnode.props?.children === 'Send message'
  )?.props.onClick();
  await flush();
  expect(posted).toBe(0);
  expect(JSON.stringify(page.render())).toContain('This send was not started');
  storageAvailable.current = true;
  tree = page.render();
  find(
    tree,
    (vnode) => vnode.props?.children === 'Send message'
  )?.props.onClick();
  await flush();
  expect(posted).toBe(1);
});

test('a recovery key remains available when confirmed-send cleanup cannot remove it', async () => {
  const values = installSessionStorage();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: () => {
          throw new Error('storage unavailable');
        },
        setItem: (key: string, value: string) => values.set(key, value),
      },
    },
  });
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({ ok: true, state: 'queued' })
    )) as typeof fetch;
  const page = renderWithHooks();
  let tree = page.render();
  const picker = find(
    tree,
    (vnode) =>
      typeof vnode.type === 'function' && vnode.type.name === 'SessionPicker'
  );
  picker?.props.onSelect(first);
  await flush();
  tree = page.render();
  find(tree, (vnode) => vnode.type === 'textarea')?.props.onInput({
    currentTarget: { value: 'keep this draft' },
  });
  await flush();
  tree = page.render();
  find(
    tree,
    (vnode) => vnode.props?.children === 'Send message'
  )?.props.onClick();
  await flush();
  expect(values.get('setu-links-pending-send/v1')).toContain('keep this draft');
  expect(JSON.stringify(page.render())).toContain('could not be cleared');
});

test('a late send response cannot clear a changed draft or claim the next target', async () => {
  installSessionStorage();
  let finish: (value: unknown) => void = () => undefined;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      finish = (value) => resolve(Response.json(value));
    })) as typeof fetch;
  const page = renderWithHooks();
  let tree = page.render();
  const picker = find(
    tree,
    (vnode) =>
      typeof vnode.type === 'function' && vnode.type.name === 'SessionPicker'
  );
  if (!picker) {
    throw new Error('Expected session picker');
  }
  picker.props.onSelect(first);
  await flush();
  tree = page.render();
  const body = find(tree, (vnode) => vnode.type === 'textarea');
  if (!body) {
    throw new Error('Expected message input');
  }
  body.props.onInput({ currentTarget: { value: 'keep this draft' } });
  await flush();
  tree = page.render();
  const send = find(tree, (vnode) => vnode.props?.children === 'Send message');
  if (!send) {
    throw new Error('Expected send action');
  }
  send.props.onClick();
  await flush();
  picker.props.onSelect(second);
  await flush();
  tree = page.render();
  finish({ messageId: 'm_1', ok: true, replayed: false, state: 'queued' });
  await flush();
  tree = page.render();
  const retained = find(tree, (vnode) => vnode.type === 'textarea');
  expect(retained?.props.value).toBe('keep this draft');
  const report = find(
    tree,
    (vnode) =>
      vnode.props?.role === 'status' &&
      vnode.props?.children ===
        'Send response cannot update a changed selection or draft.'
  );
  expect(report).toBeDefined();
});

test('network-uncertain send recovery retains the exact key and blocks a changed draft', async () => {
  installSessionStorage();
  const posted: unknown[] = [];
  globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      Response.json({ networkUncertain: true, ok: false })
    );
  }) as typeof fetch;
  const page = renderWithHooks();
  let tree = page.render();
  const picker = find(
    tree,
    (vnode) =>
      typeof vnode.type === 'function' && vnode.type.name === 'SessionPicker'
  );
  if (!picker) {
    throw new Error('Expected session picker');
  }
  picker.props.onSelect(first);
  await flush();
  tree = page.render();
  const body = find(tree, (vnode) => vnode.type === 'textarea');
  body?.props.onInput({ currentTarget: { value: 'first body' } });
  await flush();
  tree = page.render();
  const send = find(tree, (vnode) => vnode.props?.children === 'Send message');
  send?.props.onClick();
  await flush();
  tree = page.render();
  expect(JSON.stringify(tree)).toContain(
    'possibly committed send remains unresolved'
  );
  const changed = find(tree, (vnode) => vnode.type === 'textarea');
  changed?.props.onInput({ currentTarget: { value: 'changed body' } });
  await flush();
  tree = page.render();
  expect(JSON.stringify(tree)).toContain('Restore original draft');
  const blocked = find(
    tree,
    (vnode) => vnode.props?.children === 'Restore exact draft to retry'
  );
  expect(blocked?.props.disabled).toBe(true);
  expect(posted).toHaveLength(1);
});

test('a late success for the same target cannot clear a changed body', async () => {
  const stored = installSessionStorage();
  let finish: (value: unknown) => void = () => undefined;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      finish = (value) => resolve(Response.json(value));
    })) as typeof fetch;
  const page = renderWithHooks();
  let tree = page.render();
  const picker = find(
    tree,
    (vnode) =>
      typeof vnode.type === 'function' && vnode.type.name === 'SessionPicker'
  );
  picker?.props.onSelect(managedFirst);
  await flush();
  tree = page.render();
  const body = find(tree, (vnode) => vnode.type === 'textarea');
  body?.props.onInput({ currentTarget: { value: 'first body' } });
  await flush();
  tree = page.render();
  find(
    tree,
    (vnode) => vnode.props?.children === 'Send message'
  )?.props.onClick();
  await flush();
  tree = page.render();
  find(tree, (vnode) => vnode.type === 'textarea')?.props.onInput({
    currentTarget: { value: 'changed body' },
  });
  await flush();
  tree = page.render();
  finish({ messageId: 'm_1', ok: true, replayed: false, state: 'queued' });
  await flush();
  tree = page.render();
  expect(find(tree, (vnode) => vnode.type === 'textarea')?.props.value).toBe(
    'changed body'
  );
  expect(stored.get('setu-links-pending-send/v1')).toBeUndefined();
});

test('an unresolved send survives a fresh route render and retries only its saved key', async () => {
  installSessionStorage();
  const posted: Record<string, unknown>[] = [];
  globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      Response.json({ code: 'LINKS_OUTCOME_UNKNOWN', ok: false })
    );
  }) as typeof fetch;
  const page = renderWithHooks();
  let tree = page.render();
  const picker = find(
    tree,
    (vnode) =>
      typeof vnode.type === 'function' && vnode.type.name === 'SessionPicker'
  );
  picker?.props.onSelect(managedFirst);
  await flush();
  tree = page.render();
  find(tree, (vnode) => vnode.type === 'textarea')?.props.onInput({
    currentTarget: { value: 'original body' },
  });
  await flush();
  tree = page.render();
  find(
    tree,
    (vnode) => vnode.props?.children === 'Send message'
  )?.props.onClick();
  await flush();

  const reloaded = renderWithHooks();
  tree = reloaded.render();
  const restore = find(
    tree,
    (vnode) => vnode.props?.children === 'Restore original draft'
  );
  expect(restore?.props.disabled).toBe(false);
  restore?.props.onClick();
  await flush();
  tree = reloaded.render();
  expect(find(tree, (vnode) => vnode.type === 'textarea')?.props.value).toBe(
    'original body'
  );
  find(
    tree,
    (vnode) => vnode.props?.children === 'Retry exact send with same key'
  )?.props.onClick();
  await flush();
  expect(posted).toHaveLength(2);
  expect(posted[1].idempotencyKey).toBe(posted[0].idempotencyKey);
});

test('a full selected session is narrowed before strict service send, acknowledgement, and redelivery', async () => {
  const checkoutIdentity = {
    checkout: { birthtimeNs: '1', dev: '2', ino: '3' },
    known: true,
  };
  const recipient = {
    checkout: JSON.stringify(checkoutIdentity),
    native_id: 'native-a',
    provider: 'claude-code',
    session_hint: 'session-a',
  };
  let sends = 0;
  const sentKeys = new Set<string>();
  let engineEffects = 0;
  const service = createLinksService({
    client: {
      call: (operation: string, args: { idempotency_key?: string }) => {
        if (operation === 'send') {
          sends += 1;
          const replayed = sentKeys.has(args.idempotency_key as string);
          if (!replayed) {
            sentKeys.add(args.idempotency_key as string);
            engineEffects += 1;
          }
          return Promise.resolve({
            ok: true,
            result: {
              message_id: 'm_1',
              replayed,
              state: 'queued',
            },
          });
        }
        if (operation === 'acknowledge' || operation === 'redeliver') {
          return Promise.resolve({
            ok: true,
            result: { message_id: 'm_1', state: 'queued' },
          });
        }
        return Promise.resolve({
          ok: true,
          result: {
            attempt_id: 'a_1',
            attempts: 1,
            message_id: 'm_1',
            observed_match: true,
            recipient,
            state: 'handoff-unknown',
          },
        });
      },
    },
    resolveTarget: () => ({ checkoutIdentity, name: 'topic', repo: 'repo' }),
    sessions: {
      list: () => ({
        ok: true,
        sessions: [
          {
            checkoutIdentity,
            id: 'session-a',
            name: 'topic',
            nativeConversation: {
              id: 'native-a',
              provider: 'claude-code',
              state: 'bound',
            },
            ownership: 'owned',
            repo: 'repo',
            state: 'running',
            tool: 'claude-code',
          },
        ],
      }),
    },
  });
  expect(
    await service.send({
      ...managedFirst,
      body: 'hello',
      idempotencyKey: 'key-1',
    })
  ).toMatchObject({ code: 'LINKS_INVALID', ok: false });

  const target = linksTarget(managedFirst);
  expect(target).toEqual(first);
  expect(
    await service.send({ ...target, body: 'hello', idempotencyKey: 'key-1' })
  ).toMatchObject({ ok: true, replayed: false });
  expect(
    await service.send({ ...target, body: 'hello', idempotencyKey: 'key-1' })
  ).toMatchObject({ ok: true, replayed: true });
  expect(sends).toBe(2);
  expect(engineEffects).toBe(1);
  expect(await service.ack({ ...target, messageId: 'm_1' })).toMatchObject({
    ok: true,
  });
  const review = await service.redeliver({
    ...target,
    attemptId: 'a_1',
    messageId: 'm_1',
  });
  expect(review).toMatchObject({
    code: 'LINKS_CONFIRMATION_REQUIRED',
    ok: false,
  });
  expect(
    await service.redeliver({
      ...target,
      attemptId: 'a_1',
      confirmation: review.confirmation.token,
      messageId: 'm_1',
    })
  ).toMatchObject({ ok: true });
});

test('a validated sharing review clears on confirmation and closes when its project changes', async () => {
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    if (calls === 1 || calls === 3) {
      return Promise.resolve(
        Response.json({
          code: 'LINKS_CONFIRMATION_REQUIRED',
          confirmation: {
            fields: [
              { field: 'owner', keys: ['owner'], meaning: 'Shown to peers.' },
            ],
            never: ['paths'],
            owner: 'Mukul',
            permissions: {
              attention: false,
              interrupt: false,
              receive: true,
              visibility: true,
            },
            project: 'repo',
            token: 'share-token',
          },
          error: 'Review required',
          ok: false,
        })
      );
    }
    return Promise.resolve(Response.json({ ok: true }));
  }) as typeof fetch;
  const page = renderWithHooks();
  const root = page.render();
  const settings = find(
    root,
    (vnode) =>
      typeof vnode.type === 'function' && vnode.type.name === 'PolicySettings'
  );
  if (!settings) {
    throw new Error('Expected policy settings');
  }
  const policy = renderComponent(settings.type, {
    ...settings.props,
    projects: [
      { label: 'Repo', name: 'repo' },
      { label: 'Other', name: 'other' },
    ],
  });
  let tree = policy.render();
  const project = find(
    tree,
    (vnode) => vnode.type === 'select' && vnode.props.id === 'links-project'
  );
  project?.props.onChange({ currentTarget: { value: 'repo' } });
  await flush();
  tree = policy.render();
  const enable = find(
    tree,
    (vnode) => vnode.props?.children === 'Enable sharing'
  );
  enable?.props.onClick();
  await flush();
  tree = policy.render();
  const confirm = find(
    tree,
    (vnode) => vnode.props?.children === 'Confirm sharing'
  );
  expect(confirm?.props.disabled).toBe(false);
  confirm?.props.onClick();
  await flush();
  tree = policy.render();
  const dialog = find(
    tree,
    (vnode) => typeof vnode.type === 'function' && vnode.type.name === 'Dialog'
  );
  expect(dialog?.props.open).toBe(false);
  expect(calls).toBe(2);
  const secondEnable = find(
    tree,
    (vnode) => vnode.props?.children === 'Enable sharing'
  );
  secondEnable?.props.onClick();
  await flush();
  tree = policy.render();
  const openReview = find(
    tree,
    (vnode) => typeof vnode.type === 'function' && vnode.type.name === 'Dialog'
  );
  expect(openReview?.props.open).toBe(true);
  const changedProject = find(
    tree,
    (vnode) => vnode.type === 'select' && vnode.props.id === 'links-project'
  );
  changedProject?.props.onChange({ currentTarget: { value: 'other' } });
  await flush();
  tree = policy.render();
  const closedReview = find(
    tree,
    (vnode) => typeof vnode.type === 'function' && vnode.type.name === 'Dialog'
  );
  expect(closedReview?.props.open).toBe(false);
  expect(calls).toBe(3);
});
