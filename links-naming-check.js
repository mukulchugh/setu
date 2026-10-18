// Naming check: first-party source and assets use Setu names only. The one exemption is the legal
// metadata beside the engine, where required notices and provenance must keep their original text.
// Run as `bun links-naming-check.js`; exits 1 and lists every hit.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Assembled from parts so this file does not contain the names it looks for.
const INHERITED = [
  ['reason', '[-_ ]?', 'network'],
  ['reason', '[-_ ]?', 'machines'],
  ['tin', 'can'],
].map((parts) => new RegExp(parts.join(''), 'i'));

const EXEMPT_PREFIX = 'engines/links/legal/';
const SKIPPED_SEGMENTS = new Set(['.git', '.scratch', 'node_modules']);
const BINARY =
  /\.(?:webp|png|jpe?g|gif|ico|icns|gz|zip|woff2?|ttf|pdf|lock|lockb)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

const isGenerated = (segment) =>
  segment === 'target' || segment.startsWith('target-');

function walk(root, directory = root, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_SEGMENTS.has(entry.name) || isGenerated(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(root, path, found);
    } else if (entry.isFile()) {
      found.push(relative(root, path).split(sep).join('/'));
    }
  }
  return found;
}

// In a repository, what Git would track or add: ignored output never counts as first-party.
function listFiles(root) {
  if (!existsSync(join(root, '.git'))) {
    return walk(root);
  }
  const listed = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, stderr: 'pipe', stdout: 'pipe' }
  );
  if (listed.exitCode !== 0) {
    throw new Error('Could not list repository files');
  }
  return listed.stdout
    .toString()
    .split('\0')
    .filter((file) => file && existsSync(join(root, file)));
}

export function scanNaming({ root }) {
  const hits = [];
  for (const file of listFiles(root)) {
    const segments = file.split('/');
    if (
      file.startsWith(EXEMPT_PREFIX) ||
      segments.some(
        (segment) => SKIPPED_SEGMENTS.has(segment) || isGenerated(segment)
      ) ||
      BINARY.test(file) ||
      statSync(join(root, file)).size > MAX_BYTES
    ) {
      continue;
    }
    const text = readFileSync(join(root, file), 'utf8');
    if (text.includes('\0')) {
      continue;
    }
    text.split('\n').forEach((line, index) => {
      const pattern = INHERITED.find((candidate) => candidate.test(line));
      if (pattern) {
        hits.push({ file, line: index + 1 });
      }
    });
  }
  return hits;
}

if (import.meta.main) {
  const hits = scanNaming({ root: dirname(fileURLToPath(import.meta.url)) });
  for (const { file, line } of hits) {
    console.error(`${file}:${line}: inherited product name`);
  }
  console.log(
    hits.length === 0
      ? 'Naming check passed.'
      : `Naming check failed: ${hits.length} hit(s).`
  );
  process.exit(hits.length === 0 ? 0 : 1);
}
