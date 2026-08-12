// "3h ago" style. Shared by app.tsx (lastCommitAt/createdAt, unix-seconds
// from repoGitMeta in portal.js) and the Archived view (removedAt, same
// unix-seconds convention). Split out here rather than defined in app.tsx so
// a components/ file can import it without a circular value-import back into
// app.tsx (app.tsx already imports components/ files, not the reverse).
export function relativeTime(unixSeconds: number | null): string {
  if (!unixSeconds) return '';
  const s = Date.now() / 1000 - unixSeconds;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / 2592000)}mo ago`;
}
