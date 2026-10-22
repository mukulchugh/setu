// Child process for links-projection.crash.test.js: projects a deterministic
// engine log into the archive at ROOT and kills itself (SIGKILL, so nothing is
// flushed or rolled back by this process) at the named point. Test support only.
import { createLinksAssociations } from './links-associations.js';
import {
  createFakeEngine,
  engineMessage,
} from './links-projection.engine-fixture.js';
import { createLinksProjection } from './links-projection.js';
import { openSpansStore } from './spans-store.js';

const [, , root, count, killAt = 'never', killOn = '1', mode] = process.argv;
const die = () => process.kill(process.pid, 'SIGKILL');
const seen = { commit: 0, probe: 0 };

const engine = createFakeEngine();
for (let index = 0; index < Number(count); index += 1) {
  engine.record(`m_${index}`, engineMessage(), 'queued');
}
const store = openSpansStore({ root });
const associations = createLinksAssociations({
  isKnownOrigin: () => true,
  store,
});
const projection = createLinksProjection({
  associations,
  engine: {
    async events(args) {
      seen.probe += 1;
      if (killAt === 'read' && seen.probe === Number(killOn)) {
        die();
      }
      const page = await engine.events(args);
      if (mode === 'pause-reads' && args.limit !== 1) {
        const continueReading = new Promise((resolve) => {
          process.stdin.once('data', resolve);
        });
        console.log(
          JSON.stringify({
            after: args.after,
            count: page.events.length,
            type: 'read-ready',
          })
        );
        await continueReading;
      }
      return page;
    },
  },
  store: {
    commitImport(input) {
      seen.commit += 1;
      if (killAt === 'before-commit' && seen.commit === Number(killOn)) {
        die();
      }
      const result = store.commitImport(input);
      if (killAt === 'after-commit' && seen.commit === Number(killOn)) {
        die();
      }
      return result;
    },
    readRun: store.readRun,
    readSourceCursor: store.readSourceCursor,
  },
});
const result = await projection.runOnce({ maxBatches: 1000 });
console.log(JSON.stringify({ complete: result.complete }));
store.close();
