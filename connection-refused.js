const REFUSED = ['ECONNREFUSED', 'ConnectionRefused'];

// Node reports ECONNREFUSED; Bun's fetch reports ConnectionRefused.
export function isConnectionRefused(error) {
  return REFUSED.includes(error?.code) || REFUSED.includes(error?.cause?.code);
}
