const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*m`, 'g');
const SIDECAR_NAME = /^[a-zA-Z0-9_-]+$/;
const WHITESPACE = /\s+/;

export function sidecarArguments(text: string): string[] {
  return text.trim() ? text.trim().split(WHITESPACE) : [];
}

export function fileSyncPatterns(text: string): string[] {
  return text
    .split('\n')
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

export function sidecarNameError(name: string): string | null {
  return SIDECAR_NAME.test(name.trim())
    ? null
    : 'Use only letters, numbers, underscores, and hyphens for sidecar names.';
}

export function quoteShellPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function stripAnsiSgr(text: string): string {
  return text.replace(ANSI_SGR, '');
}
