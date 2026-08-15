// Static help/guide content — no state, no fetches, only a back-navigation
// callback from the caller (the router itself stays in app.tsx).
import { PageHeader, Section, Kbd } from '../ui';
import { Button } from '../ui/button';

function HelpTopic({ title, children }: { title: string; children: any }) {
  return (
    <div class="mb-5 last:mb-0">
      <h3 class="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-1">{title}</h3>
      <div class="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">{children}</div>
    </div>
  );
}

export function HelpPage({ onBack }: { onBack: () => void }) {
  return (
    <div class="max-w-3xl mx-auto px-6 py-12">
      <PageHeader back={{ label: 'All worktrees', onClick: onBack }} title="Help & guide" />

      <Section title="Worktrees">
        <HelpTopic title="What's a worktree, here?">
          A separate checkout of one branch from a shared bare repo — its own directory, own dev server, own port and local domain (<span class="font-mono text-xs">*.quivly.local</span>), so you can run several branches of the same project side by side without switching branches in one folder.
        </HelpTopic>
        <HelpTopic title="Bare vs container mode">
          <strong>Bare</strong> runs the dev server as a plain process on your Mac — fast to start, no memory/CPU cap. <strong>Container</strong> runs it in Docker with a real memory/CPU ceiling, isolated from the host. A worktree's mode is <em>sticky</em>: whichever it last ran as, it keeps running as, until you explicitly force the other mode (the caret next to Start, or the migration prompt on a worktree's first Start after this feature shipped). This is deliberate — an earlier version silently switched an established worktree into a container on restart with nobody asking for it.
        </HelpTopic>
        <HelpTopic title="Sync with staging">
          Merges the worktree's resolved base branch (staging if the repo has one, otherwise its default branch) into the worktree's own branch. Only proceeds if the merge is clean — if it would conflict, Setu aborts automatically and tells you which files, rather than leaving the worktree half-merged. Resolve conflicts yourself in your editor, then try again.
        </HelpTopic>
      </Section>

      <Section title="Sidecars, ports & domains">
        <HelpTopic title="Sidecars">
          Anything a project needs alongside its dev server that isn't Inngest, trigger.dev, or a tunnel (which already have first-class controls) — a plain process Setu starts and stops with the worktree. Configure them per-project in Settings.
        </HelpTopic>
        <HelpTopic title="Ports & local domains">
          Each registered project owns a 100-port band; each worktree gets one port from it plus a local domain that Caddy reverse-proxies to that port. See every process currently bound in 3000–3999 under Active ports.
        </HelpTopic>
      </Section>

      <Section title="Performance">
        <HelpTopic title="Concurrency cap">
          The max number of dev servers running at once — starting one more queues it instead of over-committing your Mac. Adjust it in Settings; it's clamped to what's actually reasonable for your hardware, not an arbitrary number.
        </HelpTopic>
        <HelpTopic title="Container limits">
          Memory/CPU ceiling for container-mode worktrees. A limit above what your Docker engine actually has allocated (visible in Settings) gets silently clamped when the container starts — Docker itself refuses higher.
        </HelpTopic>
      </Section>

      <Section title="Keyboard shortcuts">
        <div class="flex items-center gap-3 text-sm">
          <Kbd>⌘K</Kbd>
          <span class="text-zinc-600 dark:text-zinc-400">Jump to any registered worktree by name, repo, or branch. Bypasses filtering and pagination entirely.</span>
        </div>
      </Section>

      <Section title="Contributing">
        <p class="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed mb-3">
          Setu is open source. Issues, ideas, and pull requests are welcome.
        </p>
        <Button variant="secondary" onClick={() => window.open('https://github.com/quivly/setu', '_blank')}>Open github.com/quivly/setu</Button>
      </Section>
    </div>
  );
}
