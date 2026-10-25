import { exactRequest } from './spans-execution-core.js';

const DIGEST = /^[a-f0-9]{64}$/;
const LEGACY_FIELDS = [
  'bunVersion',
  'linkerMode',
  'lockfileHash',
  'platformNamespace',
];
const RECEIPT_FIELDS = ['inputDigest', 'receiptDigest', 'version'];

// V2 binds Setu's successful install receipt, including explicit projects
// without dependencies. Legacy identities remain readable as history only.
export function parseSpansDependencyBinding(value) {
  const current = exactRequest(value, RECEIPT_FIELDS);
  if (current) {
    return current.version === 2 &&
      typeof current.inputDigest === 'string' &&
      DIGEST.test(current.inputDigest) &&
      typeof current.receiptDigest === 'string' &&
      DIGEST.test(current.receiptDigest)
      ? current
      : null;
  }
  const legacy = exactRequest(value, LEGACY_FIELDS, ['state']);
  return legacy &&
    LEGACY_FIELDS.every(
      (key) =>
        typeof legacy[key] === 'string' &&
        legacy[key].length > 0 &&
        legacy[key].length <= 4096
    ) &&
    DIGEST.test(legacy.lockfileHash)
    ? Object.fromEntries(LEGACY_FIELDS.map((key) => [key, legacy[key]]))
    : null;
}
