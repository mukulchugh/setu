export interface HostHealthObservation {
  availableBytes?: number;
  code?: string;
  critical?: boolean;
  dockerVm: { state: 'unknown' };
  low?: boolean;
  lowThresholdBytes: number;
  minimumAvailableBytes?: number;
  observedAt: number;
  state: 'ready' | 'unknown';
  totalBytes?: number;
  volumeId?: string;
  workspacePath?: string;
}

export interface HostStorageRead {
  lastReady?: HostHealthObservation;
  observation?: HostHealthObservation;
  refreshFailed: boolean;
}

export const initialHostStorageRead: HostStorageRead = { refreshFailed: false };

function hasMeasurement(value?: HostHealthObservation) {
  return (
    value?.state === 'ready' &&
    typeof value.availableBytes === 'number' &&
    Number.isFinite(value.availableBytes) &&
    value.availableBytes >= 0
  );
}

export function acceptHostStorage(
  previous: HostStorageRead,
  observation?: HostHealthObservation
): HostStorageRead {
  if (
    !(observation && Number.isFinite(observation.observedAt)) ||
    observation.observedAt < 0
  ) {
    return { ...previous, refreshFailed: true };
  }
  if (
    previous.observation &&
    (observation.observedAt < previous.observation.observedAt ||
      (previous.refreshFailed &&
        observation.observedAt === previous.observation.observedAt))
  ) {
    return previous;
  }
  return {
    lastReady: hasMeasurement(observation) ? observation : previous.lastReady,
    observation,
    refreshFailed: false,
  };
}

export function formatStorageBytes(bytes: number) {
  if (bytes < 1024 ** 2) {
    return `${Math.floor(bytes / 1024)} KiB`;
  }
  if (bytes < 1024 ** 3) {
    return `${Math.floor(bytes / 1024 ** 2)} MiB`;
  }
  // Never round available space up across the admission threshold.
  return `${Math.floor((bytes / 1024 ** 3) * 10) / 10} GiB`;
}

export function hostStorageView(read: HostStorageRead) {
  const current = !read.refreshFailed && hasMeasurement(read.observation);
  const measured = current ? read.observation : read.lastReady;
  const amount = measured?.availableBytes;
  const minimum = read.observation?.minimumAvailableBytes;
  const minimumText =
    typeof minimum === 'number' && Number.isFinite(minimum) && minimum > 0
      ? formatStorageBytes(minimum)
      : null;
  const minimumMessage = minimumText
    ? `New disk-heavy work requires a fresh storage check and at least ${minimumText} free. Stop and Remove remain available.`
    : 'Check workspace storage before starting more work. Stop and Remove remain available.';
  if (!current || amount === undefined) {
    return {
      detail: minimumMessage,
      lastChecked: measured?.observedAt,
      summary:
        typeof amount === 'number'
          ? `Unknown now · last check: ${formatStorageBytes(amount)} free`
          : 'Unknown',
      title: 'Workspace storage could not be checked.',
      tone: measured?.critical ? ('red' as const) : ('amber' as const),
    };
  }
  const summary = `${formatStorageBytes(amount)} free`;
  if (measured?.critical) {
    return {
      detail: minimumMessage,
      summary,
      title: `Workspace disk critically low: ${summary}.`,
      tone: 'red' as const,
    };
  }
  if (measured?.low) {
    return {
      detail: minimumMessage,
      summary,
      title: `Workspace disk space is low: ${summary}.`,
      tone: 'amber' as const,
    };
  }
  return { detail: '', summary, title: '', tone: null };
}
