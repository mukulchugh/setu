// Base UI-backed replacement for ui.tsx's PrimaryButton/SecondaryButton (one
// `variant` prop now covers both) and IconButton (icon-only, `tip` tooltip,
// `href`/`target` link-mode). Ported from shadcn's registry — but NOT from
// the literal /r/styles/new-york/button.json URL, which is a legacy style
// slug still serving `@radix-ui/react-slot`. The actual current default is
// style "base-nova" (confirmed live: https://ui.shadcn.com/r/styles/base-nova/button.json),
// which wraps @base-ui/react/button's `Button` primitive — that's the shape
// ported here. Its class strings were NOT reused: they're shadcn's own
// design tokens (`bg-primary`, `--radius-md`, `ring-ring/50`, ...) that
// don't exist in this repo's styles.css and would render unstyled under our
// Tailwind v4 @theme. Every visual class below instead comes straight from
// ui.tsx's PrimaryButton/SecondaryButton/IconButton — this is a like-for-like
// visual port, not a redesign.
import type { ComponentChildren, JSX } from 'preact';
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils';

// Mirrors ui.tsx's `Tone` union — duplicated, not imported, so this file has
// no dependency on ui.tsx (which the sweep phase deletes). Same signal
// colors (railway/aviation clear-amber-stop, see --color-signal-* in
// styles.css), same vocabulary every existing call site already uses.
export type Tone = 'emerald' | 'amber' | 'red' | 'zinc';

const TONE_TEXT: Record<Tone, string> = {amber: 'text-signal-amber', 
  emerald: 'text-signal-green', red: 'text-signal-red', zinc: 'text-zinc-400',
};

// ---------------------------------------------------------------------------
// Button — replaces PrimaryButton (variant="primary") and SecondaryButton
// (variant="secondary"). No focus-visible ring in either variant: styles.css
// already applies a global `:focus-visible { outline: 2px solid
// var(--color-accent) !important }` ("quality floor" comment there) — a
// per-component ring would double up, not add anything.
// ---------------------------------------------------------------------------
const buttonVariants = cva(
  'whitespace-nowrap board-mono text-[11px] font-bold rounded-none backdrop-blur-md transition-all duration-150 ease-out disabled:opacity-50 disabled:pointer-events-none active:translate-y-px',
  {
    defaultVariants: { compact: false, variant: 'primary' },
    variants: {
      // A variant, not a suffix class appended after the base string:
      // tailwind-merge (via `cn`) resolves the px-*/py-* conflict
      // deterministically regardless of order, but keeping padding as its
      // own cva axis (rather than folded into `variant`) is what lets a
      // call-site `class="px-6"` still cleanly override on top.
      compact: {
        false: 'px-4 py-2.5',
        true: 'px-3 py-1.5',
      },
      variant: {
        // Glass + tactile: frosted translucency with a hard offset shadow
        // that collapses on press. Accent (Quivly forest green) reserved
        // for primary actions only.
        primary: 'bg-accent text-white border border-accent shadow-[0_2px_0_0_rgba(0,0,0,0.25)] hover:brightness-125 hover:shadow-[0_2px_12px_0_rgba(8,80,65,0.45)] active:shadow-none',
        // aria-expanded styling is new vs. the old SecondaryButton: Base UI
        // sets aria-expanded on trigger elements (e.g. a Menu.Trigger
        // rendered as this Button via `render`), so a menu/dialog trigger
        // gets a lit "currently open" affordance instead of looking
        // identical to its own closed state. Only the single-variant form
        // (`aria-expanded:`) is used, not `dark:aria-expanded:` stacked on
        // top — nothing imports this file yet, so Tailwind's scanner has
        // never generated CSS from it and that two-variant composition is
        // unverified; confirm it renders once a consumer imports Button
        // before trusting the dark-mode half.
        secondary: 'bg-white/55 dark:bg-white/5 border border-white/75 dark:border-white/10 text-ink dark:text-ink-dark shadow-sm hover:bg-white/85 dark:hover:bg-white/10 aria-expanded:bg-white/85',
      },
    },
  },
);

export interface ButtonProps extends VariantProps<typeof buttonVariants> {
  onClick?: () => void;
  disabled?: boolean;
  children: ComponentChildren;
  class?: string;
}

export function Button({ variant, compact, onClick, disabled, children, class: cls }: ButtonProps) {
  return (
    <ButtonPrimitive onClick={onClick} disabled={disabled} className={cn(buttonVariants({ compact, variant }), cls)}>
      {children}
    </ButtonPrimitive>
  );
}

// ---------------------------------------------------------------------------
// IconButton — icon-only action, `tip` renders the existing hover-tooltip
// CSS (styles.css's .tip::after), `href`/`target` switches to link-mode.
// ---------------------------------------------------------------------------
export interface IconButtonProps {
  tone?: Tone;
  tip: string;
  onClick?: (e: JSX.TargetedMouseEvent<HTMLElement>) => void;
  disabled?: boolean;
  href?: string;
  target?: string;
  children: ComponentChildren;
}

export function IconButton({ tone = 'zinc', tip, onClick, disabled, href, target, children }: IconButtonProps) {
  const toneCls = disabled ? 'text-zinc-300' : `${TONE_TEXT[tone]} hover:bg-current/10`;
  const cls = cn('tip icon-btn transition-all duration-200 ease-out', toneCls);

  if (href) {
    // The old version fell back to `pointer-events-none` for the disabled
    // look on an <a> (anchors have no native `disabled` attribute) — but
    // that also blocks `:hover`, which silently kills `.tip:hover::after`
    // exactly when the tooltip is most useful (e.g. "Open in browser"
    // while the worktree isn't active yet, app.tsx:835). Omitting `href`
    // itself removes the navigation with no CSS trade-off, and
    // `aria-disabled` communicates the state to assistive tech.
    return (
      <a href={disabled ? undefined : href} target={target}
        rel={target === '_blank' ? 'noopener noreferrer' : undefined}
        role={disabled ? 'link' : undefined} aria-disabled={disabled || undefined} data-tip={tip} class={cls}>
        {children}
      </a>
    );
  }

  // Button-mode: Base UI's native `disabled` attribute already blocks
  // clicks and keyboard activation (its internal useButton guards both), so
  // — unlike the old version — no `pointer-events-none` is layered on top.
  // Skipping it means `:hover` (and therefore the tooltip) still fires on a
  // disabled button: "Starting…" (app.tsx:318), "Deploying to…"
  // (app.tsx:387, 665) are live tooltips now instead of dead ones.
  return (
    <ButtonPrimitive onClick={onClick} disabled={disabled} data-tip={tip} className={cls}>
      {children}
    </ButtonPrimitive>
  );
}
