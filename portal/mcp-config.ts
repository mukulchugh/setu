interface SaveResult {
  code?: string;
  committed?: boolean;
  error?: string;
  networkUncertain?: boolean;
  ok: boolean;
  reconciled?: boolean;
}

// The endpoint replaces a whole list. Never derive that list from an unread
// panel, and re-read before each explicit change so polling lag loses no rows.
export function createMcpConfigWriter<T>(io: {
  read: () => Promise<T[]>;
  write: (rows: T[]) => Promise<SaveResult>;
}) {
  let busy = false;
  return {
    async save(
      loaded: T[] | undefined,
      change: (rows: T[]) => T[] | Promise<T[]>
    ): Promise<SaveResult> {
      if (busy) {
        return {
          code: 'SAVE_PENDING',
          error: 'Wait for the current configuration change to finish.',
          ok: false,
        };
      }
      if (!loaded) {
        return {
          code: 'CONFIG_NOT_LOADED',
          error: 'Load the saved MCP servers before changing configuration.',
          ok: false,
        };
      }
      busy = true;
      try {
        let next: T[];
        try {
          next = await change(await io.read());
        } catch (error) {
          return {
            error:
              error instanceof Error
                ? error.message
                : 'Could not refresh MCP configuration. Try refreshing the saved list.',
            ok: false,
          };
        }
        try {
          return await io.write(next);
        } catch {
          return {
            error:
              'Outcome not confirmed. Refresh saved values before trying again.',
            networkUncertain: true,
            ok: false,
          };
        }
      } finally {
        busy = false;
      }
    },
  };
}
