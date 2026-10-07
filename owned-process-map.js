export function watchOwnedProcessExit(map, key, entry, exited, observe) {
  async function reconcile() {
    if (map.get(key) !== entry) {
      return;
    }
    let state;
    try {
      state = await observe(entry);
    } catch {
      state = 'unknown';
    }
    // A wrapper exit is not a detached-group exit. Retain surviving or unknown
    // children for Stop/Remove and cutover, including a rejected exit observer.
    if (state === 'dead' && map.get(key) === entry) {
      map.delete(key);
    }
  }
  return Promise.resolve(exited).then(reconcile, reconcile);
}

export async function pruneDeadEntries(map, observe) {
  const deleted = [];
  for (const [key, entry] of map) {
    if ((await observe(entry)) === 'dead' && map.get(key) === entry) {
      map.delete(key);
      deleted.push(key);
    }
  }
  return deleted;
}
