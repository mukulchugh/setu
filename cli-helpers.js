import { resolve } from 'node:path';

const codexServerTablePattern = /^\[mcp_servers\.(?:setu|"setu")\]$/m;
const codexSetuTableHeaderPattern =
  /^\s*\[(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:setu|"setu"|'setu')\s*\]\s*(?:#.*)?$/;
const lineBreakPattern = /\r?\n/;
const sudoRuleContinuationPattern = /\n {5,}(?=\S)/g;
const sudoRulePattern = /NOPASSWD:\s*(.+)$/;
const sudoRuleSeparatorPattern = /\s*,\s*/;

// The default grace period is eternal: one long-lived dev request keeps the
// old config alive, so every later reload (and Setu's 5s reload) hangs.
export function caddyfileText(workspace) {
  return `{\n  auto_https off\n  grace_period 3s\n}\nimport ${workspace}/caddy.d/*.caddy\n`;
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

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownEntryValue(entry, key) {
  return Object.hasOwn(entry, key) ? entry[key] : undefined;
}

function hasWrongFieldType(entry, key, type) {
  return Object.hasOwn(entry, key) && typeof entry[key] !== type;
}

function hasInvalidEntryFields(entry, cursor) {
  return (
    hasWrongFieldType(entry, 'enabled', 'boolean') ||
    (cursor && hasWrongFieldType(entry, 'disabled', 'boolean')) ||
    hasWrongFieldType(entry, 'command', 'string') ||
    hasWrongFieldType(entry, 'type', 'string')
  );
}

function isDisabledEntry(entry, cursor) {
  return (
    ownEntryValue(entry, 'enabled') === false ||
    (cursor && ownEntryValue(entry, 'disabled') === true)
  );
}

function entryConfiguration(entry, url, { cursor = false } = {}) {
  if (!isPlainObject(entry) || hasInvalidEntryFields(entry, cursor)) {
    return 'invalid';
  }

  if (isDisabledEntry(entry, cursor)) {
    return 'conflict';
  }

  const hasCommand = Object.hasOwn(entry, 'command');
  const hasType = Object.hasOwn(entry, 'type');
  if (hasCommand || ownEntryValue(entry, 'type') === 'stdio') {
    return 'conflict';
  }
  if (hasType) {
    return 'invalid';
  }

  const entryUrl = ownEntryValue(entry, 'url');
  if (typeof entryUrl !== 'string') {
    return 'invalid';
  }
  return entryUrl === url ? 'configured' : 'conflict';
}

function mcpServersConfiguration(servers, url, options) {
  if (!isPlainObject(servers)) {
    return 'invalid';
  }
  if (!Object.hasOwn(servers, 'setu')) {
    return 'absent';
  }
  return entryConfiguration(servers.setu, url, options);
}

function findMultilineStringEnd(line, start, delimiter, escaped) {
  for (let index = start; index <= line.length - delimiter.length; index += 1) {
    if (!line.startsWith(delimiter, index)) {
      continue;
    }
    if (escaped) {
      let backslashes = 0;
      for (
        let before = index - 1;
        before >= 0 && line[before] === '\\';
        before -= 1
      ) {
        backslashes += 1;
      }
      if (backslashes % 2 === 1) {
        continue;
      }
    }
    return index + delimiter.length;
  }
  return -1;
}

function skipSingleLineString(line, start, quote) {
  let index = start + 1;
  while (index < line.length) {
    if (quote === '"' && line[index] === '\\') {
      index += 2;
    } else if (line[index] === quote) {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return line.length;
}

function findOpenMultilineString(line, start) {
  let index = start;
  while (index < line.length) {
    if (line[index] === '#') {
      return null;
    }

    const quote = line[index];
    if (quote !== '"' && quote !== "'") {
      index += 1;
      continue;
    }

    const delimiter = quote.repeat(3);
    if (line.startsWith(delimiter, index)) {
      const end = findMultilineStringEnd(
        line,
        index + delimiter.length,
        delimiter,
        quote === '"'
      );
      if (end === -1) {
        return quote === '"' ? 'basic' : 'literal';
      }
      index = end;
    } else {
      index = skipSingleLineString(line, index, quote);
    }
  }
  return null;
}

function multilineStringStateAfterLine(line, state) {
  let start = 0;
  if (state) {
    const delimiter = state === 'basic' ? '"""' : "'''";
    start = findMultilineStringEnd(line, 0, delimiter, state === 'basic');
    if (start === -1) {
      return state;
    }
  }
  return findOpenMultilineString(line, start);
}

function hasDuplicateCodexSetuTable(text) {
  let multilineState = null;
  let targetTableCount = 0;
  for (const line of text.split(lineBreakPattern)) {
    if (!multilineState && codexSetuTableHeaderPattern.test(line)) {
      targetTableCount += 1;
      if (targetTableCount > 1) {
        return true;
      }
    }
    multilineState = multilineStringStateAfterLine(line, multilineState);
  }
  return false;
}

// A full TOML parse is needed here: comments, quoted keys, inline tables and
// duplicate-key syntax all affect whether a Setu entry really exists.
export function codexMcpConfiguration(text, url) {
  if (typeof text !== 'string' || typeof url !== 'string' || !url) {
    return 'invalid';
  }
  try {
    // Bun 1.3.x accepts a repeated explicit table header; TOML forbids it.
    // This header-only guard ignores comments and multiline string contents;
    // Bun parses all actual TOML syntax and supplies the identity value.
    if (hasDuplicateCodexSetuTable(text)) {
      return 'invalid';
    }

    const config = Bun.TOML.parse(text);
    if (!isPlainObject(config)) {
      return 'invalid';
    }
    if (!Object.hasOwn(config, 'mcp_servers')) {
      return 'absent';
    }
    return mcpServersConfiguration(config.mcp_servers, url);
  } catch {
    // Keep parser diagnostics and config contents out of callers' output.
    return 'invalid';
  }
}

export function cursorMcpConfiguration(config, url) {
  if (!isPlainObject(config) || typeof url !== 'string' || !url) {
    return 'invalid';
  }
  if (!Object.hasOwn(config, 'mcpServers')) {
    return 'absent';
  }
  return mcpServersConfiguration(config.mcpServers, url, { cursor: true });
}

export function cursorConfigText(config, url) {
  const configuration = cursorMcpConfiguration(config, url);
  if (configuration === 'invalid') {
    throw new Error('Cursor MCP config is invalid');
  }
  if (configuration === 'conflict') {
    throw new Error('Cursor Setu MCP entry conflicts with the expected server');
  }
  const currentServers = Object.hasOwn(config, 'mcpServers')
    ? config.mcpServers
    : {};
  const next = { ...config, mcpServers: { ...currentServers } };
  if (configuration === 'absent') {
    next.mcpServers.setu = { url };
  }
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
