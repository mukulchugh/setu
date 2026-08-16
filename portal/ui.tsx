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
  emerald: 'text-signal-green', amber: 'text-signal-amber', red: 'text-signal-red', zinc: 'text-zinc-400',
};
const TONE_DOT: Record<Tone, string> = {
  emerald: 'bg-signal-green', amber: 'bg-signal-amber', red: 'bg-signal-red', zinc: 'bg-zinc-300',
};
const TONE_SOFT: Record<Tone, string> = {
  emerald: 'bg-signal-green/10 text-signal-green', amber: 'bg-signal-amber/10 text-signal-amber',
  red: 'bg-signal-red/10 text-signal-red', zinc: 'bg-zinc-100 text-zinc-500',
};

export function StatusDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return <span class={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors duration-300 ${TONE_DOT[tone]} ${pulse ? 'animate-pulse' : ''}`} />;
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
    if (prev.current !== text) { setFlapping(true); prev.current = text; }
  }, [text]);
  return (
    <span class={`board-mono text-[11px] font-bold ${TONE_TEXT[tone]} shrink-0 ${flapping ? 'flap-change' : ''}`}
      onAnimationEnd={() => setFlapping(false)}>
      {text}
    </span>
  );
}

// Board-style label plaque — status labels, mode hints, resource badges.
// Uppercase, tracked, bold: signage, not a soft SaaS pill. `tip` renders the
// existing hover-tooltip CSS (styles.css's .tip::after) rather than a new mechanism.
export function Badge({ tone, tip, children }: { tone: Tone; tip?: string; children: ComponentChildren }) {
  return (
    <span {...(tip ? { 'data-tip': tip } : {})}
      class={`tip board-mono text-[9px] font-bold px-1.5 py-0.5 rounded-none shrink-0 transition-colors duration-200 ${TONE_SOFT[tone]}`}>
      {children}
    </span>
  );
}

// Wraps the .icon-btn/.tip CSS pattern (styles.css) so every icon action
// shares one hover/disabled/transition definition instead of restating
// `tip icon-btn text-X hover:bg-Y transition-colors` at 15+ call sites.
export function IconButton({ tone = 'zinc', tip, onClick, disabled, href, target, children }: {
  tone?: Tone; tip: string; onClick?: () => void; disabled?: boolean; href?: string; target?: string; children: ComponentChildren;
}) {
  const cls = `tip icon-btn transition-all duration-200 ease-out ${
    disabled ? 'text-zinc-300 pointer-events-none' : `${TONE_TEXT[tone]} hover:bg-current/10`
  }`;
  if (href) return <a href={href} target={target} data-tip={tip} class={cls}>{children}</a>;
  return <button onClick={onClick} disabled={disabled} data-tip={tip} class={cls}>{children}</button>;
}

// Glass + tactile: frosted translucency (modern/SaaS) with a hard offset
// shadow that collapses on press (a real button being pushed), not a soft
// glow. The accent color is reserved for these primary actions only — see
// --color-accent (Quivly's brand forest green).
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
const buttonBase = 'whitespace-nowrap board-mono text-[11px] font-bold rounded-none backdrop-blur-md transition-all duration-150 ease-out disabled:opacity-50 disabled:pointer-events-none active:translate-y-px';
export function PrimaryButton({ onClick, disabled, children, class: cls = '', compact = false }: { onClick?: () => void; disabled?: boolean; children: ComponentChildren; class?: string; compact?: boolean }) {
  return <button onClick={onClick} disabled={disabled} class={`${buttonBase} ${compact ? 'px-3 py-1.5' : 'px-4 py-2.5'} ${cls} bg-accent text-white border border-accent shadow-[0_2px_0_0_rgba(0,0,0,0.25)] hover:brightness-125 hover:shadow-[0_2px_12px_0_rgba(8,80,65,0.45)] active:shadow-none`}>{children}</button>;
}
export function SecondaryButton({ onClick, disabled, children, class: cls = '', compact = false }: { onClick?: () => void; disabled?: boolean; children: ComponentChildren; class?: string; compact?: boolean }) {
  return <button onClick={onClick} disabled={disabled} class={`${buttonBase} ${compact ? 'px-3 py-1.5' : 'px-4 py-2.5'} ${cls} bg-white/55 dark:bg-white/5 border border-white/75 dark:border-white/10 text-ink dark:text-ink-dark shadow-sm hover:bg-white/85 dark:hover:bg-white/10`}>{children}</button>;
}

// Toast state (id/tone/timeout) lives in App — the one place that already
// threads a `toast` prop through every route (WorktreePage, SettingsPage).
// This just renders the stack; App decides what and when.
export type ToastItem = { id: number; msg: string; tone: Tone };

const TOAST_BG: Record<Tone, string> = {
  red: 'bg-signal-red/95 border-signal-red', emerald: 'bg-signal-green/95 border-signal-green',
  amber: 'bg-signal-amber/95 border-signal-amber', zinc: 'bg-zinc-900/95 border-zinc-800',
};

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div class="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] flex flex-col-reverse gap-2 items-center">
      {toasts.map(t => (
        <button key={t.id} onClick={() => onDismiss(t.id)}
          class={`text-xs text-white text-left px-4 py-2.5 rounded-none shadow-lg max-w-md border backdrop-blur-md
            transition-all duration-200 ease-out animate-[fadeUp_0.2s_ease-out] ${TOAST_BG[t.tone]}`}>
          {t.msg}
        </button>
      ))}
    </div>
  );
}

export function Modal({ onClose, children, position = 'center' }: { onClose: () => void; children: ComponentChildren; position?: 'center' | 'bottom' }) {
  return (
    <div class={`fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex transition-opacity duration-200 ${position === 'bottom' ? 'items-end justify-stretch' : 'items-center justify-center'}`}
      onClick={(e: MouseEvent) => { if (e.target === e.currentTarget) onClose(); }}>
      {children}
    </div>
  );
}

// Shared X-mark path — CloseBtn below and app.tsx's SidecarRow/CustomAgentRow
// remove buttons all draw the same icon at different sizes.
export function CloseIcon({ class: cls = 'w-4 h-4' }: { class?: string }) {
  return <svg class={cls} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M18 6l-12 12" /><path d="M6 6l12 12" /></svg>;
}

export function CloseBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors duration-200">
      <CloseIcon />
    </button>
  );
}

// Click-outside-to-close menu — the one interaction pattern app.tsx needed in
// three places (worktree "more" menu, start-mode menu). One implementation,
// not three copies of the same document-listener effect.
export function Menu({ trigger, children, align = 'right' }: { trigger: (toggle: () => void) => ComponentChildren; children: ComponentChildren; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  return (
    <div class="relative">
      {trigger(() => setOpen(o => !o))}
      {open && (
        <div onClick={() => setOpen(false)}
          class={`menu-panel-open absolute ${align === 'right' ? 'right-0' : 'left-0'} top-8 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md border border-zinc-200 dark:border-zinc-700 rounded-none shadow-lg z-30 py-1 min-w-[170px] origin-top transition-all duration-150 ease-out`}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, tone = 'zinc', icon, children }: { onClick: () => void; tone?: 'zinc' | 'red'; icon?: ComponentChildren; children: ComponentChildren }) {
  return (
    <button onClick={onClick}
      class={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 whitespace-nowrap transition-colors duration-150 ${
        tone === 'red' ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10' : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-white/10'}`}>
      {icon}{children}
    </button>
  );
}

export const inputCls = 'bg-white border border-zinc-200 text-zinc-800 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-zinc-400 placeholder-zinc-400 transition-colors duration-150';

// Semantic <kbd> for shortcut badges (⌘K etc.) instead of a plain styled span.
export function Kbd({ children }: { children: ComponentChildren }) {
  return (
    <kbd class="board-mono text-[9px] font-bold text-zinc-500 dark:text-zinc-400 border border-zinc-300 dark:border-zinc-700 rounded-none px-1.5 py-0.5">
      {children}
    </kbd>
  );
}

// Two real call sites (the list view's header, the worktree detail page) is
// enough to know the right shape — not built ahead of a second consumer.
export function PageHeader({ back, title, subtitle, actions }: { back?: { label: string; onClick: () => void }; title: ComponentChildren; subtitle?: ComponentChildren; actions?: ComponentChildren }) {
  // Transparent at rest — the glass/blur backdrop only appears once content
  // has actually scrolled underneath (position:sticky has no stable CSS way
  // to select "currently stuck", so this is tracked directly). Stuck state
  // also compresses the header (shorter padding, smaller title) the way
  // Linear/Vercel-style dashboards do — a relaxed hero at rest, a tight
  // utility bar once you're scrolling past it.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <div class={`sticky top-0 z-30 -mx-6 px-6 mb-6 border-b transition-all duration-300 ease-out ${
      stuck
        ? 'pt-3 pb-3 backdrop-blur-lg bg-board/90 dark:bg-board-dark/90 border-zinc-200/70 dark:border-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.18)]'
        : 'pt-6 pb-4 bg-transparent border-transparent'}`}>
      {back && (
        <button onClick={back.onClick} class="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 transition-colors duration-150 mb-2">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M15 6l-6 6l6 6" /></svg>
          {back.label}
        </button>
      )}
      {/* Title and actions are paired and centered against EACH OTHER only —
          not against subtitle below. Toolbar controls (selects, buttons) run
          taller than the wordmark's own line height; centering them against
          the title+subtitle column as one block let their extra height hang
          down into the subtitle row. Subtitle now lives on its own full-width
          line, immune to whatever height the actions row happens to be. */}
      <div class="flex items-center justify-between flex-wrap gap-y-3">
        <h1 class={`board-mono font-bold text-ink dark:text-ink-dark leading-none truncate transition-all duration-300 ease-out ${
          stuck ? 'text-[15px]' : 'text-[22px]'}`}>{title}</h1>
        {actions && <div class="flex items-center gap-2 flex-wrap justify-end">{actions}</div>}
      </div>
      {subtitle && !stuck && <div class="mt-3">{subtitle}</div>}
    </div>
  );
}

// Labeled content block — the detail page's info/actions/metrics groups.
export function Section({ title, children, actions }: { title: string; children: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <div class="mb-8">
      <div class="flex items-center justify-between mb-3">
        <h2 class="board-mono text-[11px] font-bold text-zinc-400">{title}</h2>
        {actions}
      </div>
      <div class="bg-white/90 dark:bg-zinc-900/60 backdrop-blur-md border border-zinc-200 dark:border-zinc-800 rounded-none p-5">
        {children}
      </div>
    </div>
  );
}
