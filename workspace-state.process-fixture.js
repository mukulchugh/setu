// Test-only subprocess. Every filesystem path is supplied by its parent test.
import fs from 'node:fs';
import { join } from 'node:path';
import { assignPort, syncHosts } from './lib.js';
import { createWorkspaceState } from './workspace-state.js';

const [root, role, storeName = 'config'] = process.argv.slice(2);
if (!(root && ['first', 'second', 'reader'].includes(role))) {
  throw new Error('Explicit test root and role required');
}
let release;
const barrier = new Promise((resolve) => {
  release = resolve;
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (text) => {
  if (text.includes('release')) {
    release();
  }
});
let contended = false;
const store = createWorkspaceState({
  configPath: join(root, 'config.json'),
  setuDir: root,
  sleep: async (ms) => {
    if (!contended) {
      contended = true;
      process.stdout.write('contended\n');
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  },
  workspaceRoot: root,
});
try {
  if (role === 'reader') {
    let stopped = false;
    barrier.then(() => {
      stopped = true;
    });
    let count = 0,
      oldSeen = false,
      newSeen = false;
    process.stdout.write('ready\n');
    while (!stopped) {
      const value = JSON.parse(
        fs.readFileSync(join(root, 'config.json'), 'utf8')
      );
      if (value.version === 'old') {
        oldSeen = true;
      } else if (value.version === 'new' && value.payload.length === 32_768) {
        newSeen = true;
      } else {
        throw new Error('incomplete publication');
      }
      count += 1;
      // biome-ignore lint/performance/noAwaitInLoops: The fixture must observe each atomic publication in order before declaring completion.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (newSeen) {
        process.stdout.write(
          `observed ${JSON.stringify({ count, newSeen, oldSeen })}\n`
        );
        break;
      }
    }
  } else if (storeName === 'ports') {
    const port = await assignPort(root, 'r', role, {
      probe: async () => {
        if (role === 'first') {
          process.stdout.write('held\n');
          await barrier;
        }
        return new Set();
      },
      state: store,
    });
    process.stdout.write(`committed ${port}\n`);
  } else if (storeName === 'routing') {
    await store.withRouting(async () => {
      await store.snapshot(['ports']);
      if (role === 'first') {
        process.stdout.write('held\n');
        await barrier;
      } else {
        await store.replace('ports', []);
      }
      await syncHosts(root, {
        hostsPath: join(root, 'hosts'),
        run: (_command, args) => fs.copyFileSync(args[2], args[3]),
        stagingPath: join(root, 'hosts.tmp'),
        state: store,
      });
    });
    process.stdout.write('committed routing\n');
  } else {
    const result = await store.update(storeName, async (value) => {
      if (role === 'first') {
        process.stdout.write('held\n');
        await barrier;
      }
      if (storeName === 'archive') {
        return [...value, { operationId: role }];
      }
      if (storeName === 'mcpTokens') {
        return {
          ...value,
          issuer: { ...value.issuer, [role]: { fixture: true } },
        };
      }
      if (storeName === 'projects') {
        return {
          ...value,
          [role]: {
            base: 3000 + Object.keys(value).length * 100,
            label: role,
            slug: null,
          },
        };
      }
      return { ...value, [role]: storeName === 'sidecars' ? [] : true };
    });
    process.stdout.write(`committed ${JSON.stringify(result)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.code ?? 'TEST_FAILED'}:${error.phase ?? ''}\n`);
  process.exitCode = 1;
} finally {
  process.stdin.destroy();
}
