import { useMemo, useRef, useState } from "react";
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
import { PortalDownEmptyView } from "./components";
import {
  ActionResult,
  Agent,
  PortalUnreachableError,
  Worktree,
  getStatus,
  listAgents,
  listWorktrees,
  openTool,
  portalWebUrl,
  portalRecoveryUrl,
  removeWorktree,
  startWorktree,
  stopWorktree,
  syncWorktree,
} from "./lib/api";

function statusOf(w: Worktree): { text: string; tint: Color } {
  if (w.stopping) return { text: "Stopping", tint: Color.Orange };
  if (w.starting) return { text: "Starting", tint: Color.Orange };
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
      Number(b.active || b.starting || b.stopping) -
        Number(a.active || a.starting || a.stopping) ||
      Number(!!b.queued) - Number(!!a.queued),
  );
}

export async function runAction(
  label: string,
  action: () => Promise<ActionResult>,
  revalidate: () => void | Promise<unknown>,
) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `${label}…`,
  });
  try {
    const res = await action();
    if (res.ok !== true) {
      toast.style = Toast.Style.Failure;
      toast.title =
        res.removed === true
          ? "Worktree removed; cleanup pending"
          : res.networkUncertain
            ? "Outcome not confirmed"
            : `${label} failed`;
      toast.message = [
        res.error,
        res.operationId
          ? `Operation ${res.operationId}. Open Cleanup pending to retry this operation.`
          : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    } else {
      toast.style = Toast.Style.Success;
      toast.title = res.queued
        ? `Queued (position ${res.position})`
        : label === "Start"
          ? "Starting"
          : `${label} done`;
    }
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = `${label} failed`;
    toast.message = e instanceof PortalUnreachableError ? e.message : String(e);
  }
  try {
    await revalidate();
  } catch {
    toast.message =
      `${toast.message ?? ""} Status refresh failed. Retry the status read before another action.`.trim();
  }
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
        {!w.stopping &&
          (w.active || w.starting || w.queued ? (
            <Action
              title={w.queued ? "Cancel Queued Start" : "Stop"}
              icon={Icon.Stop}
              onAction={() =>
                runAction(
                  "Stop",
                  () => stopWorktree(w.repo, w.name),
                  revalidate,
                )
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
          ))}
        <Action
          title="Sync with Base Branch"
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
          url={portalWebUrl(w)}
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
  const {
    data: status,
    revalidate: revalidateStatus,
    error: statusError,
    isLoading: statusLoading,
  } = useCachedPromise(getStatus, [], { keepPreviousData: true });
  const { data: agents } = useCachedPromise(listAgents, [], {
    initialData: [],
  });
  const [search, setSearch] = useState("");
  const pendingRequests = useRef(new Set<string>());
  const sorted = useMemo(() => (data ? sortWorktrees(data) : []), [data]);
  const pending = status?.pendingRemovals ?? [];
  const active = sorted.filter(
    (w) => w.active || w.starting || w.stopping || w.queued,
  );
  const stopped = sorted.filter(
    (w) => !(w.active || w.starting || w.stopping || w.queued),
  );
  const query = search.trim().toLowerCase();
  const visibleStopped = stopped.filter((w) =>
    `${w.name} ${w.repo} ${w.label}`.toLowerCase().includes(query),
  );
  const refresh = async () => {
    await Promise.allSettled([revalidate(), revalidateStatus()]);
  };

  const worktreeItem = (w: Worktree) => {
    const current = statusOf(w);
    const accessories: List.Item.Accessory[] = [
      { tag: { value: current.text, color: current.tint } },
    ];
    if ((w.dirty ?? 0) > 0)
      accessories.push({
        text: `${w.dirty} dirty`,
        icon: { source: Icon.Dot, tintColor: Color.Orange },
      });
    if (w.ahead > 0 || w.behind > 0)
      accessories.push({
        text: `${w.ahead > 0 ? `↑${w.ahead}` : ""}${w.behind > 0 ? ` ↓${w.behind}` : ""}`.trim(),
      });
    if (w.container)
      accessories.push({ icon: Icon.Box, tooltip: "Running in a container" });
    return (
      <List.Item
        key={w.key}
        icon={{ source: Icon.Circle, tintColor: current.tint }}
        title={w.name}
        subtitle={w.label}
        accessories={accessories}
        actions={
          <WorktreeActions w={w} agents={agents ?? []} revalidate={refresh} />
        }
      />
    );
  };

  return (
    <List
      isLoading={isLoading || statusLoading}
      filtering={false}
      searchText={search}
      onSearchTextChange={setSearch}
      searchBarPlaceholder="Filter stopped worktrees; active work and cleanup always shown…"
    >
      {error instanceof PortalUnreachableError &&
      !data?.length &&
      !pending.length ? (
        <PortalDownEmptyView onRetry={refresh} />
      ) : (
        <>
          {(error ||
            statusError ||
            (!statusLoading && !Array.isArray(status?.pendingRemovals))) && (
            <List.Section title="Status">
              <List.Item
                icon={Icon.ExclamationMark}
                title={
                  error
                    ? "Worktree status unavailable"
                    : statusError
                      ? "Cleanup status unavailable"
                      : "Cleanup status not reported by this portal"
                }
                subtitle={
                  error || statusError
                    ? "Retained results may be out of date. Retry the status read."
                    : "Open the portal to inspect removal recovery."
                }
                actions={
                  <ActionPanel>
                    <Action
                      title="Refresh Status"
                      icon={Icon.ArrowClockwise}
                      onAction={refresh}
                    />
                    <Action.OpenInBrowser
                      title="Open Setu Portal"
                      url={portalRecoveryUrl()}
                    />
                  </ActionPanel>
                }
              />
            </List.Section>
          )}
          <List.Section
            title="Active work"
            subtitle={`${active.length} across all projects · always shown`}
          >
            {active.map(worktreeItem)}
          </List.Section>
          {pending.length > 0 && (
            <List.Section
              title="Cleanup pending"
              subtitle={`${pending.length} operations · always shown`}
            >
              {pending.map((operation) => (
                <List.Item
                  key={operation.operationId}
                  icon={{
                    source: Icon.ExclamationMark,
                    tintColor: Color.Orange,
                  }}
                  title={`${operation.repo}/${operation.name}`}
                  subtitle={
                    operation.removed === true
                      ? "Worktree removed; cleanup pending"
                      : operation.removed === null
                        ? "Removal outcome unknown"
                        : "Removal not completed"
                  }
                  accessories={[
                    { text: operation.pendingSteps.join(", ") },
                    { text: operation.operationId, tooltip: operation.error },
                  ]}
                  actions={
                    <ActionPanel>
                      <Action
                        title="Retry This Cleanup"
                        icon={Icon.ArrowClockwise}
                        onAction={async () => {
                          if (
                            pendingRequests.current.has(operation.operationId)
                          )
                            return;
                          pendingRequests.current.add(operation.operationId);
                          try {
                            await runAction(
                              "Cleanup",
                              () =>
                                removeWorktree(
                                  operation.repo,
                                  operation.name,
                                  operation.operationId,
                                ),
                              refresh,
                            );
                          } finally {
                            pendingRequests.current.delete(
                              operation.operationId,
                            );
                          }
                        }}
                      />
                      <Action
                        title="Refresh Status"
                        icon={Icon.ArrowClockwise}
                        onAction={refresh}
                      />
                      <Action.CopyToClipboard
                        title="Copy Operation ID"
                        content={operation.operationId}
                      />
                      <Action.OpenInBrowser
                        title="Open Cleanup in Setu Portal"
                        url={portalRecoveryUrl()}
                      />
                    </ActionPanel>
                  }
                />
              ))}
            </List.Section>
          )}
          <List.Section
            title="Stopped worktrees"
            subtitle={`${visibleStopped.length} of ${stopped.length} · search applies here`}
          >
            {visibleStopped.map(worktreeItem)}
          </List.Section>
        </>
      )}
    </List>
  );
}
