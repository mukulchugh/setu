type Timer = Parameters<typeof clearTimeout>[0];

interface PollIO<T> {
  accept: (data: T) => void;
  cancel: (timer: Timer) => void;
  immediate?: boolean;
  intervalMs: number | null;
  onVisibility: (callback: () => void) => () => void;
  read: (signal: AbortSignal) => Promise<T>;
  refreshOnVisible?: boolean;
  reject: () => void;
  schedule: (callback: () => void, delay: number) => Timer;
  visible: () => boolean;
}

// Completion schedules the next read. Aborted reads must settle before a
// replacement starts, even when a transport ignores its AbortSignal.
export function createVisiblePoll<T>(io: PollIO<T>) {
  let timer: Timer | null = null,
    controller: AbortController | null = null;
  let generation = 0,
    stopped = false,
    resumePending = false;
  const clear = () => {
    if (timer !== null) {
      io.cancel(timer);
    }
    timer = null;
  };
  const later = () => {
    if (!stopped && io.visible() && io.intervalMs !== null) {
      timer = io.schedule(() => {
        timer = null;
        run();
      }, io.intervalMs);
    }
  };
  async function run() {
    if (stopped || !io.visible() || controller) {
      return;
    }
    clear();
    const own = generation;
    controller = new AbortController();
    try {
      const data = await io.read(controller.signal);
      if (!stopped && io.visible() && own === generation) {
        io.accept(data);
      }
    } catch {
      if (!stopped && io.visible() && own === generation) {
        io.reject();
      }
    } finally {
      controller = null;
      if (!stopped && io.visible()) {
        if (resumePending) {
          resumePending = false;
          run();
        } else {
          later();
        }
      }
    }
  }
  const unlisten = io.onVisibility(() => {
    clear();
    if (!io.visible()) {
      generation += 1;
      controller?.abort();
      resumePending = false;
      return;
    }
    if (controller) {
      resumePending = true;
    } else if (io.immediate === false || io.refreshOnVisible === false) {
      later();
    } else {
      run();
    }
  });
  if (io.immediate === false) {
    later();
  } else {
    run();
  }
  return {
    refresh: () => {
      run();
    },
    stop() {
      stopped = true;
      generation += 1;
      clear();
      controller?.abort();
      unlisten();
    },
  };
}
