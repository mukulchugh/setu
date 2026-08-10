// Small reusable UI kit for the portal — extracted so app.tsx doesn't repeat
// the same badge/button/status-dot styling inline at every call site. Kept
// as plain functions, not a component library package: this is a ~500-line
// single-page tool, not a design system with multiple consumers.
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
export function Badge({ tone, tip, children }: { tone: Tone; tip?: string; children: any }) {
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
  tone?: Tone; tip: string; onClick?: (e: any) => void; disabled?: boolean; href?: string; target?: string; children: any;
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
const buttonBase = 'whitespace-nowrap board-mono text-[11px] font-bold px-4 py-2.5 rounded-none backdrop-blur-md transition-all duration-150 ease-out disabled:opacity-50 disabled:pointer-events-none active:translate-y-px';
export function PrimaryButton({ onClick, disabled, children, class: cls = '' }: { onClick?: () => void; disabled?: boolean; children: any; class?: string }) {
  return <button onClick={onClick} disabled={disabled} class={`${buttonBase} ${cls} bg-accent text-white border border-accent shadow-[0_2px_0_0_rgba(0,0,0,0.25)] hover:brightness-125 hover:shadow-[0_2px_12px_0_rgba(8,80,65,0.45)] active:shadow-none`}>{children}</button>;
}
export function SecondaryButton({ onClick, children, class: cls = '' }: { onClick?: () => void; children: any; class?: string }) {
  return <button onClick={onClick} class={`${buttonBase} ${cls} bg-white/55 dark:bg-white/5 border border-white/75 dark:border-white/10 text-ink dark:text-ink-dark shadow-sm hover:bg-white/85 dark:hover:bg-white/10`}>{children}</button>;
}

export function Modal({ onClose, children, position = 'center' }: any) {
  return (
    <div class={`fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex transition-opacity duration-200 ${position === 'bottom' ? 'items-end justify-stretch' : 'items-center justify-center'}`}
      onClick={(e: any) => { if (e.target === e.currentTarget) onClose(); }}>
      {children}
    </div>
  );
}

export function CloseBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors duration-200">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
    </button>
  );
}

// Click-outside-to-close menu — the one interaction pattern app.tsx needed in
// three places (worktree "more" menu, start-mode menu). One implementation,
// not three copies of the same document-listener effect.
export function Menu({ trigger, children, align = 'right' }: { trigger: (toggle: () => void) => any; children: any; align?: 'left' | 'right' }) {
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
          class={`menu-panel-open absolute ${align === 'right' ? 'right-0' : 'left-0'} top-8 bg-white/95 backdrop-blur-md border border-zinc-200 rounded-none shadow-lg z-30 py-1 min-w-[170px] origin-top transition-all duration-150 ease-out`}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, tone = 'zinc', icon, children }: { onClick: () => void; tone?: 'zinc' | 'red'; icon?: any; children: any }) {
  return (
    <button onClick={onClick}
      class={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 whitespace-nowrap transition-colors duration-150 ${
        tone === 'red' ? 'text-red-600 hover:bg-red-50' : 'text-zinc-700 hover:bg-zinc-50'}`}>
      {icon}{children}
    </button>
  );
}

export const inputCls = 'bg-white border border-zinc-200 text-zinc-800 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-zinc-400 placeholder-zinc-400 transition-colors duration-150';

// Two real call sites (the list view's header, the worktree detail page) is
// enough to know the right shape — not built ahead of a second consumer.
export function PageHeader({ back, title, subtitle, actions }: { back?: { label: string; onClick: () => void }; title: any; subtitle?: any; actions?: any }) {
  // Transparent at rest — the glass/blur backdrop only appears once content
  // has actually scrolled underneath (position:sticky has no stable CSS way
  // to select "currently stuck", so this is tracked directly).
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <div class={`sticky top-0 z-30 -mx-6 px-6 pt-6 pb-4 mb-6 transition-colors duration-200 ${
      stuck ? 'backdrop-blur-md bg-board/85 dark:bg-board-dark/85 shadow-sm' : 'bg-transparent'}`}>
      {back && (
        <button onClick={back.onClick} class="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 transition-colors duration-150 mb-2">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
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
        <h1 class="board-mono text-[22px] font-bold text-ink dark:text-ink-dark leading-none truncate">{title}</h1>
        {actions && <div class="flex items-center gap-2 flex-wrap justify-end">{actions}</div>}
      </div>
      {subtitle && <div class="mt-3">{subtitle}</div>}
    </div>
  );
}

// Labeled content block — the detail page's info/actions/metrics groups.
export function Section({ title, children, actions }: { title: string; children: any; actions?: any }) {
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
