// Small offline command boundary for the existing Spans archive maintenance
// primitives. This module never supplies defaults or activates a restored
// archive; every path is explicit and the primitives own all filesystem work.
import { createSpansBackup, restoreSpansBackup } from './spans-maintenance.js';

function readCommand(raw) {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const keys = Reflect.ownKeys(raw);
    const operationDescriptor = Object.getOwnPropertyDescriptor(
      raw,
      'operation'
    );
    if (!(operationDescriptor && Object.hasOwn(operationDescriptor, 'value'))) {
      return null;
    }
    const operation = operationDescriptor.value;
    if (operation !== 'backup' && operation !== 'restore') {
      return null;
    }
    const fields =
      operation === 'backup'
        ? ['root', 'destination']
        : ['backupRoot', 'destination'];
    const expected = ['operation', ...fields];
    if (
      keys.length !== expected.length ||
      expected.some((key) => !keys.includes(key))
    ) {
      return null;
    }
    const values = {};
    for (const key of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
        return null;
      }
      values[key] = descriptor.value;
    }
    return { operation, values };
  } catch {
    // Proxies and hostile property descriptors are invalid public input.
    return null;
  }
}

/**
 * Run an explicit offline Spans archive backup or restore.
 *
 * Backup accepts { operation: 'backup', root, destination }; restore accepts
 * { operation: 'restore', backupRoot, destination }. The existing primitive's
 * structured result is returned unchanged, including incomplete and unknown
 * outcomes.
 */
export function runSpansMaintenanceCommand(raw) {
  const command = readCommand(raw);
  if (!command) {
    return createSpansBackup({});
  }
  return command.operation === 'backup'
    ? createSpansBackup(command.values)
    : restoreSpansBackup(command.values);
}
