import { resolve } from 'node:path';

export function caddyfileText(workspace) {
  return `{\n  auto_https off\n}\nimport ${workspace}/caddy.d/*.caddy\n`;
}

export function portalCaddyRoute(port, zone) {
  return `http://${zone} {\n  reverse_proxy localhost:${port}\n}\n`;
}

export function hasPortalCaddyRoute(text, port, zone) {
  return text === portalCaddyRoute(port, zone);
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
  const unwrapped = listingText.replace(/\n {5,}(?=\S)/g, ' ');
  return unwrapped.split('\n').some((line) => {
    const match = line.match(/NOPASSWD:\s*(.+)$/);
    if (!match) {
      return false;
    }
    return match[1]
      .split(/\s*,\s*/)
      .some((rule) => rule.trim() === command || rule.trim() === 'ALL');
  });
}

export function hasCodexServerTable(text) {
  return /^\[mcp_servers\.(?:setu|"setu")\]$/m.test(text);
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

// Agent CLIs (claude, codex, cursor-agent, ...) must run on their own
// subscription login, never a pay-per-use API key.
export const API_KEY_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'CURSOR_API_KEY',
];

// Env for every `claude` Setu spawns: subscription (OAuth) auth only. Drops
// API-key vars so a stray key can never bill the API, and the
// CLAUDE_CODE_* session vars a portal inherits when launched from inside a
// Claude Code session. CLAUDE_CODE_OAUTH_TOKEN (subscription) is kept.
const API_AUTH_VARS = new Set(API_KEY_VARS);
export function claudeSubscriptionEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([k]) =>
        !API_AUTH_VARS.has(k) &&
        (k === 'CLAUDE_CODE_OAUTH_TOKEN' || !k.startsWith('CLAUDE_CODE_'))
    )
  );
}
