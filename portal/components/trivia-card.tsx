// Sidebar trivia card — self-contained: owns its own rotation timer, takes
// no props, zero coupling to App's state.
import { useState, useEffect } from 'preact/hooks';

// Real, specific facts about what setu does, not filler copy — each one
// traces back to an actual mechanism in lib.js/portal.js/cli.js. Refreshed
// periodically as real features land, not written once and left stale —
// the weakest, most generic entries from the first pass (self-referential
// "the help page has docs", thin UI-polish notes) got cut in favor of
// facts that actually say something about how the tool works.
const SETU_FACTS = [
  'Projects live as one bare repo plus lightweight worktrees, so every branch shares history instead of a full clone.',
  'Every worktree gets its own *.quivly.local subdomain, wired up by Caddy and dnsmasq automatically.',
  'Port bands are handed out in blocks of 100 starting at 3000, one block per project.',
  "Sync with staging only ever does a clean merge. If it can't merge cleanly, it aborts and leaves your branch exactly as it was.",
  "Container mode works with any Docker daemon, OrbStack included. It's engine agnostic by design.",
  "In container mode, node_modules lives in its own Docker volume, not a bind mount — so a native macOS binary in it never has to run inside the Linux container.",
  "Concurrency limits auto clamp to your machine's real CPU and memory, not a hardcoded number.",
  'Sidecars are defined per project in sidecars.json, so each repo can run its own supporting processes.',
  "A sidecar's command has to be explicitly approved before it's allowed to run. Edit it later, even by one character, and that approval is revoked automatically.",
  'The web UI, the CLI, the Raycast extension, and the MCP server are four different doors onto the exact same portal API. None of them duplicate a line of business logic.',
  'Setu runs its own MCP server, so an agent in Claude Code, Codex, or Cursor can create, start, stop, and sync worktrees directly — no browser required.',
  'Cloudflare tunnels are optional per worktree, for sharing a branch outside your machine.',
  'Every registered repo gets its own overview page — worktrees, open PRs, and sidecar config in one place, one URL you can bookmark or share.',
  "Killing a process from the Ports page asks you to confirm first. It's the one action there that can't be undone.",
  'The split flap status text only animates on a real state change, never idles for effect.',
  'The bridge glyph in the logo is the same icon used for the Raycast extension and the browser favicon.',
  'Custom CLI agents get collision safe kebab case ids, so two agents named the same thing never overwrite each other.',
  'The ports page gives every active process on your machine its own dedicated view.',
  'Dark mode is a real second theme, not just an inverted filter.',
  'Removing a worktree never deletes its branch. The branch stays in git history.',
  'Setu was built to answer one question: which of my branches actually has a server running right now.',
];

// Horizontal card stack — two static "peeking" cards behind, offset to the
// right and rotated, so it reads as a deck rather than one flat panel. The
// front card is the only one in normal flow, so the stack's height always
// matches its actual text length instead of clipping longer facts. Auto
// rotation picks a fresh random fact every 45s; the ‹ › controls step
// sequentially through the deck instead, so a manual click feels like
// browsing the stack rather than re-rolling it.
export function TriviaCard() {
  const [i, setI] = useState(() => Math.floor(Math.random() * SETU_FACTS.length));
  useEffect(() => {
    const t = setInterval(() => {
      setI(prev => {
        let next = Math.floor(Math.random() * SETU_FACTS.length);
        while (next === prev) next = Math.floor(Math.random() * SETU_FACTS.length);
        return next;
      });
    }, 45000);
    return () => clearInterval(t);
  }, []);
  const step = (dir: 1 | -1) => setI(prev => (prev + dir + SETU_FACTS.length) % SETU_FACTS.length);
  return (
    <div class="relative">
      <div class="absolute inset-0 translate-x-2.5 translate-y-1 rotate-2 bg-white/40 dark:bg-white/5 border border-white/60 dark:border-white/10 shadow-md rounded-none" />
      <div class="absolute inset-0 translate-x-1 translate-y-0.5 rotate-1 bg-white/55 dark:bg-white/8 border border-white/70 dark:border-white/10 shadow-md rounded-none" />
      <div key={i} class="relative flex flex-col gap-2 backdrop-blur-md bg-white/75 dark:bg-white/10 border border-white/80 dark:border-white/10 shadow-lg rounded-none p-3 animate-[factIn_0.4s_ease-out]">
        <div class="flex items-center justify-between gap-2">
          <span class="board-mono text-[9px] font-bold text-zinc-400 shrink-0">SETU TRIVIA</span>
          <div class="flex items-center gap-1 shrink-0">
            <button onClick={() => step(-1)} data-tip="Previous fact"
              class="tip w-5 h-5 flex items-center justify-center rounded-none text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors duration-150">‹</button>
            <button onClick={() => step(1)} data-tip="Next fact"
              class="tip w-5 h-5 flex items-center justify-center rounded-none text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors duration-150">›</button>
          </div>
        </div>
        <p class="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">{SETU_FACTS[i]}</p>
      </div>
    </div>
  );
}
