// Standard shadcn "cn" utility — clsx for conditional class composition,
// tailwind-merge to resolve conflicting Tailwind classes deterministically
// (a later class in the list wins over an earlier one that touches the same
// property, e.g. a call-site `px-6` beats a base `px-4`). Every portal/ui/*
// primitive built off the shadcn registry expects this to exist at
// "portal/ui/utils.ts" — that's the registry's own `@/lib/utils` import
// path, adapted to this repo's layout.
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
