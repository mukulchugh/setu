# Setu

Setu connects development worktrees, agent sessions and the work recorded in Spans.

## Language

**Worktree**:
A particular checkout of a repository in which local development takes place.
_Avoid_: Project when referring to one checkout.

**Writer claim**:
The recorded ownership of a worktree's editing slot by one session. It coordinates cooperating writers and is not a filesystem security boundary.
_Avoid_: Presence, distributed lock.

**Managed session**:
An agent session launched and tracked by Setu with evidence of its local process and checkout identity.
_Avoid_: Any discovered agent, transcript.

**Native conversation**:
The conversation identified by the agent provider, which may survive an individual process or terminal.
_Avoid_: Terminal, process, branch.

**Run**:
A body of work in Spans with a goal and a plan composed of spans.
_Avoid_: Session when referring to the work itself.

**Span**:
A unit of planned work within a run, with dependencies on other spans where required.
_Avoid_: Message, process.

**Attempt**:
One execution effort associated with a span's action. A replacement attempt is distinct from a resumed observation of the same effort.
_Avoid_: Run when referring to one execution attempt.

**Accepted completion**:
A span result accepted against its required evidence, allowing dependent work to become ready.
_Avoid_: Process exit, message delivered, reported success.

**Attention item**:
A recorded condition requiring a person's attention or decision.
_Avoid_: Approval when attention alone has been requested.

**Shared project**:
A project explicitly enabled for collaboration, whose managed sessions become discoverable with the selected identity and task information. Sharing a project does not share its transcripts.
_Avoid_: Shared filesystem, public repository.

**Queued message**:
A message waiting for delivery to its intended conversation at an eligible agent turn.
_Avoid_: Delivered, read, accepted completion.

**Agent wake**:
Starting a new agent turn to process an incoming message, which may consume usage. Only the receiving user authorizes a wake.
_Avoid_: Notification, inbox arrival.

**Routine message**:
Text exchanged by agents in shared projects with invited teammates, without requiring approval for each message.
_Avoid_: File sharing, execution authorization.

**Attention request**:
A request to notify a person that their input is needed. It neither wakes their agent nor grants permission to execute work.
_Avoid_: Agent wake, approval.
