import { test, expect } from 'bun:test';
import {
  caddyfileText,
  cursorConfigText,
  hasIdentifiableWorktreeCwd,
  hasCodexServerTable,
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

test('Codex quoted MCP tables are recognized and Cursor config must be an object', () => {
  expect(hasCodexServerTable('[mcp_servers."setu"]\nurl = "x"')).toBe(true);
  expect(() => cursorConfigText([], 'http://localhost:2999/mcp')).toThrow(
    'plain object'
  );
  expect(
    cursorConfigText({ mcpServers: {} }, 'http://localhost:2999/mcp')
  ).toContain('"setu"');
});

test('startOutcome distinguishes queued starts from actual starts', () => {
  expect(
    startOutcome({ ok: true, queued: true, position: 2, reason: 'concurrency' })
  ).toEqual({
    started: false,
    queued: true,
    position: 2,
    reason: 'concurrency',
  });
  expect(startOutcome({ ok: true })).toEqual({ started: true, queued: false });
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
