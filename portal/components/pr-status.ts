// Split out of app.tsx for the same reason relative-time.tsx was: a
// components/ file needs this, and app.tsx importing a components/ file
// while that file value-imports back from app.tsx is a circular value
// import (app.tsx already imports every components/ file, never the
// reverse). checksTone is a pure function of PrChecks, unrelated to
// anything else in app.tsx, so it moves here whole rather than being
// duplicated per caller.
export type PrChecks = 'passing' | 'failing' | 'pending' | 'none';

export function checksTone(
  checks: PrChecks
): 'emerald' | 'red' | 'amber' | 'zinc' {
  if (checks === 'passing') {
    return 'emerald';
  }
  if (checks === 'failing') {
    return 'red';
  }
  if (checks === 'pending') {
    return 'amber';
  }
  return 'zinc';
}
