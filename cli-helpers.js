import { resolve } from 'node:path';

const codexServerTablePattern = /^\[mcp_servers\.(?:setu|"setu")\]$/m;
const sudoRuleContinuationPattern = /\n {5,}(?=\S)/g;
const sudoRulePattern = /NOPASSWD:\s*(.+)$/;
const sudoRuleSeparatorPattern = /\s*,\s*/;

export function caddyfileText(workspace) {
  return `{\n  auto_https off\n}\nimport ${workspace}/caddy.d/*.caddy\n`;
}

export function portalCaddyRoute(port) {
  return `http://quivly.local {\n  reverse_proxy localhost:${port}\n}\n`;
}

export function hasPortalCaddyRoute(text, port) {
  return text === portalCaddyRoute(port);
}

// Replaces an existing Setu block. The caller appends when no start marker exists.
export function withSetuBlock(current, block, start, end) {
  const startAt = current.indexOf(start);
  const endAt = current.indexOf(end, startAt + start.length);
  if (endAt === -1) {
    return (
      current.slice(0, startAt) + block + current.slice(startAt + start.length)
    );
  }
  return current.slice(0, startAt) + block + current.slice(endAt + end.length);
}

export function pruneCandidates(entries, active, cwdOf, workspace) {
  const known = new Set();
  for (const entry of entries) {
    known.add(entry.port);
    known.add(entry.port + 5288);
  }
  const root = resolve(workspace);
  return active.filter((listener) => {
    if (known.has(listener.port)) {
      return false;
    }
    const cwd = cwdOf(listener.pid);
    if (!cwd) {
      return false;
    }
    const directory = resolve(cwd);
    return directory === root || directory.startsWith(`${root}/`);
  });
}

export function hasIdentifiableWorktreeCwd(cwd) {
  return !!cwd && resolve(cwd) !== '/';
}

export function sudoRuleCovers(listingText, argv) {
  const command = argv.join(' ');
  // A captured listing is wrapped at 80 columns; a rule's continuation lines
  // are indented deeper than the rule itself.
  const unwrapped = listingText.replace(sudoRuleContinuationPattern, ' ');
  return unwrapped.split('\n').some((line) => {
    const match = line.match(sudoRulePattern);
    if (!match) {
      return false;
    }
    return match[1]
      .split(sudoRuleSeparatorPattern)
      .some((rule) => rule.trim() === command || rule.trim() === 'ALL');
  });
}

export function hasCodexServerTable(text) {
  return codexServerTablePattern.test(text);
}

export function cursorConfigText(config, url) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Cursor MCP config must be a plain object');
  }
  const next = { ...config, mcpServers: { ...(config.mcpServers ?? {}) } };
  next.mcpServers.setu ??= { url };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function startOutcome(response) {
  if (response.ok && response.queued) {
    return {
      position: response.position,
      queued: true,
      reason: response.reason,
      started: false,
    };
  }
  return { queued: false, started: !!response.ok };
}
