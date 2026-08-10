import { useState } from "react";
import {
  Action,
  ActionPanel,
  Form,
  Toast,
  popToRoot,
  showToast,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import {
  PortalUnreachableError,
  createWorktree,
  listProjects,
} from "./lib/api";

export default function Command() {
  const { data: projects, isLoading } = useCachedPromise(listProjects, [], {
    initialData: [],
  });
  const [nameError, setNameError] = useState<string | undefined>();

  async function handleSubmit(values: {
    repo: string;
    name: string;
    tunnel: boolean;
  }) {
    if (!values.name.trim()) {
      setNameError("Branch name is required");
      return;
    }
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Creating worktree…",
    });
    try {
      const res = await createWorktree(
        values.repo,
        values.name.trim(),
        values.tunnel,
      );
      if (res.ok === false) {
        toast.style = Toast.Style.Failure;
        toast.title = "Create failed";
        toast.message = res.error;
        return;
      }
      toast.style = Toast.Style.Success;
      toast.title = `Created ${values.name.trim()}`;
      await popToRoot();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Create failed";
      toast.message =
        e instanceof PortalUnreachableError ? e.message : String(e);
    }
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Worktree" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="repo" title="Project">
        {(projects ?? []).map((p) => (
          <Form.Dropdown.Item key={p.name} value={p.name} title={p.label} />
        ))}
      </Form.Dropdown>
      <Form.TextField
        id="name"
        title="Branch name"
        placeholder="feat-my-feature"
        error={nameError}
        onChange={() => setNameError(undefined)}
      />
      <Form.Checkbox
        id="tunnel"
        title="Tunnel"
        label="Enable a public Cloudflare tunnel"
        defaultValue={false}
      />
    </Form>
  );
}
