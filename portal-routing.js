export function createPortalRouting({
  hostsEnd,
  hostsPath = '/etc/hosts',
  hostsStart,
  localDomain,
  portalHost,
  readFile,
  reloadCaddy,
  run,
  stagingPath,
  state,
  writeCaddy,
}) {
  async function syncHosts() {
    return state.withRouting(async () => {
      const raw = await readFile(hostsPath, 'utf8');
      const cleaned = raw.replace(
        new RegExp(`\\n?${hostsStart}[\\s\\S]*?${hostsEnd}\\n?`),
        ''
      );
      const { ports } = await state.snapshot(['ports']);
      const entries = [
        ...(portalHost ? [`127.0.0.1\t${portalHost}`] : []),
        ...ports.map(
          ({ repo, name }) => `127.0.0.1\t${localDomain(repo, name)}`
        ),
      ];
      const next =
        cleaned.trimEnd() +
        `\n${hostsStart}\n` +
        entries.join('\n') +
        `\n${hostsEnd}\n`;
      await state.replaceText(stagingPath, next);
      try {
        const proc = run(['sudo', '-n', '/bin/cp', stagingPath, hostsPath], {
          stderr: 'ignore',
          stdin: 'ignore',
          stdout: 'ignore',
          timeout: 5000,
        });
        return (await proc.exited) === 0;
      } catch {
        return false;
      }
    });
  }

  async function writeAdoptionRouting(repo, name, port) {
    await writeCaddy(repo, name, port);
    if (!(await syncHosts())) {
      return {
        code: 'ADOPTION_HOSTS_PENDING',
        error: 'Hosts routing could not be applied',
        ok: false,
      };
    }
    if (!(await reloadCaddy())) {
      return {
        code: 'ADOPTION_CADDY_PENDING',
        error: 'Caddy routing could not be reloaded',
        ok: false,
      };
    }
    return { ok: true };
  }

  function withRouting(task) {
    return state.withRouting(task);
  }

  return { syncHosts, withRouting, writeAdoptionRouting };
}
