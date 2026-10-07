import { expect, test } from 'bun:test';
import { createRef, h, options, type VNode } from 'preact';
import { DropdownMenuTrigger } from './portal/ui/dropdown-menu';

// No DOM library is installed, so this checks the ref contract one render
// level deep: the caller's ref must reach Base UI's Menu.Trigger (which puts
// it on the real <button>), not stay on the wrapper's component instance.
test('DropdownMenuTrigger forwards the caller ref to the Base UI trigger', () => {
  const ref = createRef<HTMLButtonElement>();
  const outer = h(DropdownMenuTrigger, { class: 'x', ref }) as VNode<{
    ref?: unknown;
  }>;
  // preact/compat moves a forwarded ref into props in its diff hook
  // (options._diff, mangled to __b); a plain function keeps it on the vnode,
  // where Preact would attach the component instance instead of the button.
  (options as unknown as { __b?: (vnode: VNode) => void }).__b?.(outer);
  expect(outer.ref).toBeFalsy();
  expect(outer.props.ref).toBe(ref);
  const render = DropdownMenuTrigger as unknown as (
    props: object
  ) => VNode<{ className?: string; ref?: unknown }>;
  const inner = render(outer.props);
  expect(inner.ref ?? inner.props.ref).toBe(ref);
  expect(inner.props.className).toBe('x');
});
