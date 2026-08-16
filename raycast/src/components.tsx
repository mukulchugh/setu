import { Action, ActionPanel, Icon, List } from "@raycast/api";

// Shared "Setu portal isn't running" empty state. Both list-worktrees and
// quick-open hit this whenever the portal is unreachable, and both wire
// onRetry to their own revalidate. It stays optional on the prop type
// rather than required, since a future caller of this view isn't
// guaranteed to have a revalidate function to hand it.
export function PortalDownEmptyView({ onRetry }: { onRetry?: () => void }) {
  return (
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
          {onRetry && (
            <Action
              title="Retry"
              icon={Icon.ArrowClockwise}
              onAction={onRetry}
            />
          )}
        </ActionPanel>
      }
    />
  );
}
