import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  observeSpansClientAdapter,
  previewSpansClientAdapter,
  previewSpansClientGroup,
} from './spans-integration-adapters.js';

const fixtures = new Set();
const skill =
  '---\nname: setu-spans\ndescription: shared workflow\n---\n# Setu Spans\n';
const now = 1_800_000_000_000;

async function fixture() {
  const root = await mkdtemp(
    resolve(await realpath(tmpdir()), 'setu-spans-adapter-')
  );
  fixtures.add(root);
  const home = resolve(root, 'home');
  const source = resolve(
    root,
    'bundled',
    'claude-plugin',
    'skills',
    'setu-spans',
    'SKILL.md'
  );
  await mkdir(resolve(source, '..'), { recursive: true });
  await writeFile(source, skill);
  const manifest = pluginManifestPath(source);
  await mkdir(resolve(manifest, '..'), { recursive: true });
  await writeFile(manifest, JSON.stringify({ name: 'setu', version: '0.3.0' }));
  await mkdir(home, { recursive: true });
  return { home, source };
}

function artifact(home, directory) {
  return resolve(home, directory, 'setu-spans', 'SKILL.md');
}

function pluginManifestPath(source) {
  return resolve(dirname(source), '../..', '.claude-plugin', 'plugin.json');
}

function receipt(client, path, content = skill) {
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  return {
    appliedEvidence: { observedAt: now - 1000, state: 'observed' },
    client,
    content,
    digest,
    path,
    version: `${client}-skills-v1`,
  };
}

function handshake(client, digest, overrides = {}) {
  return {
    activatedDigests: [digest],
    client,
    connected: true,
    freshSession: true,
    observedAt: now - 1000,
    previousSessionId: 'old-session',
    sessionId: 'new-session',
    transport: 'mcp',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    [...fixtures].map((path) => rm(path, { force: true, recursive: true }))
  );
  fixtures.clear();
});

describe('read-only Spans client adapter previews', () => {
  test('plans one Codex-owned artifact shared by Codex and Cursor', async () => {
    const { home, source } = await fixture();
    const canonical = artifact(home, '.agents/skills');
    const digest = `sha256:${createHash('sha256').update(skill).digest('hex')}`;
    const cursorWithoutOwner = await previewSpansClientGroup({
      clients: ['cursor'],
      home,
      now,
      skillSourcePath: source,
    });
    expect(cursorWithoutOwner.preview.conflicts).toContainEqual({
      client: 'cursor',
      code: 'SHARED_ARTIFACT_REUSE_REQUIRES_VERIFIED_CODEX_OWNER',
      path: canonical,
    });
    expect(cursorWithoutOwner.preview.operations).toEqual([]);

    const initial = await previewSpansClientGroup({
      clients: ['codex', 'cursor'],
      home,
      now,
      skillSourcePath: source,
    });

    expect(initial.ok).toBe(true);
    expect(initial.preview.previewOnly).toBe(true);
    expect(initial.artifactPlans).toEqual([
      { client: 'codex', consumers: ['codex', 'cursor'], path: canonical },
    ]);
    expect(initial.preview.operations).toEqual([
      {
        client: 'codex',
        digest,
        kind: 'create',
        path: canonical,
        version: 'codex-skills-v1',
      },
    ]);
    expect(initial.preview.statuses.cursor).toEqual({
      connected: 'unknown',
      installed: 'not-verified',
      verified: 'unverified',
    });

    await mkdir(resolve(canonical, '..'), { recursive: true });
    await writeFile(canonical, skill);
    const reusedCursorOnly = await previewSpansClientGroup({
      clients: ['cursor'],
      home,
      now,
      previousReceipts: [receipt('codex', canonical)],
      skillSourcePath: source,
    });
    expect(reusedCursorOnly.ok).toBe(true);
    expect(reusedCursorOnly.preview.operations).toEqual([
      {
        client: 'codex',
        digest,
        kind: 'no-op',
        path: canonical,
        version: 'codex-skills-v1',
      },
    ]);

    const reused = await previewSpansClientGroup({
      clients: ['codex', 'cursor'],
      handshakes: [handshake('cursor', digest)],
      home,
      now,
      previousReceipts: [receipt('codex', canonical)],
      skillSourcePath: source,
    });
    expect(reused.ok).toBe(true);
    expect(reused.preview.operations).toEqual([
      {
        client: 'codex',
        digest,
        kind: 'no-op',
        path: canonical,
        version: 'codex-skills-v1',
      },
    ]);
    expect(reused.preview.statuses.cursor).toEqual({
      connected: 'connected',
      installed: 'installed',
      verified: 'verified',
    });
    expect(
      reused.preview.operations.some((row) => row.path.includes('.cursor/'))
    ).toBe(false);
  });

  test('reports missing discovery roots as bounded missing observations', async () => {
    const { home, source } = await fixture();
    const result = await previewSpansClientAdapter({
      client: 'codex',
      home,
      now,
      skillSourcePath: source,
    });
    expect(result.ok).toBe(true);
    expect(result.observation.roots).toContainEqual({
      directory: '.agents/skills',
      kind: 'missing',
      path: resolve(home, '.agents/skills'),
    });
    expect(result.observation.observations[0]).toMatchObject({
      ancestorSymlink: false,
      digest: null,
      kind: 'missing',
      symlink: false,
    });
  });

  test('refuses symlinked discovery roots and exact artifacts', async () => {
    const { home, source } = await fixture();
    const outside = resolve(home, '..', 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, resolve(home, '.claude'));
    expect(
      await observeSpansClientAdapter({ client: 'cursor', home })
    ).toMatchObject({
      code: 'PATH_SYMLINK',
      ok: false,
    });

    const second = await fixture();
    const target = artifact(second.home, '.agents/skills');
    await mkdir(resolve(target, '..'), { recursive: true });
    await symlink(source, target);
    const result = await previewSpansClientGroup({
      clients: ['codex', 'cursor'],
      home: second.home,
      now,
      skillSourcePath: second.source,
    });
    expect(result).toMatchObject({ code: 'PATH_SYMLINK', ok: false });
  });

  test('reuses the Codex-owned artifact after the packaged Claude plugin preview', async () => {
    const { home, source } = await fixture();
    const codexPath = artifact(home, '.agents/skills');
    const claudePath = artifact(home, '.claude/skills');

    const codexPlan = await previewSpansClientAdapter({
      client: 'codex',
      home,
      now,
      skillSourcePath: source,
    });
    expect(codexPlan.preview.operations).toEqual([
      expect.objectContaining({
        client: 'codex',
        kind: 'create',
        path: codexPath,
      }),
    ]);
    await mkdir(resolve(codexPath, '..'), { recursive: true });
    await writeFile(codexPath, skill);

    const claudePlan = await previewSpansClientAdapter({
      client: 'claude',
      home,
      now,
      previousReceipts: [receipt('codex', codexPath)],
      skillSourcePath: source,
    });
    expect(claudePlan.ok).toBe(true);
    expect(claudePlan.layout).toBeNull();
    expect(claudePlan.clientSource).toMatchObject({
      activation: {
        enabled: 'unverified',
        launch: 'unverified',
        registration: 'unverified',
      },
      available: true,
      mcpConnection: 'unknown',
      pluginName: 'setu',
      source: 'packaged-plugin',
    });
    expect(claudePlan.clientSource.launchPreview).toEqual({
      args: ['--plugin-dir', resolve(resolve(source, '..'), '../..')],
      executable: 'claude',
    });
    expect(claudePlan.preview.operations).toEqual([]);
    expect(claudePlan.observation.candidates).toContainEqual(
      expect.objectContaining({ kind: 'missing', path: claudePath })
    );

    const codexReceipt = receipt('codex', codexPath);
    const cursorPlan = await previewSpansClientAdapter({
      client: 'cursor',
      home,
      now,
      previousReceipts: [codexReceipt],
      skillSourcePath: source,
    });
    expect(cursorPlan.ok).toBe(true);
    expect(cursorPlan.preview.operations).toEqual([
      {
        client: 'codex',
        digest: codexReceipt.digest,
        kind: 'no-op',
        path: codexPath,
        version: 'codex-skills-v1',
      },
    ]);
    expect(cursorPlan.observation.candidates).toContainEqual(
      expect.objectContaining({ kind: 'missing', path: claudePath })
    );

    const groupPlan = await previewSpansClientGroup({
      clients: ['codex', 'claude', 'cursor'],
      home,
      now,
      previousReceipts: [codexReceipt],
      skillSourcePath: source,
    });
    expect(groupPlan.ok).toBe(true);
    expect(groupPlan.artifactPlans).toEqual([
      { client: 'codex', consumers: ['codex', 'cursor'], path: codexPath },
    ]);
    expect(groupPlan.clientSources.claude).toMatchObject({
      activation: { enabled: 'unverified', launch: 'unverified' },
      available: true,
      source: 'packaged-plugin',
    });
    expect(groupPlan.preview.operations).toEqual([
      expect.objectContaining({
        client: 'codex',
        kind: 'no-op',
        path: codexPath,
      }),
    ]);
    expect(groupPlan.settingsPlan).toBeNull();
  });

  test('a fresh three-client plan has one Codex artifact and the packaged Claude source', async () => {
    const { home, source } = await fixture();
    const codexPath = artifact(home, '.agents/skills');
    const claudePath = artifact(home, '.claude/skills');
    const result = await previewSpansClientGroup({
      clients: ['codex', 'claude', 'cursor'],
      home,
      now,
      skillSourcePath: source,
    });
    expect(result.ok).toBe(true);
    expect(result.artifactPlans).toEqual([
      { client: 'codex', consumers: ['codex', 'cursor'], path: codexPath },
    ]);
    expect(result.preview.operations).toEqual([
      expect.objectContaining({
        client: 'codex',
        kind: 'create',
        path: codexPath,
      }),
    ]);
    expect(result.clientSources.claude).toMatchObject({
      activation: { enabled: 'unverified', launch: 'unverified' },
      available: true,
      source: 'packaged-plugin',
    });
    expect(result.settingsPlan).toBeNull();
    expect(result.observations.cursor.candidates).toContainEqual(
      expect.objectContaining({ kind: 'missing', path: claudePath })
    );
  });

  test('does not adopt matching unowned bytes or trust an unresolved stale receipt', async () => {
    const { home, source } = await fixture();
    const target = artifact(home, '.agents/skills');
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, skill);
    const unowned = await previewSpansClientGroup({
      clients: ['codex', 'cursor'],
      home,
      now,
      skillSourcePath: source,
    });
    expect(unowned.ok).toBe(false);
    expect(unowned.preview.conflicts).toContainEqual({
      client: 'codex',
      code: 'UNOWNED_COLLISION',
      path: target,
    });
    expect(unowned.preview.operations).toEqual([]);

    const unresolvedReceipt = receipt('codex', target);
    unresolvedReceipt.appliedEvidence.state = 'pending-reconciliation';
    const stale = await previewSpansClientGroup({
      clients: ['codex', 'cursor'],
      home,
      now,
      previousReceipts: [unresolvedReceipt],
      skillSourcePath: source,
    });
    expect(stale.ok).toBe(false);
    expect(stale.preview.conflicts).toContainEqual({
      client: 'codex',
      code: 'RECONCILIATION_REQUIRED',
      path: target,
    });

    const oldHandshake = handshake('cursor', stale.sourceDigest, {
      observedAt: now - 5 * 60 * 1000 - 1,
    });
    const pending = await previewSpansClientGroup({
      clients: ['codex', 'cursor'],
      handshakes: [oldHandshake],
      home,
      now,
      previousReceipts: [receipt('codex', target)],
      skillSourcePath: source,
    });
    expect(pending.preview.statuses.cursor).toEqual({
      connected: 'unknown',
      installed: 'installed',
      verified: 'unverified',
    });
  });

  test('does not use an edited owned artifact or an unowned duplicate discovery root', async () => {
    const { home, source } = await fixture();
    const codexPath = artifact(home, '.agents/skills');
    const claudePath = artifact(home, '.claude/skills');
    await mkdir(resolve(codexPath, '..'), { recursive: true });
    await writeFile(codexPath, 'user edit');
    const edited = await previewSpansClientGroup({
      clients: ['codex', 'cursor'],
      home,
      now,
      previousReceipts: [receipt('codex', codexPath)],
      skillSourcePath: source,
    });
    expect(edited.preview.conflicts).toContainEqual({
      client: 'codex',
      code: 'OWNED_FILE_EDITED',
      path: codexPath,
    });
    expect(edited.preview.operations).toEqual([]);

    const second = await fixture();
    const secondCodexPath = artifact(second.home, '.agents/skills');
    const secondClaudePath = artifact(second.home, '.claude/skills');
    await mkdir(resolve(secondCodexPath, '..'), { recursive: true });
    await writeFile(secondCodexPath, skill);
    await mkdir(resolve(secondClaudePath, '..'), { recursive: true });
    await writeFile(secondClaudePath, skill);
    const duplicate = await previewSpansClientGroup({
      clients: ['codex', 'cursor'],
      home: second.home,
      now,
      previousReceipts: [receipt('codex', secondCodexPath)],
      skillSourcePath: second.source,
    });
    expect(duplicate.preview.conflicts).toContainEqual({
      client: 'cursor',
      code: 'DISCOVERY_COLLISION',
      path: secondClaudePath,
    });
    expect(duplicate.preview.operations).toEqual([]);
    expect(duplicate.conflictReview).toMatchObject({
      affectedPaths: [secondClaudePath],
      status: 'requires-separate-review',
    });
    expect(duplicate.settingsPlan).toBeNull();
    expect(claudePath).not.toBe(secondClaudePath);
  });

  test('refuses an existing standalone Claude copy without adopting or rewriting it', async () => {
    const { home, source } = await fixture();
    const codexPath = artifact(home, '.agents/skills');
    const claudePath = artifact(home, '.claude/skills');
    await mkdir(resolve(claudePath, '..'), { recursive: true });
    await writeFile(claudePath, skill);
    const result = await previewSpansClientGroup({
      clients: ['claude', 'cursor'],
      home,
      now,
      previousReceipts: [receipt('claude', claudePath)],
      skillSourcePath: source,
    });
    expect(result.ok).toBe(false);
    expect(result.preview.conflicts).toContainEqual({
      client: 'claude',
      code: 'STANDALONE_CLAUDE_COPY_REQUIRES_REVIEW',
      path: claudePath,
    });
    expect(result.preview.conflicts).toContainEqual({
      client: 'cursor',
      code: 'DISCOVERY_COLLISION',
      path: claudePath,
    });
    expect(result.preview.operations).toEqual([]);
    expect(result.settingsPlan).toBeNull();
    expect(await Bun.file(claudePath).text()).toBe(skill);
    expect(await Bun.file(codexPath).exists()).toBe(false);
  });

  test('refuses a symlinked packaged Claude plugin manifest', async () => {
    const { home, source } = await fixture();
    const manifest = pluginManifestPath(source);
    const outsideManifest = resolve(home, 'plugin.json');
    await writeFile(outsideManifest, JSON.stringify({ name: 'setu' }));
    await rm(manifest);
    await symlink(outsideManifest, manifest);
    expect(
      await previewSpansClientAdapter({
        client: 'claude',
        home,
        now,
        skillSourcePath: source,
      })
    ).toMatchObject({ code: 'CLAUDE_PLUGIN_PATH_SYMLINK', ok: false });
  });

  test('Cursor removal retains the shared Codex artifact and exposes the exact access review', async () => {
    const { home, source } = await fixture();
    const shared = artifact(home, '.agents/skills');
    await mkdir(resolve(shared, '..'), { recursive: true });
    await writeFile(shared, skill);
    const result = await previewSpansClientGroup({
      clients: ['codex', 'cursor'],
      home,
      now,
      previousReceipts: [receipt('codex', shared)],
      removeClient: 'cursor',
      skillSourcePath: source,
    });
    expect(result.ok).toBe(false);
    expect(result.preview.conflicts).toContainEqual({
      client: 'cursor',
      code: 'CURSOR_ACCESS_REQUIRES_SEPARATE_REVIEW',
      path: shared,
    });
    expect(result.retainedArtifacts).toEqual([
      { owner: 'codex', path: shared, retainedFor: ['codex'] },
    ]);
    expect(result.conflictReview).toMatchObject({
      affectedPaths: [shared],
      disposition: 'cursor-access-cannot-be-revoked-by-this-preview',
      status: 'requires-separate-review',
    });
    expect(result.settingsPlan).toBeNull();
    expect(result.preview.operations).toEqual([]);
    expect(await Bun.file(shared).text()).toBe(skill);
  });

  test('enforces the canonical skill read bound and rejects invalid group inputs', async () => {
    const { home } = await fixture();
    const oversized = resolve(home, 'oversized.md');
    await writeFile(oversized, 'x'.repeat(1024 * 1024 + 1));
    const bounded = await previewSpansClientAdapter({
      client: 'codex',
      home,
      now,
      skillSourcePath: oversized,
    });
    expect(bounded).toMatchObject({
      code: 'SKILL_ARTIFACT_TOO_LARGE',
      ok: false,
    });

    expect(
      await previewSpansClientGroup({ clients: ['codex', 'codex'], home, now })
    ).toMatchObject({ code: 'CLIENTS_INVALID', ok: false });
  });
});
