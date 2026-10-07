import { expect, test } from 'bun:test';
import { dialogReturnTarget } from './portal/ui/dialog';

const element = (isConnected: boolean) =>
  ({ focus: () => undefined, isConnected }) as unknown as HTMLElement;

test('a dialog returns focus to the opener captured before it opened', () => {
  const opener = element(true);
  expect(dialogReturnTarget(opener, element(true))).toBe(opener);
});

test('a detached, missing or body opener falls back to Base UI instead of focusing nothing', () => {
  const body = element(true);
  expect(dialogReturnTarget(element(false), body)).toBe(true);
  expect(dialogReturnTarget(null, body)).toBe(true);
  expect(dialogReturnTarget(body, body)).toBe(true);
});

// Exercise the actual LogModal -> DialogContent -> Base UI Popup prop path.
// The browser trace establishes the DOM ordering: the menu reclaims focus
// before LogModal renders. These checks replay that ordering without running
// effects (which would start log subscriptions); root owns the browser check.
import { Component, h, options, type VNode } from 'preact';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { LogModal } from './portal/components/logs';
import { DialogContent } from './portal/ui/dialog';

function renderWithHooks(component: (props: any) => any, props: object) {
  const vnode = h(component, props);
  (vnode as any).__c = new Component(props);
  (options as any).__r(vnode);
  return component(props);
}

function logPopup(opener: HTMLElement) {
  const dialog = renderWithHooks(LogModal, {
    repo: 'quivly-app', name: 'feat/projects-automation',
    onClose: () => {}, returnFocus: opener,
  });
  const content = dialog.props.children;
  expect(content.type).toBe(DialogContent);
  const portal = renderWithHooks(content.type, content.props);
  return (portal.props.children as VNode[]).find(
    (child) => child.type === DialogPrimitive.Popup
  )!;
}

test('menu-to-logs keeps the explicit More opener after the menu retakes focus', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const more = element(true);
  const menuItem = element(true);
  const body = element(true);
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { activeElement: menuItem, body },
  });
  try {
    const popup = logPopup(more);
    const finalFocus = (popup.props as any).finalFocus;
    expect(finalFocus('keyboard')).toBe(more);
    // A still-connected exit-animation menu item must never win, and its
    // later removal must not change the stable return target either.
    Object.defineProperty(menuItem, 'isConnected', { value: false });
    expect(finalFocus('keyboard')).toBe(more);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('DialogContent preserves explicit finalFocus policies unchanged', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { activeElement: element(true), body: element(true) },
  });
  try {
    const callback = () => false;
    const ref = { current: element(true) };
    for (const finalFocus of [false, true, callback, ref]) {
      const portal = renderWithHooks(DialogContent, { finalFocus });
      const popup = (portal.props.children as VNode[]).find(
        (child) => child.type === DialogPrimitive.Popup
      )!;
      expect((popup.props as any).finalFocus).toBe(finalFocus);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
