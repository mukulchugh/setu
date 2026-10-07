// Thin fetch wrapper shared by every component that talks to the portal
// backend — split out from app.tsx so components/ files (ports-page,
// settings-sections) don't have to import from app.tsx itself.
import type { Tone } from './ui';

export async function post(url: string, body: unknown) {
  try {
    const r = await fetch(url, {
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        'x-setu-source': 'ui',
      },
      method: 'POST',
    });
    const result = await r.json();
    if (
      !result ||
      typeof result !== 'object' ||
      typeof result.ok !== 'boolean' ||
      (!r.ok && result.ok)
    ) {
      return {
        error: 'Outcome not confirmed. Refresh status before trying again.',
        networkUncertain: true,
        ok: false,
      };
    }
    return result;
  } catch {
    return {
      error: 'Outcome not confirmed. Refresh status before trying again.',
      networkUncertain: true,
      ok: false,
    };
  }
}

// Every route this hits always returns an explicit ok boolean (verified
// against portal.js), so one !res?.ok check replaces the 3 slightly different
// styles (res && res.ok === false / res?.ok === false / !res.ok) call sites
// had drifted into. Returns res either way so a caller can still branch on
// success for its own side effects.
export async function postOrToast(
  url: string,
  body: unknown,
  toast: (msg: string, tone?: Tone) => void,
  failMsg: string
) {
  const res = await post(url, body);
  if (!res?.ok) {
    toast(`✗ ${failMsg}: ${res?.error ?? 'unknown error'}`);
  }
  return res;
}
