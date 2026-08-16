import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { PortalDownEmptyView } from "./components";
import { Port, PortalUnreachableError, killPort, listPorts } from "./lib/api";

async function runKill(port: number, revalidate: () => void) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Killing :${port}…`,
  });
  try {
    const res = await killPort(port);
    if (res.ok === false) {
      toast.style = Toast.Style.Failure;
      toast.title = `Kill :${port} failed`;
      toast.message = res.error;
    } else {
      toast.style = Toast.Style.Success;
      toast.title = `Killed :${port}`;
    }
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = `Kill :${port} failed`;
    toast.message = e instanceof PortalUnreachableError ? e.message : String(e);
  }
  revalidate();
}

function PortActions({ p, revalidate }: { p: Port; revalidate: () => void }) {
  return (
    <ActionPanel>
      <ActionPanel.Section>
        <Action.OpenInBrowser
          title="Open in Browser"
          url={`http://localhost:${p.port}`}
        />
        <Action.CopyToClipboard title="Copy Port" content={String(p.port)} />
        <Action.CopyToClipboard title="Copy PID" content={p.pid} />
      </ActionPanel.Section>
      <ActionPanel.Section>
        {/* Same confirm-before-kill gate as the web UI's Ports page (added
            for the same reason: this is the one irreversible action here,
            and a fat-fingered kill on the wrong port has no undo) — and,
            like Remove Worktree in list-worktrees.tsx, deliberately NOT
            also exposed as a standalone AI tool, only as a human-confirmed
            UI action. */}
        <Action
          title="Kill"
          icon={Icon.XMarkCircle}
          style={Action.Style.Destructive}
          shortcut={{ modifiers: ["ctrl"], key: "x" }}
          onAction={async () => {
            const confirmed = await confirmAlert({
              title: `Kill port ${p.port}?`,
              message: `${p.cmd} (pid ${p.pid})${p.worktree ? ` — ${p.worktree}` : ""}. This can't be undone.`,
              primaryAction: {
                title: "Kill",
                style: Alert.ActionStyle.Destructive,
              },
            });
            if (confirmed) runKill(p.port, revalidate);
          }}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

export default function Command() {
  const { isLoading, data, revalidate, error } = useCachedPromise(
    listPorts,
    [],
    { keepPreviousData: true },
  );

  const portalDown = error instanceof PortalUnreachableError;
  const ports = data ?? [];

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter by port, command, or worktree…"
    >
      {portalDown ? (
        <PortalDownEmptyView onRetry={revalidate} />
      ) : ports.length === 0 ? (
        <List.EmptyView
          icon={Icon.Network}
          title="No active ports"
          description="Nothing is currently listening in Setu's tracked range (3000-3999)."
        />
      ) : (
        ports.map((p) => (
          <List.Item
            key={p.port}
            icon={{
              source: Icon.Circle,
              tintColor: p.worktree ? Color.Green : Color.Orange,
            }}
            title={`:${p.port}`}
            subtitle={p.cmd}
            accessories={[
              p.worktree
                ? { text: p.worktree, icon: Icon.Layers }
                : { text: "untracked", icon: Icon.QuestionMarkCircle },
              { text: `pid ${p.pid}` },
            ]}
            actions={<PortActions p={p} revalidate={revalidate} />}
          />
        ))
      )}
    </List>
  );
}
