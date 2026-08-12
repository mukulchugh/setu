// Thin fetch wrapper shared by every component that talks to the portal
// backend — split out from app.tsx so components/ files (ports-page,
// settings-sections) don't have to import from app.tsx itself.
import type { Tone } from './ui';

export async function post(url: string, body: any) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Every route this hits always returns an explicit ok boolean (verified
// against portal.js), so one !res?.ok check replaces the 3 slightly different
// styles (res && res.ok === false / res?.ok === false / !res.ok) call sites
// had drifted into. Returns res either way so a caller can still branch on
// success for its own side effects.
export async function postOrToast(url: string, body: any, toast: (msg: string, tone?: Tone) => void, failMsg: string) {
  const res = await post(url, body);
  if (!res?.ok) toast(`✗ ${failMsg}: ${res?.error ?? 'unknown error'}`);
  return res;
}
