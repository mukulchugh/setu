import { Tool } from "@raycast/api";
import { startWorktree } from "../lib/api";

type Input = {
  /** The repo/project the worktree belongs to, e.g. "quivly-app". */
  repo: string;
  /** The worktree's name — usually its branch name. */
  name: string;
};

/**
 * Starts a worktree's dev server, in whichever mode (bare or container)
 * it's currently sticky to for that worktree. Does nothing to the mode
 * itself — that's decided per-worktree, never by this tool.
 */
export default async function tool(input: Input) {
  const res = await startWorktree(input.repo, input.name);
  if (res.ok === false) throw new Error(res.error ?? "Start failed");
  return `Started ${input.repo}/${input.name}.`;
}

export const confirmation: Tool.Confirmation<Input> = async (input) => ({
  message: `Start the dev server for "${input.name}" in ${input.repo}?`,
});
