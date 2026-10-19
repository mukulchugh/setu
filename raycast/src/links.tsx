import { useRef, useState } from "react";
import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Cache,
  Detail,
  Form,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { PortalDownEmptyView } from "./components";
import {
  LinksMessage,
  LinksResult,
  LinksTarget,
  ManagedSession,
  PortalUnreachableError,
  linksAck,
  linksCapabilities,
  linksCancel,
  linksDirectory,
  linksInbox,
  linksMessage,
  linksRedeliver,
  linksSend,
  linksSendNow,
  linksShareAttention,
  linksShareDisable,
  linksShareEnable,
  linksShareStatus,
  linksStatus,
  listManagedSessions,
  listProjects,
  portalLinksUrl,
  portalWebUrl,
} from "./lib/api";
import {
  AttentionReview,
  DeliverySession,
  LinksTarget as ControllerTarget,
  RedeliveryReview,
  SendDraft,
  ShareReview,
  deliveryEligibility,
  directoryReachability,
  newSendDraft,
  safeFailureMessage,
  sameSendIntent,
  validAttentionReview,
  validRedeliveryReview,
  validShareReview,
  createSendController,
  refreshAfterSuccess,
} from "./lib/links-controller";

type Target = LinksTarget & ControllerTarget;

function newKey(): string {
  return `raycast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const uncertainSendCache = new Cache({ namespace: "setu-links-uncertain-sends" });
const draftCacheKey = (target: Target) =>
  `${target.repo}\u0000${target.name}\u0000${target.sessionId}`;
const sendController = createSendController({
  get(target) {
    const raw = uncertainSendCache.get(draftCacheKey(target));
    if (!raw) return undefined;
    try {
      const draft = JSON.parse(raw) as Partial<SendDraft>;
      return (
        typeof draft.body === "string" &&
        typeof draft.idempotencyKey === "string" &&
        draft.repo === target.repo &&
        draft.name === target.name &&
        draft.sessionId === target.sessionId
      )
        ? { ...target, body: draft.body, idempotencyKey: draft.idempotencyKey, ...(typeof draft.replyTo === "string" ? { replyTo: draft.replyTo } : {}) }
        : undefined;
    } catch {
      return undefined;
    }
  },
  remove(draft) {
    const key = draftCacheKey(draft);
    const current = this.get(draft);
    if (current && sameSendIntent(current, draft)) uncertainSendCache.remove(key);
  },
  set(draft) {
    uncertainSendCache.set(draftCacheKey(draft), JSON.stringify(draft));
  },
});

function time(value: number | null | undefined): string {
  return typeof value === "number" ? new Date(value).toLocaleString() : "Unknown";
}

function useLastSuccess<T extends LinksResult>(result: T | undefined): T | undefined {
  const last = useRef<T | undefined>(undefined);
  if (result?.ok) last.current = result;
  return last.current;
}

function readFailure(result: LinksResult | undefined, error: unknown): LinksResult | undefined {
  if (result && !result.ok) return result;
  return error ? { code: "LINKS_READ_FAILED", ok: false } : undefined;
}

function asTarget(session: ManagedSession): Target {
  return { name: session.name, repo: session.repo, sessionId: session.id };
}

function sessionDelivery(session: ManagedSession) {
  return deliveryEligibility({ ...session, ...asTarget(session) } as DeliverySession);
}

async function resultToast(label: string, result: LinksResult): Promise<boolean> {
  const toast = await showToast({ style: Toast.Style.Animated, title: `${label}…` });
  if (result.ok) {
    toast.style = Toast.Style.Success;
    toast.title = label;
    return true;
  }
  toast.style = Toast.Style.Failure;
  toast.title = result.code === "LINKS_OUTCOME_UNKNOWN" ? "Outcome not confirmed" : `${label} failed`;
  toast.message = safeFailureMessage(result);
  return false;
}

function bodyMarkdown(message: LinksMessage | undefined, status: LinksMessage | undefined): string {
  const current = message ?? status;
  if (!current) return "Loading message…";
  const body = message?.body ?? "Body unavailable. Refresh this detail view.";
  // Keep a message body visibly separate from Setu controls and metadata.
  const codeBody = body.replaceAll("```", "```\u200b");
  return `# Message ${current.messageId}

Source: local Setu Links service

## Delivery

| Field | Value |
| --- | --- |
| State | ${current.state} |
| Stored state | ${current.storedState} |
| Attempts | ${current.attempts} |
| Redeliveries | ${current.redeliveries} |
| Reply to | ${current.replyTo ?? "None"} |
| Recipient session | ${current.recipient.sessionId} |
| Provider | ${current.recipient.provider} |
| Run hint / reference | ${current.runHint ?? "None"} |
| Reason | ${current.reason ?? "None"} |
| Updated | ${time(current.updatedAt)} |

## Body

\`\`\`text
${codeBody}
\`\`\``;
}

function SendForm({ target, revalidate, replyTo }: { target: Target; revalidate: () => Promise<unknown>; replyTo?: string }) {
  const [draft, setDraft] = useState<SendDraft>(() =>
    sendController.recovered(target) ?? { ...newSendDraft(target, newKey()), ...(replyTo ? { replyTo } : {}) },
  );
  const [bodyError, setBodyError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const [recoveryError, setRecoveryError] = useState<string>();
  const recovered = sendController.recovered(target);

  const change = (change: Pick<SendDraft, "body" | "replyTo">) =>
    setDraft((current) => sendController.change(current, change, newKey()));

  async function submit(intent = draft) {
    if (!intent.body.trim()) {
      setBodyError("A message body is required");
      return;
    }
    const started = sendController.begin(intent);
    if (!started.ok) {
      setRecoveryError(
        started.reason === "in-flight"
          ? "A send for this session is already in progress."
          : started.reason === "unresolved"
            ? "An earlier unconfirmed send must be restored or retried before this changed draft can queue."
            : "Raycast could not save the exact send intent. Nothing was sent; retry after storage is available.",
      );
      return;
    }
    const submitted = intent;
    setSubmitting(true);
    let toast: Toast | undefined;
    let result: LinksResult = { code: "LINKS_OUTCOME_UNKNOWN", ok: false };
    try {
      try {
        toast = await showToast({ style: Toast.Style.Animated, title: "Queueing message…" });
      } catch {
        setRecoveryError("Message state will remain recoverable if the Raycast notification cannot be shown.");
      }
      try {
        result = await linksSend(submitted);
      } catch {
        result = { code: "LINKS_OUTCOME_UNKNOWN", ok: false };
      }
    } finally {
      const settled = sendController.finish(submitted, result);
      if (!settled)
        setRecoveryError("The send outcome is known, but Raycast could not clear its recovery record. Keep the original key if you retry.");
      setRecoveryVersion((version) => version + 1);
      setSubmitting(false);
    }
    if (result.ok) {
      // A response for an older draft may never clear text written while it was in flight.
      setDraft((current) =>
        sameSendIntent(current, submitted) ? newSendDraft(target, newKey()) : current,
      );
      try {
        if (toast) {
          toast.style = Toast.Style.Success;
          toast.title = `Queued ${result.messageId ?? "message"}`;
        }
        await revalidate();
      } catch {
        setRecoveryError("Message queued, but the inbox refresh failed. Refresh Links state before taking another action.");
      }
      return;
    }
    try {
      if (toast) {
        toast.style = Toast.Style.Failure;
        toast.title = result.code === "LINKS_OUTCOME_UNKNOWN" ? "Outcome not confirmed" : "Message not queued";
        toast.message = safeFailureMessage(result);
      }
    } catch {
      setRecoveryError("The message was not confirmed. Its original intent remains available for explicit recovery.");
    }
  }

  return (
    <Form
      navigationTitle="Send Links Message"
      actions={<ActionPanel>
        {!submitting && (!recovered || sameSendIntent(recovered, draft)) && <Action.SubmitForm title={recovered ? "Retry Unconfirmed Send" : "Queue Message"} onSubmit={() => submit()} />}
        {!submitting && recovered && !sameSendIntent(recovered, draft) && <>
          <Action title="Restore Original Unknown Send" onAction={() => { setDraft(recovered); setRecoveryError(undefined); }} />
          <Action title="Retry Original Unknown Send" onAction={() => submit(recovered)} />
        </>}
      </ActionPanel>}
    >
      <Form.Description title="Recipient" text={`${target.repo}/${target.name} · ${target.sessionId}`} />
      <Form.Description title="Delivery" text="The service verifies the current owned, running binding when it sends. This does not wake a session." />
      {draft.replyTo && <Form.Description title="Reply to" text={draft.replyTo} />}
      {recovered && <Form.Description title="Unconfirmed send" text={sameSendIntent(recovered, draft) ? `Original intent retained for explicit same-key retry. ${recoveryVersion > 0 ? "It was not sent automatically." : ""}` : "This changed draft cannot queue while the original outcome is unconfirmed. Restore or retry the original intent first."} />}
      {recoveryError && <Form.Description title="Send recovery" text={recoveryError} />}
      <Form.TextArea
        id="body"
        title="Message"
        value={draft.body}
        error={bodyError}
        onChange={(body) => {
          setBodyError(undefined);
          change({ body });
        }}
      />
    </Form>
  );
}

function RedeliveryReviewView({ target, messageId, attemptId, review, revalidate }: { target: Target; messageId: string; attemptId: string; review: Partial<RedeliveryReview>; revalidate: () => Promise<unknown> }) {
  const { pop } = useNavigation();
  const valid = validRedeliveryReview(review, target, messageId, attemptId);
  const [confirming, setConfirming] = useState(false);
  async function confirm() {
    if (!valid || confirming) return;
    setConfirming(true);
    try {
      const result = await linksRedeliver({ ...target, attemptId, messageId, confirmation: review.token });
      if (await resultToast("Redelivery queued", result)) {
        await revalidate();
        pop();
      }
    } finally { setConfirming(false); }
  }
  return (
    <Detail
      markdown={valid ? `# Review redelivery

The earlier handoff may have succeeded. Confirming can duplicate this message.

| Field | Value |
| --- | --- |
| Message | ${review.messageId} |
| Unknown attempt | ${review.attemptId} |
| Session | ${review.recipient.sessionId} |
| Provider | ${review.recipient.provider} |
| Native conversation | ${review.recipient.nativeId} |` : "# Review unavailable\n\nThe review is malformed or no longer matches this message and target. Refresh and review again."}
      actions={<ActionPanel>{valid && !confirming && <Action title="Confirm Possible Duplicate" style={Action.Style.Destructive} onAction={confirm} />}</ActionPanel>}
    />
  );
}

function MessageDetail({ target, messageId, revalidate }: { target: Target; messageId: string; revalidate: () => Promise<unknown> }) {
  const { push } = useNavigation();
  const detail = useCachedPromise(linksMessage, [messageId], { keepPreviousData: false });
  const state = useCachedPromise(linksStatus, [messageId], { keepPreviousData: false });
  const capabilities = useCachedPromise(linksCapabilities, [], { keepPreviousData: true });
  const lastMessage = useLastSuccess(detail.data);
  const lastStatus = useLastSuccess(state.data);
  const message = detail.data?.ok ? detail.data : lastMessage;
  const status = state.data?.ok ? state.data : lastStatus;
  const current = message ?? status;
  const failure = readFailure(detail.data, detail.error) ?? readFailure(state.data, state.error);
  const [mutating, setMutating] = useState(false);
  const refreshCurrent = async () => {
    await Promise.all([detail.revalidate(), state.revalidate(), revalidate()]);
  };

  async function mutate(label: string, action: () => Promise<LinksResult>) {
    if (mutating) return false;
    setMutating(true);
    try {
      const result = await refreshAfterSuccess(action, refreshCurrent);
      const ok = await resultToast(label, result);
      return ok;
    } finally { setMutating(false); }
  }

  async function redeliver() {
    if (!current?.attemptId || mutating) return;
    setMutating(true);
    try {
      const reviewed = await linksRedeliver({ ...target, attemptId: current.attemptId, messageId });
      if (reviewed.code === "LINKS_CONFIRMATION_REQUIRED") {
        push(<RedeliveryReviewView target={target} messageId={messageId} attemptId={current.attemptId} review={reviewed.confirmation ?? {}} revalidate={refreshCurrent} />);
        return;
      }
      await resultToast("Redelivery review", reviewed);
    } finally { setMutating(false); }
  }

  return (
    <Detail
      isLoading={detail.isLoading || state.isLoading}
      markdown={current ? `${failure ? `> Stale detail: ${safeFailureMessage(failure)}\n\n` : ""}${bodyMarkdown(message, status)}` : `# Message unavailable\n\n${safeFailureMessage(failure ?? { code: "LINKS_READ_FAILED" })}`}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            {current && <Action.Push title="Reply" target={<SendForm target={target} replyTo={messageId} revalidate={refreshCurrent} />} />}
            {current?.state === "handed-off" && !mutating && <Action title="Acknowledge" onAction={() => mutate("Acknowledged", () => linksAck({ ...target, messageId }))} />}
            {current?.state === "handoff-unknown" && current.attemptId && <Action title="Review Redelivery" style={Action.Style.Destructive} onAction={redeliver} />}
            {(["queued", "held"] as string[]).includes(current?.state ?? "") && <Action title="Cancel Message" style={Action.Style.Destructive} onAction={async () => {
              if (await confirmAlert({ title: "Cancel this message?", message: "Only queued or held mail can be retracted.", primaryAction: { title: "Cancel", style: Alert.ActionStyle.Destructive } })) {
                await mutate("Cancelled", () => linksCancel(messageId));
              }
            }} />}
          </ActionPanel.Section>
          <ActionPanel.Section>
            {current && !mutating && (capabilities.data?.wake?.available ? <Action title="Send Now" onAction={() => mutate("Send now", () => linksSendNow({ ...target, messageId }))} /> : <Action title="Send Now Unavailable" icon={Icon.ExclamationMark} onAction={async () => { await showToast({ style: Toast.Style.Failure, title: capabilities.data?.wake?.code ?? "Send now unavailable", message: capabilities.data?.wake?.error ?? "The service has not verified a wake mechanism." }); }} />)}
            <Action title="Refresh Message" icon={Icon.ArrowClockwise} onAction={refreshCurrent} />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function InboxView({ target }: { target: Target }) {
  const inbox = useCachedPromise(linksInbox, [target], { keepPreviousData: false });
  const revalidate = async () => { await inbox.revalidate(); };
  const success = useLastSuccess(inbox.data);
  const shown = inbox.data?.ok ? inbox.data : success;
  const failure = readFailure(inbox.data, inbox.error);
  const messages = shown?.messages ?? [];
  return (
    <List isLoading={inbox.isLoading} searchBarPlaceholder="Filter this exact session's messages…">
      {failure && !shown ? <List.EmptyView icon={Icon.ExclamationMark} title="Inbox unavailable" description={safeFailureMessage(failure)} /> : messages.length === 0 && !inbox.isLoading ? <List.EmptyView icon={Icon.Envelope} title="No messages for this session" description="This inbox is scoped to the exact managed session ID." /> : <>
        {failure && <List.Item icon={Icon.ExclamationMark} title="Inbox may be stale" subtitle={safeFailureMessage(failure)} />}
        <List.Section title={shown?.observed ? "Inbox (current binding compared)" : "Inbox (stored status only)"} subtitle={shown?.observed ? undefined : "Current delivery permission was not certified by this read."}>
          {messages.map((message) => <List.Item key={message.messageId} icon={Icon.Envelope} title={message.messageId} subtitle={message.replyTo ? `Reply to ${message.replyTo}` : message.sender.kind} accessories={[{ tag: message.state }, { text: `${message.attempts} attempts` }]} actions={<ActionPanel><Action.Push title="Open Message" target={<MessageDetail target={target} messageId={message.messageId} revalidate={revalidate} />} /><Action.Push title="Send Message" target={<SendForm target={target} revalidate={revalidate} />} /><Action title="Refresh Inbox" onAction={revalidate} /></ActionPanel>} />)}
        </List.Section>
      </>}
      <List.Section title="Actions"><List.Item icon={Icon.Plus} title="Send Message" subtitle="Queues mail for this exact session after a live service check" actions={<ActionPanel><Action.Push title="Send Message" target={<SendForm target={target} revalidate={revalidate} />} /></ActionPanel>} /></List.Section>
    </List>
  );
}

function ShareReviewView({ project, review, revalidate }: { project: string; review: Partial<ShareReview>; revalidate: () => Promise<unknown> }) {
  const { pop } = useNavigation();
  const valid = validShareReview(review, project);
  const [confirming, setConfirming] = useState(false);
  async function confirm() {
    if (!valid || confirming) return;
    setConfirming(true);
    try {
      const result = await linksShareEnable({ repo: project, owner: review.owner, confirmation: review.token });
      if (await resultToast("Sharing enabled", result)) { await revalidate(); pop(); }
    } finally { setConfirming(false); }
  }
  const markdown = valid ? `# Review project sharing

## Owner

${review.owner}

## Shared fields

${review.fields.map((field) => `- **${field.field}** (${field.keys.join(", ")}): ${field.meaning}`).join("\n")}

## Never shared

${review.never.map((item) => `- ${item}`).join("\n")}

## Permissions

${Object.entries(review.permissions).map(([name, enabled]) => `- ${name}: ${enabled ? "enabled" : "disabled"}`).join("\n")}` : "# Review unavailable\n\nThe review is malformed or no longer matches this project. Request a new review.";
  return <Detail markdown={markdown} actions={<ActionPanel>{valid && !confirming && <Action title="Confirm Sharing" onAction={confirm} />}</ActionPanel>} />;
}

function AttentionReviewView({ project, review, revalidate }: { project: string; review: Partial<AttentionReview>; revalidate: () => Promise<unknown> }) {
  const { pop } = useNavigation();
  const valid = validAttentionReview(review, project);
  const [confirming, setConfirming] = useState(false);
  async function confirm() {
    if (!valid || confirming) return;
    setConfirming(true);
    try {
      const result = await linksShareAttention({ repo: project, enabled: true, confirmation: review.token });
      if (await resultToast("Attention enabled", result)) { await revalidate(); pop(); }
    } finally { setConfirming(false); }
  }
  return <Detail markdown={valid ? `# Review attention requests

${review.effect}

## Never

${review.never.map((item) => `- ${item}`).join("\n")}` : "# Review unavailable\n\nThe review is malformed or no longer matches this project. Request a new review."} actions={<ActionPanel>{valid && !confirming && <Action title="Confirm Attention" onAction={confirm} />}</ActionPanel>} />;
}

function ProjectSettings({ project }: { project: string }) {
  const { push } = useNavigation();
  const sharing = useCachedPromise((repo: string) => linksShareStatus(repo), [project], { keepPreviousData: true });
  const lastSharing = useLastSuccess(sharing.data);
  const current = sharing.data?.ok ? sharing.data : lastSharing;
  const failure = readFailure(sharing.data, sharing.error);
  const policy = current?.policy;
  const [mutating, setMutating] = useState(false);
  const refresh = async () => { await sharing.revalidate(); };
  async function mutate(label: string, action: () => Promise<LinksResult>) {
    if (mutating) return false;
    setMutating(true);
    try {
      const result = await refreshAfterSuccess(action, refresh);
      const ok = await resultToast(label, result);
      return ok;
    } finally { setMutating(false); }
  }
  async function reviewSharing() {
    if (mutating) return;
    const result = await linksShareEnable({ repo: project });
    if (result.code === "LINKS_CONFIRMATION_REQUIRED") {
      push(<ShareReviewView project={project} review={result.confirmation ?? {}} revalidate={refresh} />);
      return;
    }
    await resultToast("Sharing review", result);
  }
  async function reviewAttention() {
    if (mutating) return;
    const result = await linksShareAttention({ repo: project, enabled: true });
    if (result.code === "LINKS_CONFIRMATION_REQUIRED") {
      push(<AttentionReviewView project={project} review={result.confirmation ?? {}} revalidate={refresh} />);
      return;
    }
    await resultToast("Attention review", result);
  }
  if (failure && !current) return <Detail markdown={`# ${project}\n\nSharing status is unavailable.\n\n${safeFailureMessage(failure)}`} actions={<ActionPanel><Action title="Refresh Sharing" onAction={refresh} /></ActionPanel>} />;
  const unavailable = current?.state === "invalid";
  return <Detail markdown={`# ${project}

Source: local Setu Links service

${failure ? `> Stale policy: ${safeFailureMessage(failure)}\n` : ""}${unavailable ? `> Policy unreadable: ${safeFailureMessage(current ?? { code: "LINKS_POLICY_INVALID" })}\n` : ""}

| Policy | Value |
| --- | --- |
| Sharing | ${policy ? "enabled" : unavailable ? "unknown" : "disabled"} |
| Receive | ${policy?.receive ?? false} |
| Visibility | ${policy?.visibility ?? false} |
| Attention | ${policy?.attention ?? false} |
| Interrupt | ${policy?.interrupt ?? false} |`} actions={<ActionPanel>
    {!policy && !unavailable && !mutating ? <Action title="Review Sharing" onAction={reviewSharing} /> : policy ? <>
      {!mutating && <Action title={policy.attention ? "Disable Attention" : "Review Attention"} onAction={async () => {
        if (policy.attention) {
          await mutate("Attention disabled", () => linksShareAttention({ repo: project, enabled: false }));
        } else await reviewAttention();
      }} />}
      {!mutating && <Action title="Disable Sharing" style={Action.Style.Destructive} onAction={async () => {
        if (await confirmAlert({ title: `Disable sharing for ${project}?`, message: "This withdraws directory visibility and receiving permission.", primaryAction: { title: "Disable Sharing", style: Alert.ActionStyle.Destructive } })) {
          await mutate("Sharing disabled", () => linksShareDisable(project));
        }
      }} />}
    </> : null}
    <Action title="Refresh Sharing" icon={Icon.ArrowClockwise} onAction={refresh} />
  </ActionPanel>} />;
}

export default function Command() {
  const data = useCachedPromise(async () => Promise.all([listManagedSessions(), linksDirectory(), linksShareStatus(), listProjects()]), [], { keepPreviousData: false });
  const refresh = async () => { await data.revalidate(); };
  const [sessionsResult, directory, sharing, projects] = data.data ?? [];
  const sessions = sessionsResult?.ok ? sessionsResult.sessions ?? [] : [];

  if (data.error instanceof PortalUnreachableError) return <List><PortalDownEmptyView onRetry={refresh} /></List>;
  if (data.error) return <List><List.EmptyView icon={Icon.ExclamationMark} title="Links unavailable" description="Refresh the local portal response before acting." actions={<ActionPanel><Action title="Refresh Links State" onAction={refresh} /></ActionPanel>} /></List>;

  return <List isLoading={data.isLoading} searchBarPlaceholder="Search managed sessions, shared directory, or projects…">
    {sessionsResult && !sessionsResult.ok && <List.Item icon={Icon.ExclamationMark} title="Managed sessions unavailable" subtitle={safeFailureMessage(sessionsResult)} actions={<ActionPanel><Action title="Refresh Links State" onAction={refresh} /></ActionPanel>} />}
    {sessions.length > 0 && <List.Section title="My managed sessions" subtitle="Select an exact session ID. The service remains the delivery authority.">
      {sessions.map((session) => {
        const target = asTarget(session);
        const delivery = sessionDelivery(session);
        return <List.Item key={session.id} icon={{ source: Icon.Terminal, tintColor: delivery.available ? Color.Green : Color.Orange }} title={`${session.repo}/${session.name}`} subtitle={session.id} accessories={[{ tag: delivery.available ? "Eligible to verify" : "Delivery unavailable" }]} actions={<ActionPanel>
          <Action.Push title="Open Inbox" target={<InboxView target={target} />} />
          {delivery.available ? <Action.Push title="Send Message" target={<SendForm target={target} revalidate={refresh} />} /> : <Action title="Why Delivery Is Unavailable" onAction={async () => { await showToast({ style: Toast.Style.Failure, title: "Delivery unavailable", message: delivery.reason }); }} />}
          <Action.OpenInBrowser title="Open Attention in Setu Portal" url={portalWebUrl({ name: session.name, repo: session.repo })} />
          <Action.CopyToClipboard title="Copy Session ID" content={session.id} />
        </ActionPanel>} />;
      })}
    </List.Section>}
    <List.Section title="Shared directory" subtitle="Presence is informational; stale and unreachable entries never certify delivery.">
      {directory && !directory.ok ? <List.Item icon={Icon.ExclamationMark} title="Shared directory unavailable" subtitle={safeFailureMessage(directory)} actions={<ActionPanel><Action title="Refresh Links State" onAction={refresh} /></ActionPanel>} /> : <>
      {(directory?.entries ?? []).map((entry) => <List.Item key={`${entry.project}:${entry.sessionId}`} icon={{ source: Icon.Circle, tintColor: entry.stale || entry.reachability.state !== "reachable" ? Color.Orange : Color.Green }} title={`${entry.project} · ${entry.owner}`} subtitle={entry.task ?? "No task label"} accessories={[{ tag: directoryReachability(entry) }, { text: entry.sessionId }]} actions={<ActionPanel><Action.CopyToClipboard title="Copy Session ID" content={entry.sessionId} /><Action.CopyToClipboard title="Copy Project" content={entry.project} /></ActionPanel>} />)}
      {(directory?.problems ?? []).map((problem) => <List.Item key={`problem:${problem.project}`} icon={Icon.ExclamationMark} title={`${problem.project}: policy unavailable`} subtitle={problem.recovery ?? problem.reason} />)}
      {!data.isLoading && (directory?.entries ?? []).length === 0 && <List.Item icon={Icon.Person} title="No shared sessions" subtitle="Enable project sharing to publish eligible managed-session presence." />}</>}
    </List.Section>
    <List.Section title="Project sharing">
      {sharing && !sharing.ok && <List.Item icon={Icon.ExclamationMark} title="Sharing status unavailable" subtitle={safeFailureMessage(sharing)} actions={<ActionPanel><Action title="Refresh Links State" onAction={refresh} /></ActionPanel>} />}
      {(projects ?? []).map((project) => <List.Item key={project.name} icon={Icon.Lock} title={project.label} subtitle={project.name} accessories={[{ tag: sharing?.ok && sharing.projects?.find((item) => item.project === project.name)?.shared ? "Shared" : sharing?.ok ? "Not shared" : "Unknown" }]} actions={<ActionPanel><Action.Push title="Open Project Sharing" target={<ProjectSettings project={project.name} />} /></ActionPanel>} />)}
    </List.Section>
    <List.Section title="Recovery"><List.Item icon={Icon.ArrowClockwise} title="Refresh Links State" subtitle="Inspect current service state before retrying any unknown outcome." actions={<ActionPanel><Action title="Refresh Links State" onAction={refresh} /><Action.OpenInBrowser title="Open Setu Portal" url={portalLinksUrl()} /></ActionPanel>} /></List.Section>
  </List>;
}
