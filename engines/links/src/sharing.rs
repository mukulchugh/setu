//! Sharing policy: the one authority over which projects are shared. A project that is not shared admits
//! nothing from any principal but the local user, and a policy the engine cannot read admits nothing either.

use crate::{
    args::{Args, Fail},
    store::{SHARING_SCHEMA, Store, commit},
    util,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};

/// The only policy format this engine writes or reads.
pub const POLICY_VERSION: i64 = 1;
pub const MAX_PROJECT_BYTES: usize = 128;
pub const MAX_OWNER_CHARS: usize = 64;

/// What a stored policy says. `attention` is its own opt-in (off until the user reviews and enables it).
/// `interrupt` is carried so it is recorded as off; this version never grants it, and a policy that says
/// otherwise is not one it understands.
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    /// Opaque, minted when sharing is enabled and gone when it is withdrawn. Anything that refers to the
    /// project from outside this machine (a peer grant) names this scope, never the local project name.
    pub scope: String,
    pub owner: String,
    pub visibility: bool,
    pub receive: bool,
    pub attention: bool,
}

impl Policy {
    fn to_json(&self) -> Value {
        json!({
            "version": POLICY_VERSION,
            "scope": self.scope,
            "owner": self.owner,
            "visibility": self.visibility,
            "receive": self.receive,
            "interrupt": false,
            "attention": self.attention,
        })
    }

    /// Exactly the shape this version writes; anything else is unreadable rather than guessed at.
    fn parse(text: &str) -> Option<Policy> {
        let Value::Object(fields) = serde_json::from_str::<Value>(text).ok()? else { return None };
        let exact = ["attention", "interrupt", "owner", "receive", "scope", "version", "visibility"];
        let mut keys: Vec<_> = fields.keys().map(String::as_str).collect();
        keys.sort_unstable();
        if keys != exact || fields["version"] != POLICY_VERSION || fields["interrupt"] != false {
            return None;
        }
        let owner = fields["owner"].as_str()?;
        if !owner_is_valid(owner) {
            return None;
        }
        let scope = fields["scope"].as_str()?;
        if !scope_is_valid(scope) {
            return None;
        }
        Some(Policy {
            scope: scope.to_string(),
            owner: owner.to_string(),
            visibility: fields["visibility"].as_bool()?,
            receive: fields["receive"].as_bool()?,
            attention: fields["attention"].as_bool()?,
        })
    }
}

/// What the engine knows about one project's sharing.
#[derive(Debug)]
pub enum Standing {
    Absent,
    Valid(Policy, i64),
    /// Present but unreadable: delivery from other principals stays off until it is replaced or removed.
    Invalid(&'static str),
}

fn scope_is_valid(scope: &str) -> bool {
    scope.strip_prefix("ps_").is_some_and(|hex| hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// An owner label is one short printable line that carries no path, environment reference or secret.
pub fn owner_is_valid(owner: &str) -> bool {
    !owner.is_empty() && util::one_line(owner, MAX_OWNER_CHARS) == owner && !util::unsafe_label(owner)
}

pub(crate) fn project_arg(args: &mut Args) -> Result<String, Fail> {
    let project = args.string("project", MAX_PROJECT_BYTES)?;
    if util::one_line(&project, MAX_PROJECT_BYTES) != project {
        return Err(Fail::new("REQUEST_INVALID", "field `project` is missing or invalid"));
    }
    Ok(project)
}

/// A project's standing, read from the store as it is. A version 1 store has no policies.
pub fn standing(db: &rusqlite::Connection, version: i64, project: &str) -> Result<Standing, Fail> {
    if version < SHARING_SCHEMA {
        return Ok(Standing::Absent);
    }
    let row: Option<(i64, String, i64)> = db
        .query_row("SELECT version, policy, updated_at FROM sharing_policies WHERE project = ?1", [project], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()?;
    Ok(match row {
        None => Standing::Absent,
        Some((version, _, _)) if version != POLICY_VERSION => Standing::Invalid("unsupported-version"),
        Some((_, text, updated_at)) => match Policy::parse(&text) {
            Some(policy) => Standing::Valid(policy, updated_at),
            None => Standing::Invalid("malformed"),
        },
    })
}

/// Whether the store holds any policy row for the project, readable or not.
pub fn has_row(store: &Store, project: &str) -> Result<bool, Fail> {
    Ok(store.has_sharing() && store.db.query_row("SELECT EXISTS (SELECT 1 FROM sharing_policies WHERE project = ?1)", [project], |row| row.get(0))?)
}

pub fn not_shared(project: &str) -> Fail {
    Fail::new("NOT_SHARED", "this project is not shared").with(json!({ "project": project }))
}

/// Why mail from another principal is held: the policy is unreadable, or the project is not shared.
pub fn hold_reason(refusal: &Fail) -> &'static str {
    if refusal.code == "POLICY_INVALID" { "policy-invalid" } else { "policy-disabled" }
}

fn optional_project(args: &mut Args) -> Result<Option<String>, Fail> {
    match args.optional_string("project", MAX_PROJECT_BYTES)? {
        Some(project) if util::one_line(&project, MAX_PROJECT_BYTES) == project => Ok(Some(project)),
        Some(_) => Err(Fail::new("REQUEST_INVALID", "field `project` is missing or invalid")),
        None => Ok(None),
    }
}

pub fn invalid_policy(project: &str, reason: &str) -> Fail {
    Fail::new("POLICY_INVALID", "the sharing policy for this project cannot be read; delivery from other principals is disabled until it is replaced or removed")
        .with(json!({ "project": project, "reason": reason }))
}

pub struct EnableRequest {
    project: String,
    owner: String,
}

pub fn parse_enable(mut args: Args) -> Result<EnableRequest, Fail> {
    let project = project_arg(&mut args)?;
    let owner = args.string("owner", MAX_OWNER_CHARS * 4)?;
    if !owner_is_valid(&owner) {
        return Err(Fail::new("REQUEST_INVALID", "field `owner` is missing or invalid"));
    }
    args.finish()?;
    Ok(EnableRequest { project, owner })
}

/// Records visibility and receiving for one project, replacing any earlier or unreadable policy.
pub fn enable(store: &mut Store, request: EnableRequest) -> Result<Value, Fail> {
    let EnableRequest { project, owner } = request;
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<(i64, String)> =
        tx.query_row("SELECT version, policy FROM sharing_policies WHERE project = ?1", [&project], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
    // The scope belongs to the project's sharing, not to its display label: enabling again, even with a
    // different owner label, keeps it. Only a first enable, a replaced unreadable policy or a re-enable after
    // a withdrawal mints a new one, so grants made to the old scope stop matching.
    let earlier = match &existing {
        Some((POLICY_VERSION, text)) => Policy::parse(text),
        _ => None,
    };
    let policy = Policy {
        scope: earlier.as_ref().map_or_else(|| util::new_id("ps"), |p| p.scope.clone()),
        owner,
        visibility: true,
        receive: true,
        // Enabling the same share again is not a new decision about attention; a new share starts without it.
        attention: earlier.as_ref().is_some_and(|p| p.attention),
    };
    let changed = earlier.as_ref() != Some(&policy);
    // Mail a withdrawn policy was holding is queued again, unless it has expired meanwhile.
    let released = release_held(&tx, &project, now)?;
    if changed {
        tx.execute(
            "INSERT INTO sharing_policies (project, version, policy, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (project) DO UPDATE SET version = excluded.version, policy = excluded.policy, updated_at = excluded.updated_at",
            params![project, POLICY_VERSION, policy.to_json().to_string(), now],
        )?;
    }
    commit(tx, "share_enable")?;
    Ok(json!({ "project": project, "changed": changed, "policy": policy.to_json(), "released": released }))
}

pub struct AttentionRequest {
    project: String,
    enabled: bool,
    /// The scope the user reviewed. Enabling names it; switching off is a revocation and needs none.
    scope: Option<String>,
}

impl AttentionRequest {
    pub fn project(&self) -> &str {
        &self.project
    }
}

pub fn parse_attention(mut args: Args) -> Result<AttentionRequest, Fail> {
    let project = project_arg(&mut args)?;
    let enabled = match args.take("enabled") {
        Some(Value::Bool(enabled)) => enabled,
        _ => return Err(Fail::new("REQUEST_INVALID", "field `enabled` is missing or invalid")),
    };
    let scope = args.optional_string("scope", 64)?;
    if enabled && scope.is_none() {
        return Err(Fail::new("REQUEST_INVALID", "field `scope` is missing or invalid"));
    }
    args.finish()?;
    Ok(AttentionRequest { project, enabled, scope })
}

/// Turns attention on or off for a shared project, keeping its scope, owner and every other permission. The
/// project must have a readable policy; an unreadable one is never repaired here.
pub fn set_attention(store: &mut Store, request: AttentionRequest) -> Result<Value, Fail> {
    let AttentionRequest { project, enabled, scope } = request;
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut policy = match standing(&tx, store.version, &project)? {
        Standing::Valid(policy, _) => policy,
        Standing::Invalid(reason) => return Err(invalid_policy(&project, reason)),
        Standing::Absent => return Err(not_shared(&project)),
    };
    // What was reviewed is what is changed: a share withdrawn and made again since the review has a new scope.
    if enabled && scope.as_deref() != Some(policy.scope.as_str()) {
        return Err(Fail::new("SCOPE_CHANGED", "the project's sharing changed since it was reviewed; review it again").with(json!({ "project": project })));
    }
    let changed = policy.attention != enabled;
    policy.attention = enabled;
    if changed {
        tx.execute(
            "UPDATE sharing_policies SET policy = ?2, updated_at = ?3 WHERE project = ?1",
            params![project, policy.to_json().to_string(), now],
        )?;
        commit(tx, "share_attention")?;
    }
    Ok(json!({ "project": project, "changed": changed, "policy": policy.to_json() }))
}

fn release_held(db: &rusqlite::Connection, project: &str, now: i64) -> Result<Vec<String>, Fail> {
    let released = db
        .prepare(
            "UPDATE deliveries SET state = 'queued', reason = NULL, updated_at = ?2
             WHERE state = 'held' AND reason IN ('policy-disabled', 'policy-invalid') AND expires_at > ?2
               AND message_id IN (SELECT id FROM messages WHERE project = ?1)
             RETURNING message_id",
        )?
        .query_map(params![project, now], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(released)
}

pub fn parse_disable(mut args: Args) -> Result<String, Fail> {
    let project = project_arg(&mut args)?;
    args.finish()?;
    Ok(project)
}

/// Withdraws a project's sharing, whatever the policy says (including an unreadable one).
pub fn disable(store: &mut Store, project: String) -> Result<Value, Fail> {
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let removed = tx.execute("DELETE FROM sharing_policies WHERE project = ?1", [&project])? > 0;
    tx.execute("DELETE FROM presence WHERE project = ?1", [&project])?;
    // Mail already queued from another principal waits, visibly, until the project is shared again.
    let held = tx
        .prepare(
            "UPDATE deliveries SET state = 'held', reason = 'policy-disabled', updated_at = ?2
             WHERE state = 'queued' AND message_id IN (SELECT id FROM messages WHERE project = ?1 AND sender != 'user')
             RETURNING message_id",
        )?
        .query_map(params![project, util::now_ms()], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    commit(tx, "share_disable")?;
    Ok(json!({ "project": project, "removed": removed, "held": held }))
}

fn project_json(project: &str, standing: Standing) -> Value {
    match standing {
        Standing::Absent => json!({ "project": project, "state": "absent" }),
        Standing::Valid(policy, updated_at) => json!({ "project": project, "state": "enabled", "policy": policy.to_json(), "updated_at": updated_at }),
        Standing::Invalid(reason) => json!({
            "project": project,
            "state": "invalid",
            "error": { "code": "POLICY_INVALID", "reason": reason },
        }),
    }
}

/// One project, or every project that has a policy row. Passive: it never creates or writes a store.
pub fn status(store: Option<&Store>, mut args: Args) -> Result<Value, Fail> {
    let project = optional_project(&mut args)?;
    args.finish()?;
    let Some(store) = store else {
        return Ok(json!({ "projects": project.map(|p| vec![project_json(&p, Standing::Absent)]).unwrap_or_default() }));
    };
    if let Some(project) = project {
        return Ok(json!({ "projects": [project_json(&project, standing(&store.db, store.version, &project)?)] }));
    }
    Ok(json!({ "projects": policy_projects(store)?.iter().map(|name| Ok(project_json(name, standing(&store.db, store.version, name)?))).collect::<Result<Vec<_>, Fail>>()? }))
}

/// Every project that has a policy row, in name order.
pub fn policy_projects(store: &Store) -> Result<Vec<String>, Fail> {
    if !store.has_sharing() {
        return Ok(Vec::new());
    }
    let mut statement = store.db.prepare("SELECT project FROM sharing_policies ORDER BY project")?;
    let names = statement.query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

/// How long an observation counts as current. Publishing is periodic, so a few missed rounds still read as
/// live while an old one never does. Tunable; not a product decision.
pub const STALE_AFTER_MS: i64 = 2 * 60 * 1000;
/// Presence nobody refreshed for this long is dropped by the next publish for its project.
pub const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const MAX_PUBLISHED_SESSIONS: usize = 256;
pub const MAX_TASK_CHARS: usize = 120;
/// Why a session cannot receive mail: a fixed vocabulary, so presence cannot carry free text.
const UNREACHABLE_REASONS: [&str; 5] = ["ended", "not-running", "no-native-binding", "provider-unverified", "checkout-changed"];

/// How far ahead of the engine's clock a caller's timestamp may be (clock skew between the trusted service and
/// the engine is nil on one machine; this only absorbs rounding).
const FUTURE_SKEW_MS: i64 = 60_000;
/// A task older than this (the writer claim's own staleness horizon) is flagged, not dropped.
pub const TASK_STALE_AFTER_MS: i64 = 2 * 60 * 60 * 1000;

pub struct Observed {
    session_id: String,
    task: Option<String>,
    /// When the session last refreshed the claim that carried the task, as observed by the trusted service.
    task_at: Option<i64>,
    /// The last authenticated managed-hook event of the session, as recorded by the trusted service.
    activity_at: Option<i64>,
    reachable: bool,
    reason: Option<&'static str>,
}

pub struct PublishRequest {
    project: String,
    sessions: Vec<Observed>,
}

impl PublishRequest {
    pub fn project(&self) -> &str {
        &self.project
    }
}

fn observed_time(args: &mut Args, key: &str, now: i64) -> Result<Option<i64>, Fail> {
    match args.optional_u64(key)? {
        Some(at) if at > now + FUTURE_SKEW_MS => Err(Fail::new("REQUEST_INVALID", format!("field `{key}` is missing or invalid"))),
        at => Ok(at),
    }
}

fn parse_observed(value: Value) -> Result<Observed, Fail> {
    let mut args = Args::new(value)?;
    let session_id = args.string("session_id", 128)?;
    if !session_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(Fail::new("REQUEST_INVALID", "field `session_id` is missing or invalid"));
    }
    let given = args.optional_string("task", 1024)?;
    let now = util::now_ms();
    let task_at = observed_time(&mut args, "task_at", now)?;
    let activity_at = observed_time(&mut args, "activity_at", now)?;
    if task_at.is_some() && given.is_none() {
        return Err(Fail::new("REQUEST_INVALID", "field `task_at` is missing or invalid"));
    }
    // A label that carries a path, an environment reference or a secret is not stored at all.
    let task = given.map(|task| util::one_line(&task, MAX_TASK_CHARS)).filter(|task| !(task.is_empty() || util::unsafe_label(task)));
    let task_at = task.as_ref().and(task_at);
    let mut reachability = args.object("reachability")?;
    let state = reachability.string("state", 16)?;
    let reason = reachability.optional_string("reason", 32)?;
    reachability.finish()?;
    args.finish()?;
    let (reachable, reason) = match (state.as_str(), reason) {
        ("reachable", None) => (true, None),
        ("unreachable", Some(reason)) => match UNREACHABLE_REASONS.iter().find(|known| **known == reason) {
            Some(known) => (false, Some(*known)),
            None => return Err(Fail::new("REQUEST_INVALID", "field `reason` is missing or invalid")),
        },
        _ => return Err(Fail::new("REQUEST_INVALID", "field `reachability` is missing or invalid")),
    };
    Ok(Observed { session_id, task, task_at, activity_at, reachable, reason })
}

pub fn parse_publish(mut args: Args) -> Result<PublishRequest, Fail> {
    let project = project_arg(&mut args)?;
    let sessions = args.array("sessions", MAX_PUBLISHED_SESSIONS)?.into_iter().map(parse_observed).collect::<Result<Vec<_>, _>>()?;
    args.finish()?;
    let mut seen = std::collections::HashSet::new();
    if !sessions.iter().all(|session| seen.insert(session.session_id.as_str())) {
        return Err(Fail::new("REQUEST_INVALID", "field `sessions` names a session twice"));
    }
    Ok(PublishRequest { project, sessions })
}

/// The standing that lets a project be seen: readable, and with visibility on.
fn visible(standing: &Standing) -> Option<&Policy> {
    match standing {
        Standing::Valid(policy, _) if policy.visibility => Some(policy),
        _ => None,
    }
}

/// Records what the trusted service observed about a shared project's managed sessions. The engine stamps
/// the observation time itself, so a caller cannot make old presence look fresh. Sessions not named here are
/// left as they were (and so age into stale) until retention drops them.
pub fn publish(store: &mut Store, request: PublishRequest) -> Result<Value, Fail> {
    let PublishRequest { project, sessions } = request;
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = standing(&tx, store.version, &project)?;
    if let Standing::Invalid(reason) = current {
        return Err(invalid_policy(&project, reason));
    }
    if visible(&current).is_none() {
        return Err(not_shared(&project));
    }
    tx.execute("DELETE FROM presence WHERE project = ?1 AND observed_at < ?2", params![project, now - RETENTION_MS])?;
    for session in &sessions {
        tx.execute(
            // An end is final for a managed session ID. Nothing later replaces it: not another ended report
            // (so the observation ages on its own and is never mistaken for fresh activity), and not a
            // delayed round that listed the session before it ended.
            "INSERT INTO presence (project, session_id, task, task_at, activity_at, reach_state, reach_reason, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (project, session_id) DO UPDATE SET task = excluded.task, task_at = excluded.task_at,
                activity_at = excluded.activity_at, reach_state = excluded.reach_state,
                reach_reason = excluded.reach_reason, observed_at = excluded.observed_at
             WHERE presence.reach_reason IS NOT 'ended'",
            params![
                project,
                session.session_id,
                session.task,
                session.task_at,
                session.activity_at,
                if session.reachable { "reachable" } else { "unreachable" },
                session.reason,
                now
            ],
        )?;
    }
    commit(tx, "presence_publish")?;
    Ok(json!({ "project": project, "published": sessions.len() }))
}

/// The sessions of shared projects with owner, task, reachability and freshness. Passive: it never creates
/// or writes a store. A stale observation stays listed, marked stale, and no longer claims to be reachable.
pub fn directory(store: Option<&Store>, mut args: Args) -> Result<Value, Fail> {
    let only = optional_project(&mut args)?;
    args.finish()?;
    let empty = || json!({ "entries": [], "problems": [], "stale_after_ms": STALE_AFTER_MS });
    let Some(store) = store else { return Ok(empty()) };
    if !store.has_sharing() {
        return Ok(empty());
    }
    let now = util::now_ms();
    let projects = match only {
        Some(project) => vec![project],
        None => policy_projects(store)?,
    };
    let mut entries = Vec::new();
    let mut problems = Vec::new();
    for project in projects {
        let current = standing(&store.db, store.version, &project)?;
        if let Standing::Invalid(reason) = current {
            problems.push(json!({ "project": project, "code": "POLICY_INVALID", "reason": reason }));
            continue;
        }
        let Some(policy) = visible(&current) else { continue };
        let mut statement = store
            .db
            .prepare("SELECT session_id, task, reach_state, reach_reason, observed_at, task_at, activity_at FROM presence WHERE project = ?1 ORDER BY session_id")?;
        let rows = statement
            .query_map([&project], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (session_id, task, state, reason, observed_at, task_at, activity_at) in rows {
            let stale = now - observed_at > STALE_AFTER_MS;
            // An end is final, so it stays an end however old the observation. Anything else that nobody
            // has refreshed lately is unknown, not reachable.
            let reachability = if stale && reason.as_deref() != Some("ended") {
                json!({ "state": "unknown", "reason": "stale" })
            } else {
                json!({ "state": state, "reason": reason })
            };
            entries.push(json!({
                "project": project,
                "session_id": session_id,
                "owner": policy.owner,
                "task": task,
                "task_at": task_at,
                "task_stale": task_at.is_some_and(|at| now - at > TASK_STALE_AFTER_MS),
                "activity_at": activity_at,
                "reachability": reachability,
                "observed_at": observed_at,
                "stale": stale,
            }));
        }
    }
    Ok(json!({ "entries": entries, "problems": problems, "stale_after_ms": STALE_AFTER_MS }))
}
