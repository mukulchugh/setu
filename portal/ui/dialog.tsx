// Dialog — ported from the shadcn registry's current default style
// (ui.shadcn.com/r/styles/base-nova/dialog.json — confirmed live to hand back real
// @base-ui/react/dialog source, unlike the new-york/new-york-v4/default style slugs, which are
// legacy Radix aliases kept for back-compat) onto this repo's Preact + Base UI setup.
//
// Part tree follows Base UI's actual composition (verified against
// node_modules/@base-ui/react/dialog's own .d.ts files, and exercised end-to-end by the spike's
// decisive focus-trap/outside-press test): Root > Trigger > Portal > Backdrop, Popup. No
// Positioner — that's a Menu-only requirement (Menu needs one to place a floating panel next to a
// trigger; Dialog centers/anchors itself with plain fixed positioning instead).
//
// Replaces ui.tsx's hand-rolled Modal. Base UI's Root now owns open state, Escape-to-close,
// outside-press dismissal, and focus trap internally, so Modal's manual
// `onClick={(e) => e.target === e.currentTarget && onClose()}` backdrop check isn't reproduced
// here — it would just be redundant/conflicting scaffolding on top of what Root already does.
//
// Follows the sibling portal/ui/badge.tsx precedent: every component here takes `class` (this
// repo's convention, matching every existing call site) and converts to `className` only at the
// point it touches a raw Base UI primitive — never spreads a bare `class` onto one.
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { cn } from './utils';

// Imperatively opened dialogs have no Base UI Trigger to identify their opener.
// Capture is only a default for direct openers. A menu can reclaim focus
// before a dialog mounts, so menu callers must pass their stable trigger via
// finalFocus. `true` keeps Base UI's fallback for unavailable targets.
export function dialogReturnTarget(
  opener: Element | null,
  body: Element | null
): HTMLElement | true {
  const element = opener as HTMLElement | null;
  return element?.isConnected &&
    element !== body &&
    typeof element.focus === 'function'
    ? element
    : true;
}

// The registry's own defaults don't exist in this repo and silently produce no CSS if copied
// verbatim: `bg-popover`/`text-popover-foreground`/`bg-muted/50`/`ring-foreground/10`/
// `cn-font-heading` are shadcn theme tokens (styles.css's @theme only defines
// --color-board(-dark)/-ink(-dark)/-signal-*/-rail/-accent); `animate-in`/`fade-in-0`/
// `zoom-in-95`/`animate-out`/`fade-out-0`/`zoom-out-95` come from the tailwindcss-animate plugin,
// which isn't in package.json. Every class below is either a stock Tailwind v4 utility or one of
// this repo's real tokens/CSS classes (--color-accent, --color-ink(-dark), .icon-btn — all
// grepped out of styles.css first). Open/close motion is a plain CSS transition driven by Base
// UI's data-open/data-closed presence attributes via Tailwind's bare boolean-variant shorthand
// (data-open:/data-closed:) — `bun build`'s bundle graph never reaches an unimported file like
// this one, so that command can't validate generated CSS; this was instead verified against a
// real compile by standing up an isolated throwaway Bun.serve() (bunfig's actual
// `[serve.static].plugins = ["bun-plugin-tailwind"]` path, the same one the live portal uses to
// serve its own CSS) on a scratch port, never :2999, killed immediately after. All three
// candidate forms — bare `data-closed:`, bracketed `data-[closed]:`, and the fully-arbitrary
// `[&[data-closed]]:` — compiled to byte-identical output (`&[data-closed]{...}`); the bare form
// below is what's used since it needs no config and reads cleanest.
const overlayCls =
  'fixed inset-0 z-50 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ease-out data-closed:opacity-0';

const panelBase =
  'bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl shadow-2xl rounded-none z-50 transition-[opacity,transform] duration-150 ease-out';
const panelPosition: Record<'center' | 'bottom', string> = {
  // Bottom sheets (LogModal etc.) own their own internal padding/height/flex layout per call
  // site — same as the old Modal, which never imposed padding on a position="bottom" child
  // either. Slide-from-below on close instead of the center variant's scale, matching a sheet
  // being dismissed downward rather than a dialog shrinking away. border-t only (not the center
  // variant's all-round border) — put directly on this variant rather than layered as an
  // "undo" on top of panelBase's border, since tailwind-merge doesn't treat a later `border-b-0`
  // as canceling an earlier bare `border` (same footgun ui.tsx's own `compact` variant documents).
  bottom:
    'border-t border-zinc-200 dark:border-zinc-800 fixed inset-x-0 bottom-0 w-full data-closed:opacity-0 data-closed:translate-y-4',
  // No mx-4 gutter here: unlike the old Modal (a flex child, where a margin was a real gutter),
  // this box is `fixed` + transform-centered, and a margin shifts the transform-origin math off
  // true center (left:50% + margin-left:1rem, then -translate-x-1/2 only pulls back half the
  // *border-box* width, landing 1rem right of center) and can overflow below ~26rem viewports.
  // max-w-[calc(100%-2rem)] gives the same "never touches the edge" behavior with none of that —
  // same fix the registry source already uses for this exact box.
  center:
    'border border-zinc-200 dark:border-zinc-800 fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-sm p-5 sm:p-6 data-closed:opacity-0 data-closed:scale-95',
};

// Same X-mark path as ui.tsx's CloseIcon (a plain two-stroke glyph, not a sourced brand mark —
// no reason to import it from the file this migration is replacing, so it's inlined here too).
function XIcon() {
  return (
    <svg
      aria-hidden="true"
      class="h-4 w-4"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
    >
      <path d="M18 6l-12 12" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

export function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root {...props} />;
}

// Every wrapper below destructures BOTH `class` (this repo's convention) and `className` (part of
// DialogPrimitive.*.Props, since these components spread the rest of props onto the raw Base UI
// primitive) out of the incoming props before spreading `...props` — otherwise a call site that
// happens to pass `className` would land in the rest spread *after* the computed `className={cn(...)}`
// prop above it and silently wipe every class this file computes. `cn(..., className as string, cls)`
// merges both in case a future call site uses either spelling.
export function DialogTrigger({
  class: cls,
  className,
  ...props
}: DialogPrimitive.Trigger.Props & { class?: string }) {
  return (
    <DialogPrimitive.Trigger
      className={cn(className as string, cls)}
      {...props}
    />
  );
}

export function DialogClose({
  class: cls,
  className,
  ...props
}: DialogPrimitive.Close.Props & { class?: string }) {
  return (
    <DialogPrimitive.Close
      className={cn(className as string, cls)}
      {...props}
    />
  );
}

// Exported in case a future dialog needs to portal into a specific node or keep content mounted
// while closed (`keepMounted`) — DialogContent below already composes Portal + Backdrop + Popup
// for the common case, so most call sites won't reach for this directly.
export function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal {...props} />;
}

export function DialogBackdrop({
  class: cls,
  className,
  ...props
}: DialogPrimitive.Backdrop.Props & { class?: string }) {
  return (
    <DialogPrimitive.Backdrop
      className={cn(overlayCls, className as string, cls)}
      {...props}
    />
  );
}

// The main entry point — composes Portal + Backdrop + Popup and carries the visual panel skin
// (glass background, border, shadow) that every old Modal call site used to restate by hand in
// its own wrapper div. `position` is the one piece of Modal's contract with no Base UI
// equivalent, so it's grafted on here rather than left for every call site to reinvent.
//
// showCloseButton defaults to false: all three existing Modal call sites (CreateModal,
// AddProjectModal, LogModal) already render their own header-row close affordance, and turning
// this on unconditionally would double up on an X. New dialogs that don't want to hand-roll a
// header should pass showCloseButton.
export function DialogContent({
  class: cls,
  className,
  position = 'center',
  showCloseButton = false,
  finalFocus,
  children,
  ...props
}: DialogPrimitive.Popup.Props & {
  class?: string;
  position?: 'center' | 'bottom';
  showCloseButton?: boolean;
}) {
  const opener = useRef(document.activeElement);
  return (
    <DialogPortal>
      <DialogBackdrop />
      <DialogPrimitive.Popup
        className={cn(
          panelBase,
          panelPosition[position],
          className as string,
          cls
        )}
        finalFocus={
          finalFocus ??
          (() => dialogReturnTarget(opener.current, document.body))
        }
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close className="icon-btn absolute top-3 right-3 text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100">
            <XIcon />
            <span class="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

export function DialogHeader({
  class: cls,
  children,
}: {
  class?: string;
  children?: ComponentChildren;
}) {
  return <div class={cn('mb-5 flex flex-col gap-1', cls)}>{children}</div>;
}

export function DialogFooter({
  class: cls,
  children,
}: {
  class?: string;
  children?: ComponentChildren;
}) {
  return (
    <div class={cn('flex flex-col-reverse gap-3 pt-1 sm:flex-row', cls)}>
      {children}
    </div>
  );
}

export function DialogTitle({
  class: cls,
  className,
  ...props
}: DialogPrimitive.Title.Props & { class?: string }) {
  return (
    <DialogPrimitive.Title
      className={cn(
        'font-semibold text-base text-ink leading-none dark:text-ink-dark',
        className as string,
        cls
      )}
      {...props}
    />
  );
}

export function DialogDescription({
  class: cls,
  className,
  ...props
}: DialogPrimitive.Description.Props & { class?: string }) {
  return (
    <DialogPrimitive.Description
      className={cn(
        'mt-1 text-xs text-zinc-500 dark:text-zinc-400',
        className as string,
        cls
      )}
      {...props}
    />
  );
}
