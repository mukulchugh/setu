// Active-ports view — self-contained: owns its own polling loop and kill
// action, only needs a back-navigation callback from the caller (the router
// itself stays in app.tsx).
import { useState, useEffect, useCallback } from 'preact/hooks';
import { PageHeader } from '../ui';
import { post } from '../api';

type PortInfo = { port: number; pid: string; cmd: string; worktree: string | null };

export function PortsPage({ onBack }: { onBack: () => void }) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setPorts(await fetch('/api/ports').then(r => r.json()).catch(() => []));
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  async function kill(port: number) {
    await post('/api/ports/kill', { port });
    load();
  }

  return (
    <div class="max-w-3xl mx-auto px-6 py-12">
      <PageHeader back={{ label: 'All worktrees', onClick: onBack }} title="Active ports"
        subtitle={<span class="text-xs text-zinc-400">Every process bound in 3000–3999, worktree-registered or not</span>} />

      <div class="backdrop-blur-md bg-white/70 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm rounded-none overflow-hidden text-sm">
        {!loaded
          ? <p class="text-zinc-400 px-4 py-6 text-center">Loading…</p>
          : !ports.length
          ? <p class="text-zinc-400 px-4 py-6 text-center">No processes on ports 3000–3999</p>
          : ports.map(p => (
            <div key={p.port} class="flex items-center gap-4 px-4 py-3 border-b border-zinc-100 dark:border-white/5 last:border-0 hover:bg-white/50 dark:hover:bg-white/5 transition-colors duration-150">
              <span class="font-mono font-medium text-zinc-900 dark:text-zinc-100 w-14">{p.port}</span>
              <span class="text-zinc-400 w-20">PID {p.pid}</span>
              <span class="text-zinc-500 dark:text-zinc-400 flex-1 truncate">{p.cmd}{p.worktree && <span class="text-zinc-400"> · {p.worktree}</span>}</span>
              <button onClick={() => kill(p.port)}
                class="text-red-500 hover:text-white hover:bg-red-500 transition-colors duration-150 px-3 py-1.5 rounded-none font-medium border border-red-200 dark:border-red-900">Kill</button>
            </div>
          ))}
      </div>
    </div>
  );
}
