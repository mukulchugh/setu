import { expect, test } from 'bun:test';
import {
  caddyfileText,
  claudeSubscriptionEnv,
  codexMcpConfiguration,
  cursorConfigText,
  cursorMcpConfiguration,
  hasCodexServerTable,
  hasIdentifiableWorktreeCwd,
  hasPortalCaddyRoute,
  portalCaddyRoute,
  pruneCandidates,
  startOutcome,
  sudoRuleCovers,
  withSetuBlock,
} from './cli-helpers.js';

test('caddyfileText uses a valid multiline global options block', () => {
  expect(caddyfileText('/tmp/a workspace')).toBe(
    '{\n  auto_https off\n}\nimport /tmp/a workspace/caddy.d/*.caddy\n'
  );
});

test('portalCaddyRoute keeps setu.local on the portal port', () => {
  const route = portalCaddyRoute(2999, 'setu.local');
  expect(route).toBe(
    'http://setu.local {\n  reverse_proxy localhost:2999\n}\n'
  );
  expect(hasPortalCaddyRoute(route, 2999, 'setu.local')).toBe(true);
  expect(hasPortalCaddyRoute(route, 3000, 'setu.local')).toBe(false);
});

test('withSetuBlock preserves text after a start marker without an end marker', () => {
  expect(
    withSetuBlock(
      'before\n# setu start\nkeep this\n',
      'NEW',
      '# setu start',
      '# setu end'
    )
  ).toBe('before\nNEW\nkeep this\n');
});

test('pruneCandidates only returns workspace listeners outside registered dev and Inngest ports', () => {
  const active = [
    { pid: '1', port: 3001 },
    { pid: '2', port: 8289 },
    { pid: '3', port: 3306 },
    { pid: '4', port: 3002 },
  ];
  const cwd = new Map([
    ['1', '/work/repo/branch'],
    ['2', '/work/repo/branch'],
    ['3', '/'],
    ['4', '/work/other'],
  ]);
  expect(
    pruneCandidates([{ port: 3001 }], active, (pid) => cwd.get(pid), '/work')
  ).toEqual([active[3]]);
});

test('sudoRuleCovers requires a NOPASSWD rule for the exact command', () => {
  const command = ['/bin/cp', '/tmp/setu-hosts', '/etc/hosts'];
  expect(
    sudoRuleCovers(
      'User x may run the following commands:\n    (ALL) /bin/cp /tmp/setu-hosts /etc/hosts',
      command
    )
  ).toBe(false);
  expect(
    sudoRuleCovers(
      'User x may run the following commands:\n    (ALL) NOPASSWD: /bin/cp /tmp/setu-hosts /etc/hosts',
      command
    )
  ).toBe(true);
  expect(
    sudoRuleCovers(
      'User x may run the following commands:\n    (ALL) NOPASSWD: /bin/cp /tmp/other /etc/hosts',
      command
    )
  ).toBe(false);
});

test('hasCodexServerTable keeps its generic table-presence behavior', () => {
  expect(hasCodexServerTable('[mcp_servers."setu"]\nurl = "x"')).toBe(true);
});

test('Codex MCP identity parses standard and inline TOML tables', () => {
  const url = 'http://localhost:2999/mcp';
  expect(
    codexMcpConfiguration(
      `[mcp_servers."setu"]\nurl = "${url}" # exact endpoint`,
      url
    )
  ).toBe('configured');
  expect(
    codexMcpConfiguration(`mcp_servers = { setu = { url = "${url}" } }`, url)
  ).toBe('configured');
});

test('Codex MCP identity ignores comments and rejects conflicting transport, URL, or disabled state', () => {
  const url = 'http://localhost:2999/mcp';
  expect(
    codexMcpConfiguration(`# [mcp_servers.setu]\n# url = "${url}"`, url)
  ).toBe('absent');
  expect(
    codexMcpConfiguration(
      '[mcp_servers.setu]\nurl = "http://127.0.0.1:2999/mcp"',
      url
    )
  ).toBe('conflict');
  expect(
    codexMcpConfiguration(
      `[mcp_servers.setu]\nurl = "${url}"\ncommand = "setu"`,
      url
    )
  ).toBe('conflict');
  expect(
    codexMcpConfiguration(
      `[mcp_servers.setu]\nurl = "${url}"\nenabled = false`,
      url
    )
  ).toBe('conflict');
});

test('Codex MCP identity rejects duplicate Setu tables but ignores table-like text in strings', () => {
  const url = 'http://localhost:2999/mcp';
  expect(
    codexMcpConfiguration(
      `[mcp_servers.setu]\nurl = "${url}"\n[mcp_servers."setu"]`,
      url
    )
  ).toBe('invalid');
  expect(
    codexMcpConfiguration(
      `note = """\n[mcp_servers.setu]\n"""\n[mcp_servers.setu]\nurl = "${url}"`,
      url
    )
  ).toBe('configured');
});

test('Codex MCP identity reports malformed TOML and malformed target tables as invalid', () => {
  const url = 'http://localhost:2999/mcp';
  expect(codexMcpConfiguration('mcp_servers = =', url)).toBe('invalid');
  expect(
    codexMcpConfiguration(
      `[mcp_servers.setu]\nurl = "${url}"\nurl = "http://wrong/mcp"`,
      url
    )
  ).toBe('invalid');
  expect(codexMcpConfiguration('mcp_servers = 1', url)).toBe('invalid');
  expect(codexMcpConfiguration('mcp_servers.setu = "not a table"', url)).toBe(
    'invalid'
  );
  expect(
    codexMcpConfiguration('[mcp_servers.setu]\nenabled = "false"', url)
  ).toBe('invalid');
});

test('Cursor MCP identity requires plain objects and an exact enabled HTTP entry', () => {
  const url = 'http://localhost:2999/mcp';
  expect(cursorMcpConfiguration({}, url)).toBe('absent');
  expect(cursorMcpConfiguration({ mcpServers: {} }, url)).toBe('absent');
  expect(cursorMcpConfiguration({ mcpServers: { setu: { url } } }, url)).toBe(
    'configured'
  );
  expect(
    cursorMcpConfiguration(
      { mcpServers: { setu: { url: 'http://wrong/mcp' } } },
      url
    )
  ).toBe('conflict');
  expect(
    cursorMcpConfiguration(
      { mcpServers: { setu: { command: 'setu', type: 'stdio', url } } },
      url
    )
  ).toBe('conflict');
  expect(
    cursorMcpConfiguration(
      { mcpServers: { setu: { enabled: false, url } } },
      url
    )
  ).toBe('conflict');
  expect(
    cursorMcpConfiguration(
      { mcpServers: { setu: { disabled: true, url } } },
      url
    )
  ).toBe('conflict');
});

test('Cursor MCP identity rejects malformed root, collection, and entry values', () => {
  const url = 'http://localhost:2999/mcp';
  expect(cursorMcpConfiguration(null, url)).toBe('invalid');
  expect(cursorMcpConfiguration([], url)).toBe('invalid');
  expect(cursorMcpConfiguration({ mcpServers: null }, url)).toBe('invalid');
  expect(cursorMcpConfiguration({ mcpServers: [] }, url)).toBe('invalid');
  expect(cursorMcpConfiguration({ mcpServers: 'invalid' }, url)).toBe(
    'invalid'
  );
  expect(cursorMcpConfiguration({ mcpServers: { setu: null } }, url)).toBe(
    'invalid'
  );
  expect(
    cursorMcpConfiguration({ mcpServers: { setu: { url: 2999 } } }, url)
  ).toBe('invalid');
  expect(
    cursorMcpConfiguration(
      Object.assign(Object.create({ mcpServers: {} }), { other: true }),
      url
    )
  ).toBe('invalid');
});

test('cursorConfigText preserves unrelated own entries, adds Setu once, and refuses conflicts', () => {
  const url = 'http://localhost:2999/mcp';
  const config = {
    mcpServers: { unrelated: { command: 'other-server' } },
    other: { keep: true },
  };
  const output = cursorConfigText(config, url);
  const parsed = JSON.parse(output);
  expect(parsed).toEqual({
    mcpServers: {
      setu: { url },
      unrelated: { command: 'other-server' },
    },
    other: { keep: true },
  });
  expect(config.mcpServers).toEqual({ unrelated: { command: 'other-server' } });
  expect(cursorConfigText(parsed, url)).toBe(
    `${JSON.stringify(parsed, null, 2)}\n`
  );
  expect(() => cursorConfigText({ mcpServers: [] }, url)).toThrow(
    'Cursor MCP config is invalid'
  );
  expect(() =>
    cursorConfigText({ mcpServers: { setu: { url: 'http://wrong/mcp' } } }, url)
  ).toThrow('Cursor Setu MCP entry conflicts');
});

test('cursorConfigText preserves an unrelated own __proto__ key', () => {
  const config = JSON.parse('{"mcpServers":{},"__proto__":{"own":true}}');
  const parsed = JSON.parse(
    cursorConfigText(config, 'http://localhost:2999/mcp')
  );
  expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
  expect(Object.getOwnPropertyDescriptor(parsed, '__proto__').value).toEqual({
    own: true,
  });
});

test('startOutcome distinguishes queued starts from actual starts', () => {
  expect(
    startOutcome({ ok: true, position: 2, queued: true, reason: 'concurrency' })
  ).toEqual({
    position: 2,
    queued: true,
    reason: 'concurrency',
    started: false,
  });
  expect(startOutcome({ ok: true })).toEqual({ queued: false, started: true });
});

test('the container port-forwarding helper cwd cannot identify a worktree', () => {
  expect(hasIdentifiableWorktreeCwd('/')).toBe(false);
  expect(hasIdentifiableWorktreeCwd('/work/repo/branch')).toBe(true);
});

test('sudoRuleCovers reads a full sudo listing, not a single-command answer', () => {
  const listing = [
    'User x may run the following commands on host:',
    '    (ALL) ALL',
    '    (ALL) NOPASSWD: /opt/homebrew/bin/caddy reload --config /Users/x/workspace/Caddyfile',
    '    (ALL) NOPASSWD: /bin/cp /tmp/setu-hosts /etc/hosts',
  ].join('\n');
  const caddy = [
    '/opt/homebrew/bin/caddy',
    'reload',
    '--config',
    '/Users/x/workspace/Caddyfile',
  ];
  const cp = ['/bin/cp', '/tmp/setu-hosts', '/etc/hosts'];
  expect(sudoRuleCovers(listing, caddy)).toBe(true);
  expect(sudoRuleCovers(listing, cp)).toBe(true);
  expect(sudoRuleCovers('    (ALL) ALL', cp)).toBe(false);
  // What `sudo -l <command>` prints: the command alone, with no tag.
  expect(sudoRuleCovers('/bin/cp /tmp/setu-hosts /etc/hosts', cp)).toBe(false);
});

test('withSetuBlock replaces a complete block and keeps the text around it', () => {
  expect(
    withSetuBlock(
      'a\n# setu start\nold\n# setu end\nz\n',
      'NEW',
      '# setu start',
      '# setu end'
    )
  ).toBe('a\nNEW\nz\n');
});

test('sudoRuleCovers joins a rule that sudo wrapped onto a second line', () => {
  const listing = [
    'User x may run the following commands on host:',
    '    (ALL) ALL',
    '    (ALL) NOPASSWD: /opt/homebrew/bin/caddy reload --config',
    '        /Users/x/workspace/Caddyfile',
    '    (ALL) NOPASSWD: /bin/cp /tmp/setu-hosts /etc/hosts',
  ].join('\n');
  expect(
    sudoRuleCovers(listing, [
      '/opt/homebrew/bin/caddy',
      'reload',
      '--config',
      '/Users/x/workspace/Caddyfile',
    ])
  ).toBe(true);
  expect(
    sudoRuleCovers(listing, [
      '/opt/homebrew/bin/caddy',
      'reload',
      '--config',
      '/Users/x/other/Caddyfile',
    ])
  ).toBe(false);
});

test('claudeSubscriptionEnv strips API auth and session vars, keeps OAuth token', () => {
  const env = claudeSubscriptionEnv({
    ANTHROPIC_API_KEY: 'k',
    ANTHROPIC_AUTH_TOKEN: 't',
    CLAUDE_CODE_OAUTH_TOKEN: 'o',
    CLAUDE_CODE_SESSION_ID: 's',
    PATH: '/bin',
  });
  expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'o', PATH: '/bin' });
});
