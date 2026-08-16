import { useMemo } from "react";
import {
  Action,
  ActionPanel,
  Color,
  Icon,
  LaunchProps,
  List,
  open,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { PortalDownEmptyView } from "./components";
import {
  PortalUnreachableError,
  Worktree,
  listWorktrees,
  portalWebUrl,
} from "./lib/api";

// The Raycast-native equivalent of the portal's own ⌘K command bar — type a
// name, jump straight to the worktree's local domain, no list-browsing UI.
function matches(w: Worktree, needle: string): boolean {
  const n = needle.toLowerCase();
  return `${w.name} ${w.repo} ${w.label} ${w.domain}`.toLowerCase().includes(n);
}

export default function Command(
  props: LaunchProps<{ arguments: Arguments.QuickOpen }>,
) {
  const { data, isLoading, error, revalidate } = useCachedPromise(
    listWorktrees,
    [],
    { keepPreviousData: true },
  );
  const query = props.arguments.query ?? "";

  const results = useMemo(() => {
    if (!data) return [];
    const filtered = query.trim()
      ? data.filter((w) => matches(w, query.trim()))
      : data;
    return filtered.slice(0, 8);
  }, [data, query]);

  if (error instanceof PortalUnreachableError) {
    return (
      <List>
        <PortalDownEmptyView onRetry={revalidate} />
      </List>
    );
  }

  return (
    <List
      isLoading={isLoading}
      searchText={query}
      searchBarPlaceholder="worktree name…"
    >
      {results.map((w) => (
        <List.Item
          key={w.key}
          icon={{
            source: Icon.Circle,
            tintColor: w.active ? Color.Green : Color.SecondaryText,
          }}
          title={w.name}
          subtitle={w.label}
          accessories={[{ text: w.domain }]}
          actions={
            <ActionPanel>
              <Action
                title="Open"
                onAction={() => open(`http://${w.domain}`)}
              />
              <Action.OpenInBrowser
                title="Open in Setu Portal"
                url={portalWebUrl(w)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
