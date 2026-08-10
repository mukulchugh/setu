import { useMemo } from "react";
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
  Keyboard,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import {
  Agent,
  PortalUnreachableError,
  Worktree,
  listAgents,
  listWorktrees,
  openTool,
  removeWorktree,
  startWorktree,
  stopWorktree,
  syncWorktree,
} from "./lib/api";

function statusOf(w: Worktree): { text: string; tint: Color } {
  if (w.active) return { text: "Running", tint: Color.Green };
  if (w.queued)
    return { text: `Queued #${w.queuePosition}`, tint: Color.Orange };
  return { text: "Stopped", tint: Color.SecondaryText };
}

// Same "running first" convention as the portal's own list (portal/app.tsx)
// — with worktrees potentially in the dozens, the handful actually live
// shouldn't be buried wherever an alphabetical/recency sort happens to put
// them.
function sortWorktrees(worktrees: Worktree[]): Worktree[] {
  return [...worktrees].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      Number(!!b.queued) - Number(!!a.queued),
  );
}

async function runAction(
  label: string,
  action: () => Promise<{ ok: boolean; error?: string; conflicts?: string[] }>,
  revalidate: () => void,
) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `${label}…`,
  });
  try {
    const res = await action();
    if (res.ok === false) {
      toast.style = Toast.Style.Failure;
      toast.title = `${label} failed`;
      toast.message = res.error;
    } else {
      toast.style = Toast.Style.Success;
      toast.title = `${label} done`;
    }
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = `${label} failed`;
    toast.message = e instanceof PortalUnreachableError ? e.message : String(e);
  }
  revalidate();
}

function WorktreeActions({
  w,
  agents,
  revalidate,
}: {
  w: Worktree;
  agents: Agent[];
  revalidate: () => void;
}) {
  return (
    <ActionPanel>
      <ActionPanel.Section>
        {w.active ? (
          <Action
            title="Stop"
            icon={Icon.Stop}
            onAction={() =>
              runAction("Stop", () => stopWorktree(w.repo, w.name), revalidate)
            }
          />
        ) : (
          <Action
            title={`Start (${w.nextStartMode})`}
            icon={Icon.Play}
            onAction={() =>
              runAction(
                "Start",
                () => startWorktree(w.repo, w.name),
                revalidate,
              )
            }
          />
        )}
        <Action
          title="Sync with Staging"
          icon={Icon.ArrowClockwise}
          onAction={() =>
            runAction("Sync", () => syncWorktree(w.repo, w.name), revalidate)
          }
        />
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action.OpenInBrowser
          title="Open in Browser"
          url={`http://${w.domain}`}
        />
        <Action.OpenInBrowser
          title="Open in Setu Portal"
          url={`http://quivly.local/worktree/${w.repo}/${encodeURIComponent(w.name)}`}
          icon={Icon.Globe}
        />
        {agents.length > 0 && (
          <ActionPanel.Submenu title="Open in Agent" icon={Icon.Terminal}>
            {agents.map((a) => (
              <Action
                key={a.id}
                title={a.label}
                onAction={() =>
                  runAction(
                    `Open in ${a.label}`,
                    () => openTool(w.repo, w.name, a.id),
                    revalidate,
                  )
                }
              />
            ))}
          </ActionPanel.Submenu>
        )}
        <Action.CopyToClipboard
          title="Copy Cd Command"
          content={`cd ~/workspace/${w.repo}/${w.name}`}
          shortcut={Keyboard.Shortcut.Common.Pin}
        />
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action
          title="Remove Worktree"
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={{ modifiers: ["ctrl"], key: "x" }}
          onAction={async () => {
            const confirmed = await confirmAlert({
              title: `Remove "${w.name}"?`,
              message:
                "The branch itself is not deleted — only the worktree checkout.",
              primaryAction: {
                title: "Remove",
                style: Alert.ActionStyle.Destructive,
              },
            });
            if (confirmed)
              runAction(
                "Remove",
                () => removeWorktree(w.repo, w.name),
                revalidate,
              );
          }}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

export default function Command() {
  const { isLoading, data, revalidate, error } = useCachedPromise(
    listWorktrees,
    [],
    { keepPreviousData: true },
  );
  const { data: agents } = useCachedPromise(listAgents, [], {
    initialData: [],
  });

  const sorted = useMemo(() => (data ? sortWorktrees(data) : []), [data]);
  const portalDown = error instanceof PortalUnreachableError;

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter by name, repo, or branch…"
    >
      {portalDown ? (
        <List.EmptyView
          icon={Icon.WifiDisabled}
          title="Setu portal isn't running"
          description="Start it, then reopen this command."
          actions={
            <ActionPanel>
              <Action.CopyToClipboard
                title="Copy 'Setu Portal'"
                content="setu portal"
              />
              <Action
                title="Retry"
                icon={Icon.ArrowClockwise}
                onAction={revalidate}
              />
            </ActionPanel>
          }
        />
      ) : (
        sorted.map((w) => {
          const status = statusOf(w);
          const accessories: List.Item.Accessory[] = [
            { tag: { value: status.text, color: status.tint } },
          ];
          if (w.dirty > 0)
            accessories.push({
              text: `${w.dirty} dirty`,
              icon: { source: Icon.Dot, tintColor: Color.Orange },
            });
          if (w.ahead > 0 || w.behind > 0) {
            accessories.push({
              text: `${w.ahead > 0 ? `↑${w.ahead}` : ""}${w.behind > 0 ? ` ↓${w.behind}` : ""}`.trim(),
            });
          }
          if (w.container)
            accessories.push({
              icon: Icon.Box,
              tooltip: "Running in a container",
            });

          return (
            <List.Item
              key={w.key}
              icon={{ source: Icon.Circle, tintColor: status.tint }}
              title={w.name}
              subtitle={w.label}
              accessories={accessories}
              actions={
                <WorktreeActions
                  w={w}
                  agents={agents ?? []}
                  revalidate={revalidate}
                />
              }
            />
          );
        })
      )}
    </List>
  );
}
