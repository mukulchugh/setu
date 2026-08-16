import { Tool } from "@raycast/api";
import { WorktreeRef, stopWorktree } from "../lib/api";

type Input = WorktreeRef;

/**
 * Stops a worktree's running dev server.
 */
export default async function tool(input: Input) {
  const res = await stopWorktree(input.repo, input.name);
  if (res.ok === false) throw new Error(res.error ?? "Stop failed");
  return `Stopped ${input.repo}/${input.name}.`;
}

export const confirmation: Tool.Confirmation<Input> = async (input) => ({
  message: `Stop the dev server for "${input.name}" in ${input.repo}?`,
});
