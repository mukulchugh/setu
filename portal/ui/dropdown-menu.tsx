// DropdownMenu / DropdownMenuItem — replaces ui.tsx's Menu/MenuItem, ported
// from the real shadcn base-nova registry (fetched live from
// ui.shadcn.com/r/styles/base-nova/dropdown-menu.json — the base-nova style
// is the one that actually resolves to @base-ui/react source; the legacy
// new-york/new-york-v4/default style slugs all still serve Radix) onto this
// repo's Base UI + Preact stack, with the registry's shadcn-theme classes
// (bg-popover, bg-accent/text-accent-foreground, ring-foreground/10,
// rounded-lg, tw-animate-css's animate-in/fade-in-0/zoom-in-95, IconPlaceholder)
// swapped for this app's real tokens — those theme classes don't exist in
// portal/styles.css and compile to nothing, which neither tsc nor `bun build`
// catches, so don't reintroduce them here.
//
// Root>Trigger, Portal>Positioner>Popup>Item is the exact part composition
// the spike (portal/spike-test.tsx, now deleted per the spike's own cleanup)
// drove interactively under this repo's real Preact/Bun pipeline: roving
// focus via data-highlighted, real document.activeElement movement on
// ArrowUp/ArrowDown, the correct per-item onClick firing after keyboard nav,
// and auto-close on item activation — all verified with zero console errors
// at every checkpoint. Escape-to-close and outside-click-to-close are real
// Base UI-owned capabilities (documented, not hand-rolled — the old Menu's
// `document.addEventListener('click', close)` effect and click-outside div
// are gone, not ported) but were NOT among the spike's driven checkpoints;
// this file's own verification was tsc + `bun build` only (see the report
// this file shipped with), neither of which exercises real interaction —
// treat Escape/outside-press on this specific component as needing a live
// smoke test, not as spike-confirmed.
//
// Only Root/Trigger/Content/Item/Separator are ported. This repo's real Menu
// call sites (portal/app.tsx — worktree "more" menus, start-mode pickers,
// deploy pickers, the tool-open menu) never use checkboxes, radios,
// submenus, grouped labels, or shortcut hints, so the registry's
// DropdownMenuCheckboxItem/RadioItem/RadioGroup/Sub/SubTrigger/SubContent/
// Group/Label/Shortcut are deliberately NOT ported (YAGNI) — pull them from
// the same registry JSON if a real consumer ever needs them.
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import type { ComponentChildren } from 'preact';
import { cva } from 'class-variance-authority';
import { cn } from './utils';

// Renders no DOM element of its own (Base UI's own doc: "Doesn't render its
// own HTML element") — just groups Trigger/Content and owns open state,
// focus trap, and outside-press/Escape dismissal.
//
// modal defaults to false here, overriding Base UI's own `modal: true`
// default. Modal Base UI menus lock body scroll AND add scrollbar-
// compensation padding to <body> while open — a dialog affordance, and
// none of this repo's real call sites (worktree "more" menus, start-mode
// pickers, deploy pickers) are dialogs; on a scrolling worktree list every
// dropdown open would otherwise produce a visible horizontal layout shift
// of the whole page. Outside-press and Escape dismissal both still work
// non-modal — only scroll-lock/pointer-blocking (never present in the old
// Menu either) is what a non-default `modal` here gives up. Callers that
// genuinely want modal behavior can still pass `modal` to override.
export function DropdownMenu({ modal = false, ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root modal={modal} {...props} />;
}

// Renders a real <button> by default (Base UI's own behavior when `render`
// is omitted) with zero baked-in styling. This repo's triggers are
// IconButton, PrimaryButton, or a bare icon span depending on call site —
// baking one look in here would fight all of them. Reproduce the look you
// need with `class`/`data-tip` passed straight through (e.g.
// `class="tip icon-btn text-zinc-400 hover:bg-current/10 ..."` for the old
// IconButton chrome) rather than `render={<IconButton/>}`: IconButton is a
// plain Preact function component that doesn't forward a ref or spread
// unknown props, and Base UI's `render` composition needs both to attach its
// anchor ref and wire pointer/keyboard handlers onto the real element. The
// spike never exercised the `render` prop at all (against any element, DOM
// or component) — so treat `render={<IconButton/>}` as wholly unverified
// until it's checked live, not as a drop-in replacement for the old
// `trigger={toggle => <IconButton onClick={toggle}>...}` render-prop.
export function DropdownMenuTrigger({ class: cls, ...props }: MenuPrimitive.Trigger.Props & { class?: string }) {
  return <MenuPrimitive.Trigger className={cls} {...props} />;
}

// align defaults to 'end' (right edges flush), NOT the registry's 'start' —
// the old Menu defaulted `align='right'`, and 6 of this repo's 9 real call
// sites omit `align` entirely and rely on that right-flush placement (icon
// buttons sitting at a card's right edge, panel hanging left off them).
// Taking the registry's 'start' default here would silently mirror every
// one of those menus with nothing in tsc or `bun build` to catch it.
// side defaults to 'bottom', Base UI's own raw default and a match for the
// old panel's `top-8` (always-below-trigger) positioning.
const dropdownMenuContentVariants = cva(
  // Glass + tactile chrome matching (and slightly exceeding) the old Menu
  // panel — bg-white/95 + backdrop-blur-md + border + shadow-lg — with a
  // brand-tinted shadow instead of a flat gray one for a touch more
  // presence, per this app's vibrant-not-muted rule. rounded-none always
  // (no border radius anywhere in this app). min-w-[170px] matches the old
  // panel's fixed minimum width exactly; NOT the registry's
  // `w-(--anchor-width)`, which would size the panel to the trigger's own
  // width — right for a full-width <select>-style dropdown, wrong for the
  // ~28px icon-button triggers every real call site here uses.
  // max-h-(--available-height) is Base UI's own collision-avoidance CSS var
  // (set by its positioning JS, not a missing design token) — kept so a
  // menu opened near the viewport edge scrolls instead of overflowing.
  //
  // z-40, not the old panel's z-30: the old Menu rendered *inside the
  // card*, and styles.css's `.wt-card:has(.menu-panel-open) { z-index: 30 }`
  // gave it a local stacking context — harmless next to PageHeader's own
  // unrelated `z-30` (portal/ui.tsx:206) in a different stacking context.
  // This Popup instead portals straight to <body> (MenuPrimitive.Portal
  // below), so it now competes with PageHeader's z-30 directly in the same
  // global stacking context. z-40 clears PageHeader unambiguously while
  // staying under Modal's z-50 and ToastStack's z-[60].
  //
  // Animation triggers off data-starting-style/data-ending-style, NOT
  // data-open/data-closed: data-open is already present on the very first
  // mounted frame, so styling the "arrived" state off it is a no-op (no
  // delta for the transition to animate across). data-starting-style is
  // the one-frame "from" state Base UI emits specifically so a plain CSS
  // transition has something to animate from; data-ending-style is its
  // exit-side match, held on the mounted element for the transition's
  // duration before Base UI unmounts it.
  'z-40 min-w-[170px] max-h-(--available-height) overflow-y-auto overflow-x-hidden origin-(--transform-origin) rounded-none border border-zinc-200 dark:border-zinc-700 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md py-1 shadow-[0_8px_24px_-4px_rgba(8,80,65,0.25)] dark:shadow-[0_8px_24px_-4px_rgba(0,0,0,0.55)] outline-none opacity-100 scale-100 transition-[opacity,transform] duration-150 ease-out data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95',
);

export function DropdownMenuContent({
  class: cls,
  align = 'end',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 6,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'> & { class?: string }) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner className="z-40 outline-none" align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset}>
        <MenuPrimitive.Popup className={cn(dropdownMenuContentVariants(), cls)} {...props} />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

// Kept as `tone: 'zinc' | 'red'` — the old MenuItem's exact prop name and
// values — rather than the registry's `variant: 'default' | 'destructive'`.
// Consistency with the sibling portal/ui/badge.tsx (which made the same
// call to keep `tone` over the registry's own naming) matters more here than
// matching the registry verbatim, and it keeps the sweep-phase diff smaller
// (every one of this repo's `tone="red"` call sites needs zero renaming).
export type DropdownMenuItemTone = 'zinc' | 'red';

const dropdownMenuItemVariants = cva(
  // cursor-default (not cursor-pointer) matches the registry's own choice
  // and real desktop menu conventions — Base UI's Item renders a <div> with
  // role="menuitem" + roving tabindex, not a native <button>, so nothing
  // here can rely on UA button cursor/focus-ring defaults.
  'flex w-full cursor-default select-none items-center gap-2 whitespace-nowrap rounded-none px-3 py-1.5 text-xs outline-none transition-colors duration-150 data-disabled:pointer-events-none data-disabled:opacity-50',
  {
    defaultVariants: { tone: 'zinc' },
    variants: {
      // data-highlighted (not hover:/focus:) is the one selector that covers
      // both pointer and keyboard highlighting in a single rule — Menu.Root's
      // `highlightItemOnHover` defaults true, and this is the exact attribute
      // the spike watched move across items on ArrowUp/ArrowDown.
      // Neutral zinc wash for the default tone, not the brand accent green —
      // ui.tsx's own PrimaryButton comment reserves the accent color for
      // primary actions only; every menu item glowing green would break that
      // reservation, not honor the "vibrant" rule.
      tone: {
        red: 'text-signal-red data-highlighted:bg-signal-red/10 dark:data-highlighted:bg-signal-red/15',
        zinc: 'text-zinc-700 dark:text-zinc-300 data-highlighted:bg-zinc-50 dark:data-highlighted:bg-white/10',
      },
    },
  },
);

export function DropdownMenuItem({
  class: cls,
  tone = 'zinc',
  icon,
  children,
  ...props
}: MenuPrimitive.Item.Props & { class?: string; tone?: DropdownMenuItemTone; icon?: ComponentChildren }) {
  return (
    <MenuPrimitive.Item className={cn(dropdownMenuItemVariants({ tone }), cls)} {...props}>
      {icon}
      {children}
    </MenuPrimitive.Item>
  );
}

// Not in the old ui.tsx Menu/MenuItem system at all (it had no separator
// concept) — added because it's a near-zero-cost wrap of Base UI's own
// Separator primitive and several real call sites (the worktree tool-open
// menu's sidecar/logs/danger groupings) read as natural candidates for one,
// even though nothing requires it today.
export function DropdownMenuSeparator({ class: cls, ...props }: MenuPrimitive.Separator.Props & { class?: string }) {
  return <MenuPrimitive.Separator className={cn('my-1 h-px w-full bg-zinc-200 dark:bg-zinc-700', cls)} {...props} />;
}
