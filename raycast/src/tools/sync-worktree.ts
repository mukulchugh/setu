import { Tool } from "@raycast/api";
import { WorktreeRef, syncWorktree } from "../lib/api";

type Input = WorktreeRef;

/**
 * Merges a worktree's resolved base branch (staging, or the project's
 * default branch if it has no staging branch) into the worktree. Only ever
 * completes a clean merge — if it would conflict, the merge is aborted
 * automatically and the conflicting files are reported instead, so the
 * worktree is never left half-merged.
 */
export default async function tool(input: Input) {
  const res = await syncWorktree(input.repo, input.name);
  if (res.ok === false) {
    if (res.conflicts?.length) {
      return `Would conflict in ${res.conflicts.length} file(s): ${res.conflicts.join(", ")}. Merge was aborted automatically — nothing changed. Resolve these in your editor, then try again.`;
    }
    throw new Error(res.error ?? "Sync failed");
  }
  return `Synced ${input.repo}/${input.name} with its base branch.`;
}

export const confirmation: Tool.Confirmation<Input> = async (input) => ({
  message: `Merge the base branch into "${input.name}" in ${input.repo}? This only proceeds if the merge is clean.`,
});
