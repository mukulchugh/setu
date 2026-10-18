import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { createResourceAdmission } from './resource-admission.js';
import { createSetupProgress } from './setup-progress.js';
import { createSpansArtifacts } from './spans-artifacts.js';
import { createSpansDrafts } from './spans-drafts.js';
import { createSpansExecution } from './spans-execution.js';
import { SPANS_EXEC_DEFAULT_PROFILES } from './spans-execution-provider.js';
import { openSpansStore } from './spans-store.js';
import { createWorkspaceState } from './workspace-state.js';

// Test support for the Spans execution tests. Everything lives in one
// temporary directory: a real Git repository and linked worktree, a real
// persistent Spans archive, real workspace state, real resource admission and
// real writer claims. The only stand-in is the provider command, which is the
// local process fixture. Nothing here talks to a provider.

export const PROVIDER_FIXTURE = join(
  import.meta.dir,
  'spans-execution.provider-fixture.js'
);
const GiB = 1024 ** 3;

function git(dir, args) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Setu Test',
      '-c',
      'user.email=test@example.invalid',
      '-C',
      dir,
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trimEnd();
}

function runsFixture(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).includes(PROVIDER_FIXTURE);
  } catch {
    return false;
  }
}

export const TARGET = Object.freeze({ name: 'feature', repo: 'demo' });
export const PROFILE = 'claude-code-sonnet';

// The real built-in profile: subscription billing, auto permission mode, a
// restricted toolset, effort accepted unverified.
export const SUBSCRIPTION_PROFILES = SPANS_EXEC_DEFAULT_PROFILES;

// A metered Claude Code profile: no `billing`, so it needs a dollar budget and
// a hard cost cap. Claude Code's budget stop is post-response and so never
// counts as a hard cap, which makes this profile unlaunchable; it exists to test
// that refusal, and nothing in production uses it.
export const METERED_PROFILES = Object.freeze({
  [PROFILE]: Object.freeze({
    client: 'claude-code',
    effort: 'medium',
    model: 'claude-sonnet-5-5',
    permissionMode: 'dontAsk',
    provider: 'anthropic',
  }),
});

export const SPANS = [
  { dependencies: [], spanId: 'build', title: 'Build the thing' },
  { dependencies: ['build'], spanId: 'verify', title: 'Verify the thing' },
];

// Builds the repository, worktree and archive layout under a fresh directory.
function buildWorld() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'setu-spans-exec-')));
  const archive = join(root, 'archive');
  const workspace = join(root, 'workspace');
  mkdirSync(archive, { mode: 0o700 });
  mkdirSync(workspace);
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, ['init', '--quiet', '-b', 'main']);
  writeFileSync(join(source, 'README.md'), 'demo\n');
  writeFileSync(join(source, 'bun.lock'), '{"lockfileVersion":1}\n');
  git(source, ['add', '-A']);
  git(source, ['commit', '--quiet', '-m', 'initial']);
  const repoDir = join(root, 'demo.git');
  execFileSync('git', ['clone', '--quiet', '--bare', source, repoDir]);
  mkdirSync(join(workspace, 'demo'));
  git(repoDir, [
    'worktree',
    'add',
    '--quiet',
    '-b',
    'feature',
    join(workspace, 'demo', 'feature'),
  ]);
  return root;
}

// Opens every collaborator over an existing fixture directory. A second
// attachment is how a test restarts the system after a process was killed.
export function attachExecutionFixture(root, options = {}) {
  const archive = join(root, 'archive');
  const workspace = join(root, 'workspace');
  const repoDir = join(root, 'demo.git');
  const wtDir = join(workspace, 'demo', 'feature');
  const pidFile = join(root, 'provider-pids');
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: workspace,
  });
  const setupProgress = createSetupProgress({
    newAttemptId: () => 'setup-attempt-1',
    state,
  });
  const admission = createResourceAdmission({
    hostHealth: () =>
      Promise.resolve({ availableBytes: 30 * GiB, state: 'ready' }),
    state,
  });
  const store = openSpansStore({ root: archive });
  const artifacts = createSpansArtifacts({ root: archive });

  const services = [];
  const fixture = {
    admission,
    archive,
    artifacts,
    async completeSetup() {
      const checkoutIdentity = await inspectCheckoutIdentity(
        { repoDir, wtDir },
        fs
      );
      const started = await setupProgress.start({
        checkoutIdentity,
        logLocation: join(root, 'setup.log'),
        stage: 'install',
        target: TARGET,
      });
      if (!started.ok) {
        throw new Error(`fixture setup failed: ${started.code}`);
      }
      await setupProgress.finish({
        attemptId: started.record.attemptId,
        checkoutIdentity,
        outcome: 'completed',
        target: TARGET,
      });
    },
    // Builds the execution service over the fixture. The provider command is
    // the local process fixture; every other collaborator is the real module.
    createService(overrides = {}) {
      const { archive: archiveOverride, ...rest } = overrides;
      const service = createSpansExecution({
        admission,
        archive: { artifacts, root: archive, store, ...archiveOverride },
        profiles: options.profiles ?? SUBSCRIPTION_PROFILES,
        provider: {
          command: [process.execPath, PROVIDER_FIXTURE],
          env: {
            SETU_FIXTURE_DELAY_MS: '250',
            // The live client reports no effort at init.
            SETU_FIXTURE_NO_EFFORT: '1',
            SETU_FIXTURE_PIDFILE: pidFile,
          },
        },
        resolveTarget: (target) =>
          Promise.resolve(
            target.repo === TARGET.repo && target.name === TARGET.name
              ? { repoDir, wtDir }
              : null
          ),
        setupProgress,
        ...rest,
      });
      services.push(service);
      return service;
    },
    async dispose({ keepRoot = false } = {}) {
      await Promise.all(services.splice(0).map((service) => service.close()));
      store.close();
      fixture.killProviders();
      if (!keepRoot) {
        rmSync(root, { force: true, recursive: true });
      }
    },
    git: (args) => git(wtDir, args),
    gitRepo: (args) => git(repoDir, args),
    // Stops every fixture process the directory started. Safe to repeat.
    killProviders() {
      for (const pid of fixture.providerPids()) {
        // A pid can be reused once its process is gone: only ever signal a
        // process that is still running this fixture.
        if (!runsFixture(pid)) {
          continue;
        }
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    },
    // Every fixture process this directory ever started, alive or not.
    providerPids: () =>
      existsSync(pidFile)
        ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number)
        : [],
    repoDir,
    root,
    setupProgress,
    state,
    store,
    wtDir,
  };
  return fixture;
}

export function createExecutionFixture(options = {}) {
  const root = buildWorld();
  const fixture = attachExecutionFixture(root, options);
  const drafts = createSpansDrafts({ store: fixture.store });
  const draft = drafts.createRun({
    goal: 'Ship the demo',
    owner: 'tester',
    runId: 'run-1',
    spans: SPANS,
  });
  if (!draft.ok) {
    throw new Error(`fixture draft failed: ${draft.code}`);
  }
  return fixture;
}
