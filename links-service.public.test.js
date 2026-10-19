import { expect, test } from 'bun:test';
import { createLinksService } from './links-service.js';

test('public inbox messages expose a run hint only as plain optional data', async () => {
  const service = createLinksService({
    client: {
      call: (operation) => {
        expect(operation).toBe('list');
        return Promise.resolve({
          ok: true,
          result: {
            messages: [
              {
                attempt_id: null,
                attempts: 0,
                created_at: 1,
                expires_at: 2,
                message_id: 'm_1',
                reason: null,
                recipient: {
                  native_id: 'never-public',
                  provider: 'claude-code',
                  session_hint: 'session-1',
                },
                redeliveries: 0,
                reply_to: null,
                run_hint: 'run-reference-only',
                sender: { kind: 'user' },
                size: 5,
                state: 'queued',
                stored_state: 'queued',
                updated_at: 1,
              },
            ],
          },
        });
      },
    },
    resolveTarget: () => ({
      checkoutIdentity: {
        checkout: { birthtimeNs: '1', dev: '2', ino: '3' },
        known: true,
      },
      name: 'topic',
      repo: 'repo',
    }),
    sessions: {
      list: () => ({
        ok: true,
        sessions: [
          {
            checkoutIdentity: {
              checkout: { birthtimeNs: '1', dev: '2', ino: '3' },
              known: true,
            },
            id: 'session-1',
            name: 'topic',
            nativeConversation: {
              id: 'native-1',
              provider: 'claude-code',
              state: 'bound',
            },
            ownership: 'owned',
            repo: 'repo',
            state: 'running',
            tool: 'claude-code',
          },
        ],
      }),
    },
  });
  const result = await service.inbox({
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-1',
  });
  expect(result).toMatchObject({
    messages: [{ runHint: 'run-reference-only' }],
    ok: true,
  });
  expect(result.messages[0].recipient.nativeId).toBe('never-public');
});
