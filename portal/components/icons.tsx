// Icon data and small icon-rendering components used across the portal —
// pure data plus one small render component each, no coupling to app state.
import { siAmp, siClaude, siConvex, siCursor, siOpencode } from 'simple-icons';

// Real brand marks, SVG path data bundled at build time — not fetched at
// runtime (a live per-icon image request is a fragile dependency; confirmed
// twice tonight when chatgpt.com/favicon.ico and openai.com/favicon.ico both
// returned an HTML challenge page instead of image bytes). Verified directly
// against the installed simple-icons package (v16.28.0, latest as of this
// check; scanned all 3453 entries) — it carries no OpenAI/Codex mark at all,
// a deliberate licensing exclusion rather than a missing slug. The actual
// OpenAI mark below is sourced once from lobehub/lobe-icons (MIT-licensed,
// github.com/lobehub/lobe-icons/packages/static-svg — an icon set built
// specifically for AI-provider brand marks, unlike simple-icons which
// excludes them) and hardcoded here the same way the simple-icons ones are.
// Antigravity and Grok have no mark in either library, and no real one
// gets bundled for them: an earlier pass used the Google/X parent-brand
// logos as stand-ins, but at these icon sizes that reads as "open in
// Google"/"open in X (Twitter)", not the actual coding tool -- a wrong
// logo is worse than the plain two-letter fallback ToolIcon already draws
// when AGENT_ICON has no entry for an id.
export const siOpenai = {
  hex: '000000',
  path: 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z',
};

export const AGENT_ICON: Record<string, { path: string; hex: string }> = {
  amp: siAmp,
  claude: siClaude,
  codex: siOpenai,
  cursor: siCursor,
  opencode: siOpencode,
};

// Bundled SVG path data, not a fetched favicon — an external image request
// per icon (google's favicon service) is a real network dependency for a
// purely cosmetic detail, and it failed/hung often enough in practice to
// leave broken-image placeholders instead of the intended fallback
// (confirmed live: every agent icon rendered broken, not text, meaning the
// onError handler never reliably fired). Bundled path data has no such
// failure mode — it's not a request.
export function ToolIcon({ id, label }: { id?: string; label: string }) {
  const icon = id && AGENT_ICON[id];
  if (icon) {
    return (
      <svg
        aria-hidden="true"
        class="h-3.5 w-3.5 shrink-0"
        fill={`#${icon.hex}`}
        viewBox="0 0 24 24"
      >
        <path d={icon.path} />
      </svg>
    );
  }
  // Same footprint as the real marks above (w-3.5 h-3.5) so a fallback tool
  // lines up in a row/list next to ones that do have a bundled logo,
  // instead of floating as bare undersized text.
  return (
    <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-none bg-zinc-200 font-bold text-[7px] text-zinc-600 leading-none tracking-tight dark:bg-zinc-700 dark:text-zinc-300">
      {label.slice(0, 2).toUpperCase()}
    </span>
  );
}

// Neither Trigger.dev nor Inngest is a vector mark anywhere (not in
// simple-icons, not in lobehub/lobe-icons) — their real favicons are small
// raster PNGs, sourced once (trigger.dev/favicon.ico, inngest.com/favicon.ico)
// and inlined as data URIs so they're bundled the same as every other icon
// here: no runtime request, no failure mode to reproduce.
export const TRIGGER_ICON_URI =
  'data:image/png;base64,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';
export const INNGEST_ICON_URI =
  'data:image/png;base64,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';
export function SidecarIcon({ tool }: { tool: 'trigger' | 'inngest' }) {
  return (
    <img
      alt=""
      class="h-3.5 w-3.5 rounded-none"
      height={14}
      src={tool === 'trigger' ? TRIGGER_ICON_URI : INNGEST_ICON_URI}
      width={14}
    />
  );
}

export const MUKUL_LOGO_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAMKADAAQAAAABAAAAMAAAAADbN2wMAAAFM0lEQVRoBd1ZSUtsRxQ+2s7THzDoi0F9KGpQQReujJsQJRFEXAny3LkV4vADEhcS4kIi4oCCuMnGlYqggggiJuHxVDRq8GmMGsF5Hjrnq3CLe693qO42dncOnL41n++rOnXqVl+iMJcIB/xRXPeGtZD1M9Y41teUKzb2O+uvrB9ZH1mVJY9b9rCi4z2rN0h6x3a3WH9kzWJ1lUhuUcu6wRos0HZ2PzCmryJY+GkrAP83q90gwS7/k7F9aYcebgOfCzZIN/u/MUbsSYN4OPcTq1vnUKn/3oCeM9gg22FEYIWxprISNi3kc1ZRIHKh//MpQ8wFTI1ABqfhRuEiOJPSAFYj4HpIZWZmUlqa6BMqJBP0BFxBFRUVUUtLC8XGxrq2fYkGsOMS8sXkayvgajM5OZnq6+uppqbGtW2gDTIyMqipqYni4lwdQ7qQq83ExESCtra2UnZ2tmt7fxsAfE9PD1VWVioN4dMKYMTc3Fxqa2ujhAThgkpGVBtlZWVRb28vVVRU0NPTE3m9OHacRZlAUlKSHKm2tpbq6upk/iUSOTk51NfXR+Xl5WI4FfBoqEwgJSVF4oRvYkPn5eHtI3ApKCig/v5+Kisr83kwJQKIBvoVgBWE1fb29mflviIoLi4W4EtKSgxdsQIqq6BEwOPxWAKtqqqi0tJSg2FfMgANtyksxJ3JKCrg0QO3LleJioqy3LSRkZEEhcTExFBDQwOlp6fT2dkZXV5eSr26uqLr62vCc3V1lY6Pj0WfxsZGys/PF2l/f5QJmF0IBu/u7uj09FTYRhqz1tzcTNHR0RIPosnj46OIKltbW1RdXS0J3N/jsmct6KciSi4EQFZh8+bmhi4uLqSd0dFRGh8fl3kksELoj5N1bGyM1tfXZf3JyYlMmxOqLqREAMatTkW4BVxFE7hOZ2cnHR0daUXyidkfGBgwbEwnArKjSyIgAgAPv9bL3NwcDQ0N6YtEGmVra2uGcicCWAGVVVAigNmPj483GEfm/Pycbm9vDeXw9+7ublpZwZ3jX8HGHR4e1rLyif1j5+sq4DGQEgGA129MDYEVAdRtbm5SV1cXYZMCyODgIMGFzAKXc9rI5vZWeSUCeIlDmDQLZtAOADb09PQ0LS8v08jIiLmryDsRUF0BpTCKCISzwCzwYbiMlYBcR0cHpaam0u7urlUTEcEQfq0EBFRIPEdlMRpWwI6ARXNZNDMzIw86WahLaAecrsjnpBIBHGLaiau3oJ2o+jJ9GhvUbpOinRMBldnHGEp7ALcxfwjAgJOYzxF92xclYPUagZl1iuN6MHZp+D8iWSCivAJmIw8PD/8pAUyQyir4TQDhE2EwEEEEsxtDBTxsKxGwciG8yAW6/CBg54Yuf6nIeXONQti8dgT0b6JyRB8T2uu41g2uube3R0tLS44RTGvvSgDxXyOAGTs8PBSn68TEBO3v72vj+P0EAYDe2Nig+fl5mpqaooWFBdrZ2XkZAlhKvMfg747Z2VkxM9vb2+KG5TdqXcfJyUkxIYuLi3RwcGB7suu6aEnDjedbLrX8758JePllzsuuZFlv1+8Vyt+BieZCm5x+0OVRJwTRAAdOiAkA4XuGjEL4lLmDgjARTPgysGph9A9Oj6EgTORnxvmXGetbLsA1KtR83YxnkTHafqj4hisRG82dQiUPv/+C1VYiuOZr1lBciV8YV4UtclMFvlr+wIrvxri1B2sFbtj2Kut3rG9Ynwlm3E48XIEvl/jv7xNW/N0GIq8hwIW75kfW96zYsIaDi/P/D/kHGNOpOz6fLmoAAAAASUVORK5CYII=';

// Vercel and Netlify's real logomarks, used by DeployMenu in app.tsx.
// class defaults to 'w-4 h-4' but every call site can override it (same
// prop pattern as CloseIcon in ui.tsx), since the two places these get used
// (the deploy-menu trigger, the deployed-badge link) draw them at different
// sizes. Both are always drawn with fill="currentColor" rather than either
// brand's own color, on purpose: it lets this app's own tone system (zinc
// idle, amber deploying, emerald deployed) recolor them, matching every
// other icon-as-status-indicator in the app instead of carrying a fixed
// brand color that would clash with it.
// Vercel's path is the actual logomark (a plain triangle, vercel.com's own
// brand asset). Netlify has no equivalent in Tabler at all -- checked both
// icons/outline and icons/filled trees directly in the tabler/tabler-icons
// repo: Vercel is there as brand-vercel, Netlify isn't -- so its path comes
// from the same simple-icons package already imported above for the agent
// tool logos (siNetlify, the real Netlify press-kit mark).
export function VercelIcon({ class: cls = 'w-4 h-4' }: { class?: string }) {
  return (
    <svg aria-hidden="true" class={cls} fill="currentColor" viewBox="0 0 76 65">
      <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
    </svg>
  );
}
export function NetlifyIcon({ class: cls = 'w-4 h-4' }: { class?: string }) {
  return (
    <svg aria-hidden="true" class={cls} fill="currentColor" viewBox="0 0 24 24">
      <path d="M6.49 19.04h-.23L5.13 17.9v-.23l1.73-1.71h1.2l.15.15v1.2L6.5 19.04ZM5.13 6.31V6.1l1.13-1.13h.23L8.2 6.68v1.2l-.15.15h-1.2L5.13 6.31Zm9.96 9.09h-1.65l-.14-.13v-3.83c0-.68-.27-1.2-1.1-1.23-.42 0-.9 0-1.43.02l-.07.08v4.96l-.14.14H8.9l-.13-.14V8.73l.13-.14h3.7a2.6 2.6 0 0 1 2.61 2.6v4.08l-.13.14Zm-8.37-2.44H.14L0 12.82v-1.64l.14-.14h6.58l.14.14v1.64l-.14.14Zm17.14 0h-6.58l-.14-.14v-1.64l.14-.14h6.58l.14.14v1.64l-.14.14ZM11.05 6.55V1.64l.14-.14h1.65l.14.14v4.9l-.14.14h-1.65l-.14-.13Zm0 15.81v-4.9l.14-.14h1.65l.14.13v4.91l-.14.14h-1.65l-.14-.14Z" />
    </svg>
  );
}

// Convex's real logomark. Sourced live from the siConvex import above rather
// than a hardcoded path copy (unlike Vercel/Netlify above) -- both are
// equally free of any runtime request (simple-icons is bundled at build
// time either way), so referencing the import directly is just less to keep
// in sync if the package ever updates the mark.
export function ConvexIcon({ class: cls = 'w-4 h-4' }: { class?: string }) {
  return (
    <svg aria-hidden="true" class={cls} fill="currentColor" viewBox="0 0 24 24">
      <path d={siConvex.path} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Tabler-sourced icon path data. The installed @tabler/icons package (v3.46.0
// — node_modules/@tabler/icons/package.json — pinned here since there's no
// JS/JSON export to import a version from) ships only raw SVG files under
// icons/outline/*.svg and icons/filled/*.svg (exports map "./*": "./icons/*"),
// no path-data module the way simple-icons has. Path data extracted by hand
// from those files and hardcoded here the same way siOpenai above is (that
// constant's own `path` already concatenates several "M..." subpaths into one
// string for the same reason — SVG allows multiple subpaths in a single `d`
// attribute, each new "M" opening one) — not a runtime .svg import.
//
// Every constant below was matched to a real installed file by grepping a
// distinctive fragment of the codebase's EXISTING hand-drawn inline icon (the
// one this constant is meant to eventually replace) against
// icons/{outline,filled}/*.svg, then diffed byte-for-byte against that file's
// own <path> content — not guessed from the icon's apparent shape or name.
// Most of this codebase's hand-drawn "Tabler-style" icons turned out to
// already be verbatim copies of the real path data; these exports make that a
// stated, sourced fact instead of an unverified coincidence. One exception:
// the "Repo overview" sidebar icon (app.tsx, three connected dots) draws real
// SVG <circle> elements, which no actual Tabler file does (even Tabler's own
// circular glyphs are drawn as an arc path, e.g. tablerCircle below) — no
// Tabler equivalent exists for it, so it has no constant here, same as
// Netlify's mark above having no Tabler equivalent either.
//
// `path` concatenates every <path d="..."> in the source file, skipping the
// leading `<path stroke="none" d="M0 0h24v24H0z" fill="none" />` bounding-box
// filler every outline.svg starts with — `<path d={icon.path} />` alone
// reproduces the original multi-stroke icon exactly (each subpath strokes
// independently). Outline icons (fill="none" stroke) render with
// fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
// stroke-linejoin="round" viewBox="0 0 24 24" — the exact attributes every
// hand-drawn outline icon in this codebase already uses. Filled icons
// (`*Filled` below, sourced from icons/filled/ instead of icons/outline/)
// render with just fill="currentColor" viewBox="0 0 24 24", no stroke
// attributes — same as ToolIcon's brand-mark rendering above.
//
// Wiring these into real call sites in place of the inline hand-drawn SVGs
// they were extracted from is a separate, larger follow-up, out of scope
// here — these are the sourced, verified constants that follow-up wires up.
export const tablerSearch = {
  path: 'M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0 M21 21l-6 -6',
};
export const tablerRefresh = {
  path: 'M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4 M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4',
};
export const tablerExternalLink = {
  path: 'M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6 M11 13l9 -9 M15 4h5v5',
};
export const tablerTerminal2 = {
  path: 'M8 9l3 3l-3 3 M13 15l3 0 M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12',
};
export const tablerCheck = { path: 'M5 12l5 5l10 -10' };
export const tablerCopy = {
  path: 'M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666 M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1',
};
export const tablerWorld = {
  path: 'M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0 M3.6 9h16.8 M3.6 15h16.8 M11.5 3a17 17 0 0 0 0 18 M12.5 3a17 17 0 0 1 0 18',
};
export const tablerTrash = {
  path: 'M4 7l16 0 M10 11l0 6 M14 11l0 6 M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12 M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3',
};
export const tablerClock = {
  path: 'M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0 M12 7v5l3 3',
};
export const tablerCircle = { path: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0' };
export const tablerArrowUp = { path: 'M12 5l0 14 M18 11l-6 -6 M6 11l6 -6' };
export const tablerFileText = {
  path: 'M14 3v4a1 1 0 0 0 1 1h4 M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2 M9 9l1 0 M9 13l6 0 M9 17l6 0',
};
export const tablerArchive = {
  path: 'M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2 M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-10 M10 12l4 0',
};
export const tablerPlug = {
  path: 'M9.785 6l8.215 8.215l-2.054 2.054a5.81 5.81 0 1 1 -8.215 -8.215l2.054 -2.054 M4 20l3.5 -3.5 M15 4l-3.5 3.5 M20 9l-3.5 3.5',
};
export const tablerSettings = {
  path: 'M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065 M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0',
};
export const tablerSun = {
  path: 'M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7',
};
export const tablerChevronRight = { path: 'M9 6l6 6l-6 6' };
export const tablerCurrencyDollar = {
  path: 'M16.7 8a3 3 0 0 0 -2.7 -2h-4a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-4a3 3 0 0 1 -2.7 -2 M12 3v3m0 12v3',
};
// The app's "list view" toggle icon (app.tsx) draws this exact path but is
// not Tabler's own list.svg (which adds bullet-point dots this app's version
// never had) — it's really Tabler's menu-2.
export const tablerMenu2 = { path: 'M4 6l16 0 M4 12l16 0 M4 18l16 0' };
export const tablerLayoutGrid = {
  path: 'M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4 M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4 M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4 M14 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
};

// Filled variants (fill="currentColor", no stroke attributes) — source files
// live under @tabler/icons' icons/filled/ tree, not icons/outline/.
export const tablerPlayerPlayFilled = {
  path: 'M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z',
};
export const tablerCaretDownFilled = {
  path: 'M18 9c.852 0 1.297 .986 .783 1.623l-.076 .084l-6 6a1 1 0 0 1 -1.32 .083l-.094 -.083l-6 -6l-.083 -.094l-.054 -.077l-.054 -.096l-.017 -.036l-.027 -.067l-.032 -.108l-.01 -.053l-.01 -.06l-.004 -.057v-.118l.005 -.058l.009 -.06l.01 -.052l.032 -.108l.027 -.067l.07 -.132l.065 -.09l.073 -.081l.094 -.083l.077 -.054l.096 -.054l.036 -.017l.067 -.027l.108 -.032l.053 -.01l.06 -.01l.057 -.004l12.059 -.002z',
};
export const tablerDotsVerticalFilled = {
  path: 'M14 12a2 2 0 1 1 -4 0q 0 -.053 .005 -.102a1.996 1.996 0 0 1 1.995 -1.898a2 2 0 0 1 2 2 M14 19a2 2 0 1 1 -4 0q 0 -.052 .005 -.102a1.996 1.996 0 0 1 1.995 -1.898a2 2 0 0 1 2 2 M14 5a2 2 0 1 1 -4 0q 0 -.053 .005 -.102a1.996 1.996 0 0 1 1.995 -1.898a2 2 0 0 1 2 2',
};
export const tablerMoonFilled = {
  path: 'M12 1.992a10 10 0 1 0 9.236 13.838c.341 -.82 -.476 -1.644 -1.298 -1.31a6.5 6.5 0 0 1 -6.864 -10.787l.077 -.08c.551 -.63 .113 -1.653 -.758 -1.653h-.266l-.068 -.006l-.06 -.002z',
};
export const tablerPlayerStopFilled = {
  path: 'M17 4h-10a3 3 0 0 0 -3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3 -3v-10a3 3 0 0 0 -3 -3z',
};
export const tablerStack2 = {
  path: 'M12 4l-8 4l8 4l8 -4l-8 -4 M4 12l8 4l8 -4 M4 16l8 4l8 -4',
};
export const tablerHelpCircle = {
  path: 'M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0 M12 16v.01 M12 13a2 2 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483',
};
export const tablerAlertTriangle = {
  path: 'M12 9v4 M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0 M12 16h.01',
};
