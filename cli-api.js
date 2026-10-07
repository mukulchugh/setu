import { PORTAL_PORT } from './lib.js';

function queryString(values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value !== undefined && value !== null) {
      query.set(key, String(value));
    }
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

async function portalFetch({ method, path, body, headers }) {
  const response = await fetch(`http://localhost:${PORTAL_PORT}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers,
    method,
    signal: AbortSignal.timeout(method === 'GET' ? 5000 : 30_000),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('Portal response could not be read');
  }
  if (!response.ok && (!result || result.ok !== false)) {
    throw new Error(`Portal request failed (${response.status})`);
  }
  return result;
}

export function createCliApi({ request = portalFetch } = {}) {
  return {
    get(path, query) {
      return request({
        body: undefined,
        headers: { 'x-setu-source': 'cli' },
        method: 'GET',
        path: `${path}${queryString(query)}`,
      });
    },
    post(path, body) {
      return request({
        body,
        headers: { 'content-type': 'application/json', 'x-setu-source': 'cli' },
        method: 'POST',
        path,
      });
    },
  };
}
