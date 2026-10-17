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

import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentChildren, JSX } from 'preact';
import { cn } from './utils';

// Mirrors ui.tsx's `Tone` union — duplicated, not imported, so this file has
// no dependency on ui.tsx (which the sweep phase deletes). Same signal
// colors (railway/aviation clear-amber-stop, see --color-signal-* in
// styles.css), same vocabulary every existing call site already uses.
export type Tone = 'emerald' | 'amber' | 'red' | 'zinc';

const TONE_TEXT: Record<Tone, string> = {
  amber: 'text-signal-amber',
  emerald: 'text-signal-green',
  red: 'text-signal-red',
  zinc: 'text-zinc-400',
};

// ---------------------------------------------------------------------------
// Button — replaces PrimaryButton (variant="primary") and SecondaryButton
// (variant="secondary"). No focus-visible ring in either variant: styles.css
// already applies a global `:focus-visible { outline: 2px solid
// var(--color-accent) !important }` ("quality floor" comment there) — a
// per-component ring would double up, not add anything.
// ---------------------------------------------------------------------------
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-normal rounded-none text-center font-semibold text-sm transition-colors duration-150 ease-out disabled:pointer-events-none disabled:opacity-50',
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
        // Forest green marks the primary action; press feedback changes color
        // without moving surrounding controls.
        primary:
          'border border-accent bg-accent text-white shadow-sm hover:bg-emerald-900 active:bg-emerald-950',
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
        secondary:
          'border border-white/75 bg-white/55 text-ink shadow-sm hover:bg-white/85 aria-expanded:bg-white/85 dark:border-white/10 dark:bg-white/5 dark:text-ink-dark dark:hover:bg-white/10',
      },
    },
  }
);

export interface ButtonProps extends VariantProps<typeof buttonVariants> {
  'aria-controls'?: string;
  'aria-describedby'?: string;
  'aria-expanded'?: boolean;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  children: ComponentChildren;
  class?: string;
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit' | 'reset';
}

export function Button({
  variant,
  compact,
  onClick,
  disabled,
  children,
  class: cls,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      {...props}
      className={cn(buttonVariants({ compact, variant }), cls)}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </ButtonPrimitive>
  );
}

// ---------------------------------------------------------------------------
// IconButton — icon-only action, `tip` renders the existing hover-tooltip
// CSS (styles.css's .tip::after), `href`/`target` switches to link-mode.
// ---------------------------------------------------------------------------
export interface IconButtonProps {
  children: ComponentChildren;
  disabled?: boolean;
  href?: string;
  // Accessible name when it should differ from the short visible tooltip.
  label?: string;
  onClick?: (e: JSX.TargetedMouseEvent<HTMLElement>) => void;
  target?: string;
  tip: string;
  tone?: Tone;
}

export function IconButton({
  tone = 'zinc',
  tip,
  label,
  onClick,
  disabled,
  href,
  target,
  children,
}: IconButtonProps) {
  const toneCls = disabled
    ? 'text-zinc-300'
    : `${TONE_TEXT[tone]} hover:bg-current/10`;
  const cls = cn(
    'tip icon-btn transition-colors duration-150 ease-out',
    toneCls
  );

  if (href) {
    // The old version fell back to `pointer-events-none` for the disabled
    // look on an <a> (anchors have no native `disabled` attribute) — but
    // that also blocks `:hover`, which silently kills `.tip:hover::after`
    // exactly when the tooltip is most useful (e.g. "Open in browser"
    // while the worktree isn't active yet, app.tsx:835). Omitting `href`
    // itself removes the navigation with no CSS trade-off, and
    // `aria-disabled` communicates the state to assistive tech.
    return (
      <a
        aria-disabled={disabled || undefined}
        aria-label={label ?? tip}
        class={cls}
        data-tip={tip}
        href={disabled ? undefined : href}
        rel={target === '_blank' ? 'noopener noreferrer' : undefined}
        role={disabled ? 'link' : undefined}
        target={target}
      >
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
    <ButtonPrimitive
      aria-label={label ?? tip}
      className={cls}
      data-tip={tip}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </ButtonPrimitive>
  );
}
