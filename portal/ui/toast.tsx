// ToastStack — ported from ui.tsx onto Base UI's real Toast primitive
// (@base-ui/react/toast) instead of the old hand-rolled stack (plain
// array-of-divs + a bare CSS keyframe, no exit animation, no swipe-dismiss,
// no aria-live semantics).
//
// Architecture: app.tsx owns toast state (the `toasts` array + `toast()` /
// `dismissToast()` in App, unchanged — see below) and stays the single
// source of truth. That external array is mirrored into a Base UI
// `createToastManager()` instance, which is what actually drives the real
// DOM: enter/exit transitions, swipe-to-dismiss, and the timing/limit
// semantics Base UI's ToastProvider expects. This is the *sanctioned*
// pattern, not a workaround — the live shadcn base-nova registry source for
// this exact component (ui.shadcn.com/r/styles/base-nova/toast.json) does
// the same thing: a module-level `createToastManager()` passed into
// `Toast.Provider`'s `toastManager` prop, read back with `useToastManager()`.
// That registry file is NOT copied verbatim (it imports `lucide-react` and a
// `@/registry/.../ui/button`, neither of which exist here, and renders the
// full shadcn absolute-position/scale card-stack via `--toast-index` CSS
// vars) — ported by hand onto this repo's own tone-colored-chip visual
// (matches the old ToastStack's look) and a plain flex-col-reverse stack
// instead of the vars-driven 3D stack, since that CSS could not be verified
// visually here (see the spike note below).
//
// PRESERVED CONTRACT: ToastStack's props are unchanged —
// `{ toasts: ToastItem[]; onDismiss: (id: number) => void }` — and
// `ToastItem` is still `{ id: number; msg: string; tone: Tone }`. app.tsx's
// own `toast(msg, tone)` / `dismissToast(id)` functions (which own the
// array + the 5s auto-timeout) do not need to change shape at all; only the
// import path moves from './ui' to './ui/toast'.
//
// VERIFIED, not assumed (read node_modules/@base-ui/react/toast/store.js +
// createToastManager.js directly before writing the sync effect below):
//   - manager.add({ id, ... }) with an id that already has a *non-ending*
//     entry upserts in place (ToastStore.addToast -> updateToastInternal),
//     it does not duplicate.
//   - manager.close(id) is always safe to call, for two distinct reasons
//     depending on the toast's state: if it's already fully removed,
//     ToastStore.closeToast's `if (!toast) return;` no-ops. If it's still
//     present but already mid-exit (the common case here — our own
//     onClick/onClose path closes it first, then this file's sync effect
//     independently notices the same id vanished from `toasts` and calls
//     close() again), closeToast reaches `toastsToClose.forEach(toast => {
//     if (toast.transitionStatus !== 'ending') toast.onClose?.() })` —
//     onClose only fires for toasts NOT already ending, so the second
//     close() call re-marks it 'ending' (harmless) but does not re-invoke
//     onClose. That second guard, not the missing-toast one, is what makes
//     ToastList's click-to-dismiss and this effect's cleanup safe to both
//     target the same id without double-firing onDismiss.
//   - `timeout: 0` genuinely disables the internal auto-dismiss timer
//     (`duration > 0` gates `scheduleTimer`; `0 ?? timeout` short-circuits
//     to 0 via nullish-coalescing, it does not fall through to the
//     provider's default). Passed explicitly on every add() because
//     app.tsx's own setTimeout already owns dismiss timing — Base UI must
//     not run a second, competing timer.
//   - ToastProvider defaults `limit` to 3 and silently marks the rest
//     data-limited. The old ToastStack rendered every toast in the array
//     with no cap. `limit={20}` below removes that mismatch instead of
//     styling data-limited (a flat stack has nowhere to hide a "limited"
//     toast anyway — no peeking stack of cards to tuck it behind).
//   - the manager's reactivity (`useToastManager()` inside ToastList) is
//     the one genuinely new hook surface vs. the Dialog/Menu spike:
//     @base-ui/utils/store's ReactStore binds through
//     use-sync-external-store's shim, which delegates to `React.useSyncExternalStore`
//     when present. `react` resolves to `@preact/compat` under this repo's
//     package.json overrides, and preact/compat/src/hooks.js ships its own
//     useSyncExternalStore — explicitly a port of React's own shim client
//     (see the comment atop that function). Confirmed via a standalone
//     spike (burst-add 4 toasts past the old default limit of 3, click-
//     dismiss one, let the rest auto-expire, add fresh toasts into the
//     then-empty stack) driven with the same method as the Dialog/Menu
//     spike: scratch port (never 2999), `nohup`, exact PID captured and
//     killed, `lsof` confirmed clean, spike files deleted after,
//     `git status --short` byte-identical to the pre-existing dirty
//     baseline afterward. Zero errors/warnings originating from this
//     component at every checkpoint (Bun's own HMR info/reconnect log
//     lines are unrelated noise, not component output); DOM toast count
//     matched the driving array's length at each step, including the 4th
//     (limit={20} confirmed not clamping to the default 3). The spike also
//     caught and fixed a real bug this way: onClick calling `onDismiss`
//     directly, instead of routing through the manager's `close()` like
//     ToastList does now, double-fired onDismiss for a manually-dismissed
//     toast (visible as two `dismiss:N` log lines instead of one) — a
//     mismatch a type-check or a dry read of the source would not have
//     surfaced, only driving the real DOM did.
//
//   - `store.js`'s `closeToast` also calls `handleFocusManagement(toastId)`
//     on every close, which can call `restoreFocusToPrevElement()`. Read
//     before assuming this could steal focus from an unrelated input
//     elsewhere on the page (e.g. a worktree name field) when a background
//     `toast()` call auto-expires: `handleFocusManagement` opens with
//     `if (!contains(state.viewport, activeElement) || !isFocusVisible(...))
//     return;` — it only acts when focus is already inside the toast
//     viewport (e.g. the user tabbed onto a toast) at the moment of close.
//     A toast closing while focus is elsewhere on the page is a no-op here.
import { useEffect, useRef } from 'preact/hooks';
import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import { cn } from './utils';

// Same literal union as badge.tsx's Tone — kept local rather than imported
// so this file stays a standalone unit (every portal/ui/* primitive in this
// migration re-declares it the same way; consumers pick whichever file's
// Tone they already have in scope, they're structurally identical).
export type Tone = 'emerald' | 'amber' | 'red' | 'zinc';

// Unchanged from ui.tsx — this is the exact shape app.tsx's `toasts` state
// and `toast()`/`dismissToast()` already produce and consume.
export type ToastItem = { id: number; msg: string; tone: Tone };

// One manager per mounted ToastStack. App only ever has one ToastStack
// mounted at a time (each page branch renders its own, gated by the
// top-level route switch — never two simultaneously), so a fresh manager
// per mount is correct, not wasteful; `useRef(createToastManager())` would
// re-invoke the factory every render for no reason, so the instance is
// built lazily inside the ref initializer instead.
function useOwnToastManager() {
  const ref = useRef<ReturnType<typeof ToastPrimitive.createToastManager>>();
  if (!ref.current) ref.current = ToastPrimitive.createToastManager();
  return ref.current;
}

// Tone-colored chip background — same values as ui.tsx's TOAST_BG. Solid,
// saturated, backdrop-blurred surfaces on purpose (Setu's vibrant-not-muted
// rule): the chip's own background is what carries the tone, not page
// theme, so unlike most surfaces in this app it does NOT need a dark:
// pair — bg-signal-red/95 reads the same, correctly, in both themes
// (confirmed: this is exactly what the old ToastStack already shipped).
const TOAST_BG: Record<Tone, string> = {
  amber: 'bg-signal-amber/95 border-signal-amber',
  emerald: 'bg-signal-green/95 border-signal-green',
  red: 'bg-signal-red/95 border-signal-red',
  zinc: 'bg-zinc-900/95 border-zinc-800',
};

function ToastList() {
  // `close` here and the sync effect's `manager.close()` in ToastStack are
  // the same manager's method (useToastManager() reads the manager given to
  // Provider) — routing every dismiss path (click here, swipe gesture,
  // programmatic close from the sync effect below) through this one method
  // means `onClose` (registered at add() time) is the single place
  // `onDismiss` ever gets called. Tried calling `onDismiss` directly from
  // this onClick too, verified it double-fires: onClick fires it once, then
  // the sync effect's manager.close() for the now-vanished id fires the
  // toast's own onClose a second time. Harmless today (onDismiss is a pure
  // array filter) but the wrong shape to build on. Real Base UI guard,
  // verified in store.js, is what makes routing through close() safe
  // instead of just moving the double-fire: closeToast() only invokes
  // onClose when `transitionStatus !== 'ending'`, so calling close() again
  // on a toast already closing (from the effect, moments later) is a
  // reliable no-op, not a second dismiss.
  const { toasts, close } = ToastPrimitive.useToastManager();
  return (
    <>
      {toasts.map((t) => {
        return (
          <ToastPrimitive.Root
            key={t.id}
            toast={t}
            // Swipe any direction to dismiss — the old ToastStack had no
            // swipe gesture at all (bare click-anywhere-to-dismiss button);
            // this is a genuine capability upgrade Base UI provides for
            // free, not something hand-rolled here.
            swipeDirection={['down', 'up', 'left', 'right']}
            className={cn(
              'pointer-events-auto w-full max-w-md text-left text-xs text-white px-4 py-2.5',
              'rounded-none border shadow-lg backdrop-blur-md cursor-pointer select-none',
              'transition-all duration-200 ease-out',
              // Base UI's boolean-presence attrs (data-starting-style /
              // data-ending-style / data-swipe-direction), not
              // data-[state=value] — see the migration's Dialog/Menu
              // gotcha notes on this exact rewrite. `data-[x]:` (no `=`)
              // is Tailwind's arbitrary-variant form for a bare attribute
              // presence check, needs no @custom-variant config.
              'data-[starting-style]:opacity-0 data-[starting-style]:translate-y-2',
              'data-[ending-style]:opacity-0 data-[ending-style]:scale-95',
              TOAST_BG[t.type as Tone] ?? TOAST_BG.zinc,
            )}
            // The old UX: the entire toast is the dismiss control (no
            // separate close button). Preserved via onClick/onKeyDown only
            // — NOT role/tabIndex overrides. Read ToastRoot.js: it already
            // sets role="dialog" (or "alertdialog" when toast.priority is
            // 'high'), tabIndex={0}, aria-modal, aria-labelledby/
            // aria-describedby (wired to Title/Description's real ids), and
            // its own onKeyDown — passed as `props: [defaultProps,
            // elementProps]` into useRenderElement, i.e. LOWER priority
            // than whatever this element passes. mergeProps composes same-
            // named onXxx handlers (both fire; confirmed in merge-props.js's
            // handler-shaped-key detection) but plain attributes are a flat
            // override with the later entry winning — an explicit
            // role="button" here previously clobbered Base UI's own
            // role="dialog"/"alertdialog", replacing a real live-region
            // announcement role with a generic button and losing the
            // aria-labelledby/describedby wiring. Dropped that override
            // (and the redundant tabIndex, already 0 from defaultProps);
            // kept aria-label as a fallback accessible name since this
            // component renders Description only, no Title (so
            // aria-labelledby stays unset and doesn't out-rank aria-label
            // per ARIA precedence).
            aria-label="Dismiss notification"
            onClick={() => close(t.id)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close(t.id); }
            }}
          >
            <ToastPrimitive.Content className="flex items-center">
              {/* Bare — Description defaults its children to the toast's
                  own `description` field (set at add() time below) via
                  Base UI's internal useToastLabelPart, same as the
                  registry's own bare `<ToastDescription />` usage. */}
              <ToastPrimitive.Description className="text-xs text-white" />
            </ToastPrimitive.Content>
          </ToastPrimitive.Root>
        );
      })}
    </>
  );
}

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  const manager = useOwnToastManager();
  // Which of our numeric ids are currently mirrored into the Base UI
  // manager, so re-adds are skipped and removals are detected by absence.
  const mirroredIds = useRef<Set<number>>(new Set());

  // `onDismiss` is intentionally NOT a dependency here — app.tsx defines it
  // as a plain (non-useCallback) function whose identity changes every
  // render, but its only closure-over is a stable setState setter, so
  // whichever render's copy fires behaves identically. Re-running this
  // effect on every `onDismiss` identity change would re-diff for no
  // reason; it only needs to run when the actual toast list changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const currentIds = new Set(toasts.map((t) => t.id));

    for (const t of toasts) {
      if (mirroredIds.current.has(t.id)) continue;
      mirroredIds.current.add(t.id);
      manager.add({
        description: t.msg,
        id: String(t.id),
        // The single place `onDismiss` ever gets called (see ToastList's
        // onClick comment above) — fires on swipe-dismiss, on manager.close()
        // from the remove-loop below, and on ToastList's click-to-dismiss,
        // exactly once per toast regardless of which path triggered it.
        onClose: () => onDismiss(t.id),
        // app.tsx's own setTimeout(..., 5000) already owns dismiss timing;
        // a second competing timer here would race it.
        timeout: 0,
        type: t.tone,
      });
    }

    for (const id of mirroredIds.current) {
      if (currentIds.has(id)) continue;
      mirroredIds.current.delete(id);
      // Always safe, whichever way this id already left `toasts` (see the
      // two-guard breakdown in the file header): fully-removed hits
      // closeToast's `if (!toast) return`, still-present-but-ending hits
      // its `transitionStatus !== 'ending'` guard around onClose — neither
      // path re-fires onDismiss.
      manager.close(String(id));
    }
  }, [toasts]);

  return (
    <ToastPrimitive.Provider toastManager={manager} limit={20}>
      <ToastPrimitive.Portal>
        {/* Bottom-center, matching the old ToastStack exactly (z-[60], not
            shadcn's registry z-50 — Modal in ui.tsx is z-50, toasts must
            stay above an open modal's backdrop). Centering translate lives
            on the Viewport, not per-toast Root, so it doesn't collide with
            each Root's own transform (swipe offset, enter/exit transform)
            the way baking it into a shared keyframe would.
            pointer-events-none here + pointer-events-auto on each Root
            (above) matters for real: this stays mounted even with zero
            toasts (unmounting on empty would kill the last toast's own
            exit transition, the entire point of moving off the old
            instant-vanish stack) so an empty full-width strip must not
            eat clicks on whatever's underneath it on every page. */}
        <ToastPrimitive.Viewport className="pointer-events-none fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] flex flex-col-reverse gap-2 items-center w-auto">
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}
