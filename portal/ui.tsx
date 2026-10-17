// Small reusable UI kit for the portal — extracted so app.tsx doesn't repeat
// the same badge/button/status-dot styling inline at every call site. Kept
// as plain functions, not a component library package: this is a ~500-line
// single-page tool, not a design system with multiple consumers.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

// Signal colors, not generic Tailwind brights — railway/aviation "clear /
// caution / stop" (see --color-signal-* in styles.css), matching the
// dispatch-board metaphor the whole design is built around. Tone's own key
// names stay the stock Tailwind words (emerald/amber/red) so every call site
// that already reads `tone="emerald"` for "running/positive" doesn't need to
// change — only what color that maps to changed, not the semantic vocabulary.
export type Tone = 'emerald' | 'amber' | 'red' | 'zinc';

const TONE_TEXT: Record<Tone, string> = {
  amber: 'text-signal-amber',
  emerald: 'text-signal-green',
  red: 'text-signal-red',
  zinc: 'text-zinc-400',
};
const TONE_DOT: Record<Tone, string> = {
  amber: 'bg-signal-amber',
  emerald: 'bg-signal-green',
  red: 'bg-signal-red',
  zinc: 'bg-zinc-300',
};
const TONE_SOFT: Record<Tone, string> = {
  amber: 'bg-signal-amber/10 text-signal-amber',
  emerald: 'bg-signal-green/10 text-signal-green',
  red: 'bg-signal-red/10 text-signal-red',
  zinc: 'bg-zinc-100 text-zinc-500',
};

export function StatusDot({
  tone,
  pulse = false,
}: {
  tone: Tone;
  pulse?: boolean;
}) {
  return (
    <span
      class={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300 ${TONE_DOT[tone]} ${pulse ? 'animate-pulse' : ''}`}
    />
  );
}

// The signature moment: a genuine split-flap flip, but ONLY on an actual
// state transition (running -> stopped, etc.), never ambient or looping —
// spend the one bold motion moment where the metaphor earns it, not
// scattered across the page. Compares against the previous render's value;
// a re-render with the same text is a no-op, not a re-trigger.
export function StatusFlap({ text, tone }: { text: string; tone: Tone }) {
  const prev = useRef(text);
  const [flapping, setFlapping] = useState(false);
  useEffect(() => {
    if (prev.current !== text) {
      setFlapping(true);
      prev.current = text;
    }
  }, [text]);
  return (
    <span
      class={`board-mono font-bold text-[11px] ${TONE_TEXT[tone]} shrink-0 ${flapping ? 'flap-change' : ''}`}
      onAnimationEnd={() => setFlapping(false)}
    >
      {text}
    </span>
  );
}

// Board-style label plaque — status labels, mode hints, resource badges.
// Uppercase, tracked, bold: signage, not a soft SaaS pill. `tip` renders the
// existing hover-tooltip CSS (styles.css's .tip::after) rather than a new mechanism.
export function Badge({
  tone,
  tip,
  children,
}: {
  tone: Tone;
  tip?: string;
  children: ComponentChildren;
}) {
  return (
    <span
      {...(tip ? { 'data-tip': tip } : {})}
      class={`tip board-mono shrink-0 rounded-none px-1.5 py-0.5 font-bold text-[9px] transition-colors duration-200 ${TONE_SOFT[tone]}`}
    >
      {children}
    </span>
  );
}

// Wraps the .icon-btn/.tip CSS pattern (styles.css) so every icon action
// shares one hover/disabled/transition definition instead of restating
// `tip icon-btn text-X hover:bg-Y transition-colors` at 15+ call sites.
export function IconButton({
  tone = 'zinc',
  tip,
  onClick,
  disabled,
  href,
  target,
  children,
}: {
  tone?: Tone;
  tip: string;
  onClick?: () => void;
  disabled?: boolean;
  href?: string;
  target?: string;
  children: ComponentChildren;
}) {
  const cls = `tip icon-btn transition-all duration-200 ease-out ${
    disabled
      ? 'text-zinc-300 pointer-events-none'
      : `${TONE_TEXT[tone]} hover:bg-current/10`
  }`;
  if (href) {
    return (
      <a
        aria-label={tip}
        class={cls}
        data-tip={tip}
        href={href}
        target={target}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      aria-label={tip}
      class={cls}
      data-tip={tip}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

// Glass + tactile: frosted translucency (modern/SaaS) with a hard offset
// shadow that collapses on press (a real button being pushed), not a soft
// glow. The accent color is reserved for these primary actions only — see
// --color-accent (forest green).
// No flex-1 here — it only worked at the original modal-footer call sites by
// coincidence (a shrink-to-fit wrapper absorbed the grow), and stretched to
// fill the row anywhere it was reused unwrapped (e.g. a Section's actions
// slot). Call sites that actually want two buttons to split width evenly
// (Cancel/Create, Cancel/Add) add flex-1 explicitly themselves.
// Padding is a variant, not part of the shared base — a later class in the
// string isn't guaranteed to beat an earlier one in Tailwind's generated
// stylesheet order, so "compact" swaps px-3/py-1.5 in outright instead of
// trying to override px-4/py-2.5 via an appended class (the same footgun
// documented on flex-1 above).
const buttonBase =
  'whitespace-nowrap board-mono text-[11px] font-bold rounded-none backdrop-blur-md transition-all duration-150 ease-out disabled:opacity-50 disabled:pointer-events-none active:translate-y-px';
export function PrimaryButton({
  onClick,
  disabled,
  children,
  class: cls = '',
  compact = false,
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ComponentChildren;
  class?: string;
  compact?: boolean;
}) {
  return (
    <button
      class={`${buttonBase} ${compact ? 'px-3 py-1.5' : 'px-4 py-2.5'} ${cls} border border-accent bg-accent text-white shadow-[0_2px_0_0_rgba(0,0,0,0.25)] hover:shadow-[0_2px_12px_0_rgba(8,80,65,0.45)] hover:brightness-125 active:shadow-none`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
export function SecondaryButton({
  onClick,
  disabled,
  children,
  class: cls = '',
  compact = false,
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ComponentChildren;
  class?: string;
  compact?: boolean;
}) {
  return (
    <button
      class={`${buttonBase} ${compact ? 'px-3 py-1.5' : 'px-4 py-2.5'} ${cls} border border-white/75 bg-white/55 text-ink shadow-sm hover:bg-white/85 dark:border-white/10 dark:bg-white/5 dark:text-ink-dark dark:hover:bg-white/10`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

// Toast state (id/tone/timeout) lives in App — the one place that already
// threads a `toast` prop through every route (WorktreePage, SettingsPage).
// This just renders the stack; App decides what and when.
export interface ToastItem {
  id: number;
  msg: string;
  tone: Tone;
}

const TOAST_BG: Record<Tone, string> = {
  amber: 'bg-signal-amber/95 border-signal-amber',
  emerald: 'bg-signal-green/95 border-signal-green',
  red: 'bg-signal-red/95 border-signal-red',
  zinc: 'bg-zinc-900/95 border-zinc-800',
};

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (!toasts.length) {
    return null;
  }
  return (
    <div class="fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col-reverse items-center gap-2">
      {toasts.map((t) => (
        <button
          class={`max-w-md animate-[fadeUp_0.2s_ease-out] rounded-none border px-4 py-2.5 text-left text-white text-xs shadow-lg backdrop-blur-md transition-all duration-200 ease-out ${TOAST_BG[t.tone]}`}
          key={t.id}
          onClick={() => onDismiss(t.id)}
          type="button"
        >
          {t.msg}
        </button>
      ))}
    </div>
  );
}

// Shared X-mark path — CloseBtn below and app.tsx's SidecarRow/CustomAgentRow
// remove buttons all draw the same icon at different sizes.
export function CloseIcon({ class: cls = 'w-4 h-4' }: { class?: string }) {
  return (
    <svg
      aria-hidden="true"
      class={cls}
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

export const inputCls =
  'portal-input bg-white/85 border border-emerald-900/20 text-zinc-800 text-sm rounded-none px-3 py-2 focus:outline-none focus:border-accent placeholder-zinc-500 transition-colors duration-150 dark:bg-zinc-900/80 dark:border-white/20 dark:text-zinc-100 dark:placeholder-zinc-400';

// Semantic <kbd> for shortcut badges (⌘K etc.) instead of a plain styled span.
export function Kbd({ children }: { children: ComponentChildren }) {
  return (
    <kbd class="board-mono rounded-none border border-zinc-300 px-1.5 py-0.5 font-bold text-[9px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
      {children}
    </kbd>
  );
}

// Two real call sites (the list view's header, the worktree detail page) is
// enough to know the right shape — not built ahead of a second consumer.
export function PageHeader({
  back,
  title,
  subtitle,
  actions,
}: {
  back?: { label: string; onClick: () => void };
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  actions?: ComponentChildren;
}) {
  // Scrolls with the page. The global header is the only sticky glass band;
  // a second sticky band here doubled the chrome over every list.
  return (
    <div class="portal-page-header mb-6">
      {back && (
        <button
          class="mb-2 flex items-center gap-1 text-xs text-zinc-400 transition-colors duration-150 hover:text-zinc-600"
          onClick={back.onClick}
          type="button"
        >
          <svg
            aria-hidden="true"
            class="h-3 w-3"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2.5"
            viewBox="0 0 24 24"
          >
            <path d="M15 6l-6 6l6 6" />
          </svg>
          {back.label}
        </button>
      )}
      {/* Title and actions are paired and centered against EACH OTHER only —
          not against subtitle below. Toolbar controls (selects, buttons) run
          taller than the wordmark's own line height; centering them against
          the title+subtitle column as one block let their extra height hang
          down into the subtitle row. Subtitle now lives on its own full-width
          line, immune to whatever height the actions row happens to be. */}
      <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h1
          class="board-mono min-w-0 max-w-full break-words font-bold text-[22px] text-ink leading-tight dark:text-ink-dark"
          id="page-title"
          tabIndex={-1}
        >
          {title}
        </h1>
        {actions && (
          <div class="flex flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
        )}
      </div>
      {subtitle && <div class="mt-3">{subtitle}</div>}
    </div>
  );
}

// Labeled content block — the detail page's info/actions/metrics groups.
export function Section({
  title,
  children,
  actions,
  id,
}: {
  title: string;
  children: ComponentChildren;
  actions?: ComponentChildren;
  id?: string;
}) {
  return (
    <div class="portal-section mb-8">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2
          class="section-anchor board-mono font-bold text-xs text-zinc-600 dark:text-zinc-300"
          id={id}
          tabIndex={id ? -1 : undefined}
        >
          {title}
        </h2>
        {actions}
      </div>
      <div class="glass-panel rounded-none p-4 sm:p-5">{children}</div>
    </div>
  );
}
