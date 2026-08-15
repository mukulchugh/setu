// Badge/StatusDot/StatusFlap — ported from ui.tsx onto Base UI + the shadcn
// cva/cn conventions. Small enough to fold into one file (matches ui.tsx's
// own grouping); StatusDot/StatusFlap are plain presentational components
// with no polymorphism story, so only Badge goes through Base UI's
// useRender — verified against node_modules/@base-ui/react source: it
// bottoms out in useRenderElement (React.createElement/cloneElement/
// isValidElement + a useMergedRefs hook, no useSyncExternalStore), the same
// render path every Dialog/Menu part the spike drove goes through.
import { useRender } from '@base-ui/react/use-render';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cva } from 'class-variance-authority';
import { cn } from './utils';

// Signal colors, not generic Tailwind brights — railway/aviation "clear /
// caution / stop" (see --color-signal-* in styles.css), matching the
// dispatch-board metaphor the whole design is built around. Tone's own key
// names stay the stock Tailwind words (emerald/amber/red) so every call site
// that already reads `tone="emerald"` for "running/positive" doesn't need to
// change — only what color that maps to changed, not the semantic vocabulary.
export type Tone = 'emerald' | 'amber' | 'red' | 'zinc';

const TONE_TEXT: Record<Tone, string> = {
  emerald: 'text-signal-green', amber: 'text-signal-amber', red: 'text-signal-red',
  zinc: 'text-zinc-500 dark:text-zinc-400',
};
const TONE_DOT: Record<Tone, string> = {
  emerald: 'bg-signal-green', amber: 'bg-signal-amber', red: 'bg-signal-red',
  zinc: 'bg-zinc-300 dark:bg-zinc-600',
};

export function StatusDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return <span class={cn('w-1.5 h-1.5 rounded-full shrink-0 transition-colors duration-300', TONE_DOT[tone], pulse && 'animate-pulse')} />;
}

// The signature moment: a genuine split-flap flip, but ONLY on an actual
// state transition (running -> stopped, etc.), never ambient or looping —
// spend the one bold motion moment where the metaphor earns it, not
// scattered across the page. Compares against the previous render's value;
// a re-render with the same text is a no-op, not a re-trigger. `prev` seeds
// with the initial text so mount itself never flaps.
export function StatusFlap({ text, tone }: { text: string; tone: Tone }) {
  const prev = useRef(text);
  const [flapping, setFlapping] = useState(false);
  useEffect(() => {
    if (prev.current !== text) { setFlapping(true); prev.current = text; }
  }, [text]);
  return (
    <span class={cn('board-mono text-[11px] font-bold shrink-0', TONE_TEXT[tone], flapping && 'flap-change')}
      onAnimationEnd={() => setFlapping(false)}>
      {text}
    </span>
  );
}

// Board-style label plaque — status labels, mode hints, resource badges.
// Uppercase, tracked, bold: signage, not a soft SaaS pill. `tip` renders the
// existing hover-tooltip CSS (styles.css's .tip::after) rather than a new
// mechanism. rounded-none always — no border radius anywhere in this app.
const badgeVariants = cva(
  'tip board-mono text-[9px] font-bold px-1.5 py-0.5 rounded-none shrink-0 transition-colors duration-200',
  {
    variants: {
      tone: {
        emerald: 'bg-signal-green/10 text-signal-green dark:bg-signal-green/15',
        amber: 'bg-signal-amber/10 text-signal-amber dark:bg-signal-amber/15',
        red: 'bg-signal-red/10 text-signal-red dark:bg-signal-red/15',
        // The one tone the old Badge left without a dark: pair — bg-zinc-100/
        // text-zinc-500 is a light-surface color, unreadable washed onto a
        // dark background. Every other tone rides transparent-alpha signal
        // colors that already hold up on either surface.
        zinc: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
      },
    },
    defaultVariants: { tone: 'zinc' },
  },
);

// Routed through Base UI's useRender (not a plain <span>) so Badge picks up
// the same `render` polymorphism every other Base UI part in this migration
// exposes in place of Radix's `asChild` — e.g. `<Badge render={<a href=.../>}>`.
// No call site needs that today; it's free (defaults to a plain span when
// `render` is omitted) and is what the actual base-nova registry source
// (ui.shadcn.com/r/styles/base-nova/badge.json) hands you for this component.
export function Badge({ tone = 'zinc', tip, class: cls, render, children }: {
  tone?: Tone;
  tip?: string;
  class?: string;
  render?: useRender.RenderProp<{ tone: Tone }>;
  children?: any;
}) {
  return useRender({
    defaultTagName: 'span',
    render,
    state: { tone },
    props: {
      className: cn(badgeVariants({ tone }), cls),
      children,
      ...(tip ? { 'data-tip': tip } : {}),
    },
  });
}
