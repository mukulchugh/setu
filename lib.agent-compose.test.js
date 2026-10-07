// lib.agent-compose.test.js — `bun lib.agent-compose.test.js`. No framework.
//
// Covers writeAgentCompose's required divergences from writeDockerCompose: the
// bare-repo git mount (read-write, identical host path — the part that's
// fatal to get wrong, see lib.js's comment above writeAgentCompose), forced
// read-only credential mounts, restart:"no" instead of on-failure:3, the
// agent/dev-server project-name split, and engine-capacity clamping. Also
// parses the emitted YAML structurally to catch a duplicate mapping key —
// the exact class of bug that previously broke writeDockerCompose's PORT env
// var and makes Docker reject the whole file outright.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentComposePath,
  composeProjectName,
  writeAgentCompose as writeProductionAgentCompose,
} from './lib.js';

const engineCapacity = () => ({ cpus: 4, memMb: 8192 });
const writeAgentCompose = (c, repo, name, opts) =>
  writeProductionAgentCompose(c, repo, name, opts, engineCapacity());

const CPUS_LINE_RE = /cpus: "([^"]+)"/;
const MEM_LIMIT_LINE_RE = /mem_limit: "([^"]+)"/;

const failures = [];
async function check(what, fn) {
  try {
    await fn();
    console.log(`  ok   ${what}`);
  } catch (e) {
    failures.push(what);
    console.log(`  FAIL ${what}\n       ${e.message}`);
  }
}

// Fresh fake workspace per call — writeAgentCompose writes into
// `<workspace>/<repo>/<name>/`, which has to exist on disk first (mirrors how
// createWorktree already leaves it by the time either compose writer runs).
function fakeWorktree(repo = 'repo', name = 'feat-x') {
  const workspace = mkdtempSync(join(tmpdir(), 'setu-agent-compose-'));
  const wtDir = join(workspace, repo, name);
  mkdirSync(wtDir, { recursive: true });
  return { c: { workspace }, name, repo, workspace, wtDir };
}

// Splits the emitted YAML into indentation-scoped mapping blocks (a stack of
// {indent, seen} frames, one per nesting level) and asserts no key repeats
// within the same block. List items (`      - host:container:ro`) are
// skipped — a bind-mount spec containing colons is not a mapping key, and
// treating it as one would false-positive on every volume line.
const LEADING_WS_RE = /^\s*/;
const KEY_LINE_RE = /^(\s*)([A-Za-z0-9_.-]+):/;

function assertNoDuplicateMappingKeys(yamlText) {
  const stack = [];
  for (const raw of yamlText.split('\n')) {
    const trimmed = raw.replace(LEADING_WS_RE, '');
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) {
      continue;
    }
    const m = raw.match(KEY_LINE_RE);
    if (!m) {
      continue;
    }
    const [, indentStr, key] = m;
    const indent = indentStr.length;
    while (stack.length && stack.at(-1).indent > indent) {
      stack.pop();
    }
    if (!stack.length || stack.at(-1).indent < indent) {
      stack.push({ indent, seen: new Set() });
    }
    const top = stack.at(-1);
    assert.ok(
      !top.seen.has(key),
      `duplicate key "${key}" at indent ${indent} in:\n${yamlText}`
    );
    top.seen.add(key);
  }
}

// ── node_modules isolation ───────────────────────────────────────────────────
// These exist because the volume was dropped once, on the reasonable-sounding
// grounds that the agent container "idles on sleep infinity and never runs
// bun install". The container idles; the agent doesn't. Anything that removes
// these mounts again should fail loudly here first.

await check(
  'node_modules is a container-local named volume, not the host dir',
  async () => {
    const { c, repo, name, workspace } = fakeWorktree();
    const yaml = readFileSync(
      await writeAgentCompose(c, repo, name, {}),
      'utf8'
    );
    // The worktree is bind-mounted rw, so without this shadow mount a
    // `bun install` inside the Linux container writes linux-native binaries
    // straight into the host's node_modules and breaks the macOS dev server
    // running against that same worktree.
    assert.ok(
      yaml.includes('- node_modules:/workspace/node_modules'),
      `node_modules volume missing — host node_modules is exposed:\n${yaml}`
    );
    // A named volume is only valid if it is also declared at the top level.
    assert.match(yaml, /^volumes:\n {2}node_modules:/m, yaml);
    rmSync(workspace, { force: true, recursive: true });
  }
);

await check(
  'the shared bun cache is mounted and actually pointed at',
  async () => {
    const { c, repo, name, workspace } = fakeWorktree();
    const yaml = readFileSync(
      await writeAgentCompose(c, repo, name, {}),
      'utf8'
    );
    assert.ok(yaml.includes(':/bun-cache'), yaml);
    // Mounting the cache without telling bun where it is leaves it inert, and
    // every agent run pays a full cold download.
    assert.ok(yaml.includes('BUN_INSTALL_CACHE_DIR: "/bun-cache"'), yaml);
    rmSync(workspace, { force: true, recursive: true });
  }
);

await check(
  'an explicit env value still beats the seeded cache dir',
  async () => {
    const { c, repo, name, workspace } = fakeWorktree();
    const yaml = readFileSync(
      await writeAgentCompose(c, repo, name, {
        env: { BUN_INSTALL_CACHE_DIR: '/custom' },
      }),
      'utf8'
    );
    assert.ok(yaml.includes('BUN_INSTALL_CACHE_DIR: "/custom"'), yaml);
    assert.ok(!yaml.includes('BUN_INSTALL_CACHE_DIR: "/bun-cache"'), yaml);
    rmSync(workspace, { force: true, recursive: true });
  }
);

console.log('writeAgentCompose — git mounts');

await check(
  'bare repo is mounted read-write at its identical host path',
  async () => {
    const { c, repo, name, wtDir, workspace } = fakeWorktree();
    const path = await writeAgentCompose(c, repo, name, {});
    assert.equal(path, agentComposePath(wtDir));
    const yaml = readFileSync(path, 'utf8');
    const bareRepoDir = `${workspace}/${repo}.git`;
    const line = yaml.split('\n').find((l) => l.includes(`- ${bareRepoDir}:`));
    assert.ok(line, `no bare-repo mount line found in:\n${yaml}`);
    assert.equal(
      line.trim(),
      `- ${bareRepoDir}:${bareRepoDir}`,
      'host and container paths for the bare repo mount must be identical'
    );
    assert.ok(
      !line.endsWith(':ro'),
      `bare repo mount must be read-write, got: ${line}`
    );
    rmSync(workspace, { force: true, recursive: true });
  }
);

await check('worktree itself is still mounted at /workspace', async () => {
  const { c, repo, name, wtDir, workspace } = fakeWorktree();
  const yaml = readFileSync(await writeAgentCompose(c, repo, name, {}), 'utf8');
  assert.ok(yaml.includes(`- ${wtDir}:/workspace`));
  rmSync(workspace, { force: true, recursive: true });
});

console.log('writeAgentCompose — credential mounts');

await check(
  'credential mounts are always emitted :ro, regardless of the flag',
  async () => {
    const { c, repo, name, workspace } = fakeWorktree();
    const mounts = [
      { hostPath: '/host/a', readonly: false, sandboxPath: '/sandbox/a' },
      { hostPath: '/host/b', readonly: true, sandboxPath: '/sandbox/b' },
    ];
    const yaml = readFileSync(
      await writeAgentCompose(c, repo, name, { mounts }),
      'utf8'
    );
    assert.ok(yaml.includes('- /host/a:/sandbox/a:ro'), yaml);
    assert.ok(yaml.includes('- /host/b:/sandbox/b:ro'), yaml);
    rmSync(workspace, { force: true, recursive: true });
  }
);

console.log('writeAgentCompose — restart policy');

await check('restart is "no", not on-failure', async () => {
  const { c, repo, name, workspace } = fakeWorktree();
  const yaml = readFileSync(await writeAgentCompose(c, repo, name, {}), 'utf8');
  assert.ok(yaml.includes('restart: "no"'), yaml);
  assert.ok(!yaml.includes('on-failure'), yaml);
  rmSync(workspace, { force: true, recursive: true });
});

console.log('writeAgentCompose — no duplicate mapping keys');

await check('no duplicate mapping key in a minimal compose file', async () => {
  const { c, repo, name, workspace } = fakeWorktree();
  const yaml = readFileSync(await writeAgentCompose(c, repo, name, {}), 'utf8');
  assertNoDuplicateMappingKeys(yaml);
  rmSync(workspace, { force: true, recursive: true });
});

// The config most likely to trip a structural regression: mounts, env, and
// an egress network all populated at once, exercising every optional block
// in the same file.
await check(
  'no duplicate mapping key with mounts, env, and network all set',
  async () => {
    const { c, repo, name, workspace } = fakeWorktree();
    const opts = {
      env: { ANTHROPIC_API_KEY: 'x', RUN_ID: 'r-1' },
      image: 'setu-agent:latest',
      mounts: [
        { hostPath: '/host/a', readonly: true, sandboxPath: '/sandbox/a' },
      ],
      network: 'setu-egress',
    };
    const yaml = readFileSync(
      await writeAgentCompose(c, repo, name, opts),
      'utf8'
    );
    assertNoDuplicateMappingKeys(yaml);
    assert.ok(yaml.includes('ANTHROPIC_API_KEY'));
    assert.ok(yaml.includes('networks:'));
    rmSync(workspace, { force: true, recursive: true });
  }
);

console.log('writeAgentCompose — project naming');

await check(
  'agent project name differs from the dev-server project name',
  async () => {
    const { c, repo, name, workspace } = fakeWorktree();
    const devProject = composeProjectName(repo, name);
    const yaml = readFileSync(
      await writeAgentCompose(c, repo, name, {}),
      'utf8'
    );
    const nameLine = yaml.split('\n').find((l) => l.startsWith('name:'));
    const agentProject = nameLine.slice('name:'.length).trim();
    assert.notEqual(agentProject, devProject);
    assert.ok(
      agentProject.startsWith(devProject),
      `expected ${agentProject} to be a suffixed form of ${devProject}`
    );
    rmSync(workspace, { force: true, recursive: true });
  }
);

console.log('writeAgentCompose — resource limits');

await check(
  'configured limits are clamped to engine capacity when it is known',
  async () => {
    const cap = engineCapacity();
    const { c, repo, name, workspace } = fakeWorktree();
    c.containerCpuLimit = 9999;
    c.containerMemoryLimit = '9999g';
    const yaml = readFileSync(
      await writeAgentCompose(c, repo, name, {}),
      'utf8'
    );
    const cpus = yaml.match(CPUS_LINE_RE)?.[1];
    const mem = yaml.match(MEM_LIMIT_LINE_RE)?.[1];
    if (cap.cpus) {
      assert.equal(
        Number(cpus),
        cap.cpus,
        'cpu limit should be clamped to engine capacity'
      );
    } else {
      assert.equal(
        Number(cpus),
        9999,
        'no engine reachable — configured value should pass through'
      );
    }
    if (cap.memMb) {
      assert.equal(
        mem,
        `${cap.memMb}m`,
        'mem limit should be clamped to engine capacity'
      );
    } else {
      assert.equal(
        mem,
        '9999g',
        'no engine reachable — configured value should pass through'
      );
    }
    rmSync(workspace, { force: true, recursive: true });
  }
);

await check(
  'limits pass through unclamped when under engine capacity',
  async () => {
    const { c, repo, name, workspace } = fakeWorktree();
    c.containerCpuLimit = 1;
    c.containerMemoryLimit = '1g';
    const yaml = readFileSync(
      await writeAgentCompose(c, repo, name, {}),
      'utf8'
    );
    assert.ok(yaml.includes('cpus: "1"'), yaml);
    assert.ok(yaml.includes('mem_limit: "1g"'), yaml);
    rmSync(workspace, { force: true, recursive: true });
  }
);

console.log(
  failures.length
    ? `\n${failures.length} failed: ${failures.join(', ')}`
    : '\nall passed'
);
process.exit(failures.length ? 1 : 0);
