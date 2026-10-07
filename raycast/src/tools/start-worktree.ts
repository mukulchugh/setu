import { Tool } from "@raycast/api";
import { WorktreeRef, startWorktree } from "../lib/api";

type Input = WorktreeRef;

/**
 * Starts a worktree's dev server, in whichever mode (bare or container)
 * it's currently sticky to for that worktree. Does nothing to the mode
 * itself — that's decided per-worktree, never by this tool.
 */
export default async function tool(input: Input) {
  const res = await startWorktree(input.repo, input.name);
  if (res.ok === false) throw new Error(res.error ?? "Start failed");
  return res.queued
    ? `Queued ${input.repo}/${input.name} at position ${res.position}.`
    : `Starting ${input.repo}/${input.name}.`;
}

export const confirmation: Tool.Confirmation<Input> = async (input) => ({
  message: `Start the dev server for "${input.name}" in ${input.repo}?`,
});
