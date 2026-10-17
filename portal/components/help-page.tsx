// Static help/guide content — no state, no fetches, only a back-navigation
// callback from the caller (the router itself stays in app.tsx).
import type { ComponentChildren } from 'preact';
import { Kbd, PageHeader, Section } from '../ui';
import { Button } from '../ui/button';

function HelpTopic({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: ComponentChildren;
}) {
  return (
    <div class="mb-5 last:mb-0">
      <h3
        class="section-anchor mb-1 font-semibold text-sm text-zinc-900 dark:text-zinc-100"
        id={id}
        tabIndex={id ? -1 : undefined}
      >
        {title}
      </h3>
      <div class="text-sm text-zinc-600 leading-relaxed dark:text-zinc-400">
        {children}
      </div>
    </div>
  );
}

export function HelpPage({ onBack }: { onBack: () => void }) {
  return (
    <div class="portal-page mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <PageHeader
        back={{ label: 'All worktrees', onClick: onBack }}
        title="Help & guide"
      />

      <Section title="Worktrees">
        <HelpTopic title="What's a worktree, here?">
          A separate checkout of one branch from a shared bare repo — its own
          directory, own dev server, own port and local domain (
          <span class="font-mono text-xs">*.setu.local</span>), so you can run
          several branches of the same project side by side without switching
          branches in one folder.
        </HelpTopic>
        <HelpTopic id="mode" title="Bare vs container mode">
          <strong>Bare</strong> runs the dev server as a plain process on your
          Mac — fast to start, no memory/CPU cap. <strong>Container</strong>{' '}
          runs it in Docker with a real memory/CPU ceiling, isolated from the
          host. A worktree's mode is <em>sticky</em>: whichever it last ran as,
          it keeps running as, until you explicitly force the other mode (the
          Run mode actions under More, or the migration prompt on a worktree's
          first Start after this feature shipped). This is deliberate — an
          earlier version silently switched an established worktree into a
          container on restart with nobody asking for it.
        </HelpTopic>
        <HelpTopic id="sync" title="Sync with base">
          Merges the worktree's resolved base branch (staging if the repo has
          one, otherwise its default branch) into the worktree's own branch.
          Only proceeds if the merge is clean — if it would conflict, Setu
          aborts automatically and tells you which files, rather than leaving
          the worktree half-merged. Resolve conflicts yourself in your editor,
          then try again.
        </HelpTopic>
      </Section>

      <Section title="Sidecars, ports & domains">
        <HelpTopic id="sidecar-approval" title="Sidecars and command approval">
          Anything a project needs alongside its dev server that isn't Inngest,
          trigger.dev, or a tunnel (which already have first-class controls) — a
          plain process Setu starts and stops with the worktree. Configure them
          per-project in Settings. Save changes first, then approve the exact
          saved command separately. Editing a command invalidates its approval;
          saving never grants approval.
        </HelpTopic>
        <HelpTopic title="Ports & local domains">
          Each registered project owns a 100-port band; each worktree gets one
          port from it plus a local domain that Caddy reverse-proxies to that
          port. See every process currently bound in 3000–3999 under Active
          ports.
        </HelpTopic>
      </Section>

      <Section title="Performance">
        <HelpTopic id="capacity" title="Concurrency cap">
          The max number of dev servers running at once — starting one more
          queues it instead of over-committing your Mac. Adjust it in Settings;
          the saved value and effective server capacity are shown separately
          when needed. Active work always includes running, starting, stopping
          and queued work across all projects. Search and filters apply only to
          stopped worktrees.
        </HelpTopic>
        <HelpTopic id="resources" title="Container limits">
          Memory/CPU ceiling for container-mode worktrees. A limit above what
          your Docker engine actually has allocated (visible in Settings) is
          bounded by the engine capacity when a new container starts. Existing
          running containers keep their current limits. Settings save when you
          leave a field or press Enter; invalid drafts remain editable.
        </HelpTopic>
      </Section>

      <Section title="Sharing and deployment">
        <HelpTopic id="tunnel" title="Public tunnel">
          A tunnel makes this worktree reachable outside your Mac. Enable it
          deliberately and check the public URL before sharing it. The local
          domain remains a separate address.
        </HelpTopic>
        <HelpTopic id="production" title="Production deployment">
          Review the exact provider project, environment and branch before
          confirming production deployment. If that target identity changes,
          refresh the confirmation. Confirmation does not freeze checkout
          contents, and provider approvals still apply.
        </HelpTopic>
      </Section>

      <Section title="Recovery and storage">
        <HelpTopic id="cleanup" title="Pending cleanup">
          A removed worktree can still have routing or other cleanup pending.
          The persistent Cleanup pending list includes every record, independent
          of filters. Retry cleanup resumes the exact recorded operation; it
          does not create or remove another worktree.
        </HelpTopic>
        <HelpTopic id="storage" title="Host filesystem and Docker storage">
          Host storage reports available space on the configured workspace
          filesystem, with an observation time. Setu warns below 20 GiB free.
          New disk-heavy work requires a fresh storage check and at least 10 GiB
          free; an unknown check also prevents that new work from starting. Stop
          and Remove remain available. The check does not reserve space or
          guarantee that a later write will succeed. Docker VM storage is a
          separate measurement and remains unknown here. ENOSPC describes the
          failed write; it does not prove that the container engine stopped
          because of disk space. Setu never deletes caches, fixtures or volumes
          to resolve this automatically.
        </HelpTopic>
      </Section>

      <Section title="Keyboard shortcuts">
        <HelpTopic id="raycast" title="Raycast settings">
          Raycast dev mode runs the local Setu extension watcher. Start and stop
          it from Settings, where its latest status and recent log remain
          visible. The workspace link opens those controls; it does not start a
          watcher automatically.
        </HelpTopic>
        <div class="flex items-center gap-3 text-sm">
          <Kbd>⌘K / Ctrl K</Kbd>
          <span class="text-zinc-600 dark:text-zinc-400">
            Jump to any registered worktree by name, repo, or branch. Bypasses
            filtering and pagination entirely.
          </span>
        </div>
      </Section>

      <Section title="Contributing">
        <p class="mb-3 text-sm text-zinc-600 leading-relaxed dark:text-zinc-400">
          Setu is open source. Issues, ideas, and pull requests are welcome.
        </p>
        <Button
          onClick={() =>
            window.open('https://github.com/mukulchugh/setu', '_blank')
          }
          variant="secondary"
        >
          Open github.com/mukulchugh/setu
        </Button>
      </Section>
    </div>
  );
}
