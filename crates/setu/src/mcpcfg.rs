//! Editing the MCP server entries in AI-client config files (`setu migrate`).
//!
//! Only entries that point at the old v1 portal are touched: a server named `setu`, or one whose
//! URL is the v1 endpoint (`http://localhost:2999/mcp`, or the port the v1 portal really listened
//! on). Everything else in the file is carried through unchanged, and no server's contents are
//! ever returned or printed (they may hold tokens): callers only get entry names and counts.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fmt {
    /// `~/.claude.json`: a global `mcpServers` and one per `projects.<path>`; stdio entries carry `type`.
    ClaudeJson,
    /// A project-level `.mcp.json` (Claude Code format).
    McpJson,
    /// Cursor, Claude Desktop and Gemini: a top-level `mcpServers`; entries are `command` + `args`.
    Plain,
    /// `~/.codex/config.toml`: `[mcp_servers.<name>]` tables.
    Codex,
}

impl Fmt {
    pub fn name(self) -> &'static str {
        match self {
            Fmt::ClaudeJson => "claude-json",
            Fmt::McpJson => "mcp-json",
            Fmt::Plain => "plain",
            Fmt::Codex => "codex",
        }
    }
    pub fn parse(s: &str) -> Option<Fmt> {
        [Fmt::ClaudeJson, Fmt::McpJson, Fmt::Plain, Fmt::Codex].into_iter().find(|f| f.name() == s)
    }
}

/// One entry that was repointed: where its `mcpServers` object is, and its key.
#[derive(Debug, Clone, PartialEq)]
pub struct Touched {
    pub path: Vec<String>,
    pub key: String,
}

fn url_is_v1(u: &str, ports: &[u16]) -> bool {
    let u = u.trim();
    u.contains(":2999/mcp") || ports.iter().any(|p| u.contains(&format!(":{p}/mcp")))
}

/// Already the new Setu: a stdio `…/setu mcp` (or bare `setu mcp`) entry. Never rewritten.
fn entry_is_new_setu(entry: &Value) -> bool {
    let cmd_is_setu = entry.get("command").and_then(Value::as_str).is_some_and(|c| c.rsplit('/').next() == Some("setu"));
    let args_mcp = entry.get("args").and_then(Value::as_array).is_some_and(|a| a.len() == 1 && a[0] == "mcp");
    cmd_is_setu && args_mcp
}

fn entry_is_v1(key: &str, entry: &Value, ports: &[u16]) -> bool {
    if entry_is_new_setu(entry) {
        return false;
    }
    key == "setu"
        || ["url", "httpUrl", "serverUrl"].iter().any(|k| entry.get(k).and_then(Value::as_str).is_some_and(|u| url_is_v1(u, ports)))
}

fn new_entry(fmt: Fmt, cmd: &str) -> Value {
    match fmt {
        Fmt::ClaudeJson | Fmt::McpJson => json!({ "type": "stdio", "command": cmd, "args": ["mcp"] }),
        _ => json!({ "command": cmd, "args": ["mcp"] }),
    }
}

/// Indentation of the original file, so a rewrite does not reformat it.
fn serialize(v: &Value, original: &str) -> Result<String> {
    use serde::Serialize;
    let indent: Option<String> = original.lines().find_map(|l| {
        let ws: String = l.chars().take_while(|c| *c == ' ' || *c == '\t').collect();
        (!ws.is_empty() && !l.trim().is_empty()).then_some(ws)
    });
    let mut out = match indent {
        None => serde_json::to_string(v)?,
        Some(ws) => {
            let mut buf = Vec::new();
            let fmt = serde_json::ser::PrettyFormatter::with_indent(ws.as_bytes());
            let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
            v.serialize(&mut ser)?;
            String::from_utf8(buf)?
        }
    };
    if original.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

/// Every `mcpServers` object in the file, as (path to it).
fn server_paths(root: &Value, fmt: Fmt) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    if root.get("mcpServers").is_some_and(Value::is_object) {
        out.push(vec!["mcpServers".to_string()]);
    }
    if fmt == Fmt::ClaudeJson {
        if let Some(projects) = root.get("projects").and_then(Value::as_object) {
            for (name, p) in projects {
                if p.get("mcpServers").is_some_and(Value::is_object) {
                    out.push(vec!["projects".to_string(), name.clone(), "mcpServers".to_string()]);
                }
            }
        }
    }
    out
}

fn at<'a>(root: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(root, |v, k| v.get(k))
}

fn at_mut<'a>(root: &'a mut Value, path: &[String]) -> Option<&'a mut Value> {
    path.iter().try_fold(root, |v, k| v.get_mut(k))
}

/// Repoint every v1 entry to `<cmd> mcp`. `None` when nothing needs changing (including when the
/// entries already are exactly what we would write).
pub fn json_repoint(text: &str, fmt: Fmt, cmd: &str, ports: &[u16]) -> Result<Option<(String, Vec<Touched>)>> {
    let mut root: Value = serde_json::from_str(text).context("the file is not valid JSON")?;
    let want = new_entry(fmt, cmd);
    let mut touched = Vec::new();
    for path in server_paths(&root, fmt) {
        let keys: Vec<String> = at(&root, &path).and_then(Value::as_object).map(|o| o.iter().filter(|(k, v)| entry_is_v1(k, v, ports) && **v != want).map(|(k, _)| k.clone()).collect()).unwrap_or_default();
        for key in keys {
            if let Some(obj) = at_mut(&mut root, &path).and_then(Value::as_object_mut) {
                obj.insert(key.clone(), want.clone());
                touched.push(Touched { path: path.clone(), key });
            }
        }
    }
    if touched.is_empty() {
        return Ok(None);
    }
    Ok(Some((serialize(&root, text)?, touched)))
}

/// Put the original entries from `backup` back into `current`, leaving every other change alone.
pub fn json_restore(current: &str, backup: &str, touched: &[Touched]) -> Result<String> {
    let mut cur: Value = serde_json::from_str(current).context("the current file is not valid JSON")?;
    let old: Value = serde_json::from_str(backup).context("the backup is not valid JSON")?;
    for t in touched {
        let Some(orig) = at(&old, &t.path).and_then(|o| o.get(&t.key)).cloned() else { continue };
        // Make sure the containers exist (the user may have removed them since).
        let mut node = &mut cur;
        for k in &t.path {
            if !node.is_object() {
                bail!("{} is not an object in the current file", t.path.join("."));
            }
            node = node.as_object_mut().ok_or_else(|| anyhow!("not an object"))?.entry(k.clone()).or_insert_with(|| json!({}));
        }
        node.as_object_mut().ok_or_else(|| anyhow!("not an object"))?.insert(t.key.clone(), orig);
    }
    serialize(&cur, current)
}

// ---------------------------------------------------------------------------------- Codex TOML

#[derive(Debug, PartialEq)]
struct Block {
    name: String,
    /// Line range [start, end): the header through the last non-blank line of the table and its sub-tables.
    start: usize,
    end: usize,
}

fn header_name(line: &str) -> Option<String> {
    let l = line.trim();
    let rest = l.strip_prefix("[mcp_servers.")?.strip_suffix(']')?;
    if rest.contains('.') && !rest.starts_with('"') {
        return None; // a sub-table like mcp_servers.x.env
    }
    Some(rest.trim_matches('"').to_string())
}

fn is_header(line: &str) -> bool {
    line.trim_start().starts_with('[')
}

fn blocks(lines: &[&str]) -> Vec<Block> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if let Some(name) = header_name(lines[i]) {
            let sub_prefix = format!("[mcp_servers.{}.", lines[i].trim().trim_start_matches("[mcp_servers.").trim_end_matches(']'));
            let mut end = lines.len();
            for (j, l) in lines.iter().enumerate().skip(i + 1) {
                if is_header(l) && !l.trim().starts_with(&sub_prefix) {
                    end = j;
                    break;
                }
            }
            let mut e = end;
            while e > i + 1 && lines[e - 1].trim().is_empty() {
                e -= 1;
            }
            out.push(Block { name, start: i, end: e });
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

fn block_has_v1_url(lines: &[&str], b: &Block, ports: &[u16]) -> bool {
    lines[b.start..b.end].iter().any(|l| {
        let t = l.trim_start();
        t.starts_with("url") && l.split_once('=').is_some_and(|(k, v)| k.trim() == "url" && url_is_v1(v, ports))
    })
}

/// A Codex block that already runs the new Setu over stdio (`command = "…/setu"`, `args = ["mcp"]`).
fn block_is_new_setu(lines: &[&str], b: &Block) -> bool {
    let val = |key: &str| lines[b.start..b.end].iter().find_map(|l| l.split_once('=').filter(|(k, _)| k.trim() == key).map(|(_, v)| v.trim().to_string()));
    let cmd_is_setu = val("command").is_some_and(|v| v.trim_matches('"').rsplit('/').next() == Some("setu"));
    let args_mcp = val("args").is_some_and(|v| v.replace(' ', "") == "[\"mcp\"]");
    cmd_is_setu && args_mcp && !block_has_v1_url(lines, b, &[])
}

fn codex_new_block(name: &str, cmd: &str) -> Vec<String> {
    let header = if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') { format!("[mcp_servers.{name}]") } else { format!("[mcp_servers.\"{name}\"]") };
    vec![header, format!("command = {}", serde_json::to_string(cmd).unwrap_or_default()), "args = [\"mcp\"]".to_string()]
}

pub fn toml_repoint(text: &str, cmd: &str, ports: &[u16]) -> Result<Option<(String, Vec<String>)>> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut touched = Vec::new();
    let mut at_line = 0;
    for b in blocks(&lines) {
        if !(b.name == "setu" || block_has_v1_url(&lines, &b, ports)) || block_is_new_setu(&lines, &b) {
            continue;
        }
        let new = codex_new_block(&b.name, cmd);
        if lines[b.start..b.end].iter().map(|l| l.trim_end()).eq(new.iter().map(String::as_str)) {
            continue;
        }
        out.extend(lines[at_line..b.start].iter().map(|l| l.to_string()));
        out.extend(new);
        at_line = b.end;
        touched.push(b.name);
    }
    if touched.is_empty() {
        return Ok(None);
    }
    out.extend(lines[at_line..].iter().map(|l| l.to_string()));
    let new_text = out.join("\n");
    toml::from_str::<toml::Value>(&new_text).context("the edited Codex config would not parse; leaving it alone")?;
    Ok(Some((new_text, touched)))
}

pub fn toml_restore(current: &str, backup: &str, names: &[String]) -> Result<String> {
    let blines: Vec<&str> = backup.split('\n').collect();
    let bblocks = blocks(&blines);
    let mut text = current.to_string();
    for name in names {
        let Some(orig) = bblocks.iter().find(|b| &b.name == name) else { continue };
        let old: Vec<String> = blines[orig.start..orig.end].iter().map(|l| l.to_string()).collect();
        let lines: Vec<&str> = text.split('\n').collect();
        let cur = blocks(&lines).into_iter().find(|b| &b.name == name);
        text = match cur {
            Some(b) => lines[..b.start].iter().map(|l| l.to_string()).chain(old).chain(lines[b.end..].iter().map(|l| l.to_string())).collect::<Vec<_>>().join("\n"),
            None => format!("{}\n\n{}\n", text.trim_end_matches('\n'), old.join("\n")),
        };
    }
    Ok(text)
}

/// Names of the v1 entries in a file, for the plan table (no contents).
pub fn scan(text: &str, fmt: Fmt, cmd: &str, ports: &[u16]) -> Result<Vec<String>> {
    Ok(match fmt {
        Fmt::Codex => toml_repoint(text, cmd, ports)?.map(|(_, t)| t).unwrap_or_default(),
        _ => json_repoint(text, fmt, cmd, ports)?.map(|(_, t)| t.into_iter().map(|x| x.key).collect()).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: &str = "{\n    \"numStartups\": 7,\n    \"mcpServers\": {\"setu\": {\"type\": \"http\", \"url\": \"http://localhost:2999/mcp\"}, \"other\": {\"command\": \"x\", \"env\": {\"TOKEN\": \"SECRET\"}}},\n    \"projects\": {\n        \"/w/a\": {\"mcpServers\": {\"setu\": {\"type\": \"http\", \"url\": \"http://localhost:2999/mcp\"}, \"keep\": {\"url\": \"https://x.test/mcp\"}}, \"allowedTools\": []},\n        \"/w/b\": {\"mcpServers\": {\"old\": {\"type\": \"http\", \"url\": \"http://127.0.0.1:3010/mcp\"}}}\n    }\n}\n";

    #[test]
    fn claude_json_global_and_project_entries_are_repointed_and_others_untouched() {
        let (text, t) = json_repoint(CLAUDE, Fmt::ClaudeJson, "/bin/setu", &[3010]).unwrap().unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["mcpServers"]["setu"], json!({"type":"stdio","command":"/bin/setu","args":["mcp"]}));
        assert_eq!(v["mcpServers"]["other"], json!({"command":"x","env":{"TOKEN":"SECRET"}}));
        assert_eq!(v["projects"]["/w/a"]["mcpServers"]["setu"]["command"], "/bin/setu");
        assert_eq!(v["projects"]["/w/a"]["mcpServers"]["keep"], json!({"url":"https://x.test/mcp"}));
        assert_eq!(v["projects"]["/w/b"]["mcpServers"]["old"]["args"], json!(["mcp"]), "a v1 url under another name, on the portal's real port");
        assert_eq!(v["numStartups"], 7);
        assert_eq!(t.len(), 3);
        assert!(text.starts_with("{\n    \"numStartups\""), "indent and key order kept: {text}");
        assert!(text.ends_with("}\n"));
        // idempotent
        assert!(json_repoint(&text, Fmt::ClaudeJson, "/bin/setu", &[3010]).unwrap().is_none());
        // restore: the entries come back from the backup, later edits stay
        let edited = text.replace("\"numStartups\": 7", "\"numStartups\": 8");
        let back = json_restore(&edited, CLAUDE, &t).unwrap();
        let b: Value = serde_json::from_str(&back).unwrap();
        let o: Value = serde_json::from_str(CLAUDE).unwrap();
        assert_eq!(b["mcpServers"], o["mcpServers"]);
        assert_eq!(b["projects"], o["projects"]);
        assert_eq!(b["numStartups"], 8);
    }

    #[test]
    fn plain_clients_use_command_and_args_and_other_urls_are_left_alone() {
        let text = "{\"mcpServers\":{\"a\":{\"url\":\"http://localhost:2999/mcp\"},\"b\":{\"url\":\"http://localhost:3999/mcp\"}}}";
        let (out, t) = json_repoint(text, Fmt::Plain, "/s", &[]).unwrap().unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcpServers"]["a"], json!({"command":"/s","args":["mcp"]}));
        assert_eq!(v["mcpServers"]["b"], json!({"url":"http://localhost:3999/mcp"}));
        assert_eq!(t, vec![Touched { path: vec!["mcpServers".into()], key: "a".into() }]);
        assert!(!out.contains('\n'), "compact stays compact");
        assert!(json_repoint("{\"mcpServers\":{}}", Fmt::Plain, "/s", &[]).unwrap().is_none());
        assert!(json_repoint("{\"x\":1}", Fmt::Plain, "/s", &[]).unwrap().is_none());
    }

    const CODEX: &str = "model = \"gpt\"\n\n[mcp_servers.setu]\nurl = \"http://localhost:2999/mcp\"\nstartup_timeout_sec = 20\n\n[mcp_servers.setu.env]\nA = \"1\"\n\n[mcp_servers.other]\ncommand = \"y\"\ntoken = \"SECRET\"\n\n[mcp_servers.legacy]\nurl = \"http://127.0.0.1:3010/mcp\"\n";

    #[test]
    fn codex_tables_are_repointed_and_restored_and_others_untouched() {
        let (text, names) = toml_repoint(CODEX, "/bin/setu", &[3010]).unwrap().unwrap();
        assert_eq!(names, ["setu", "legacy"]);
        let v: toml::Value = toml::from_str(&text).unwrap();
        assert_eq!(v["mcp_servers"]["setu"]["command"].as_str(), Some("/bin/setu"));
        assert!(v["mcp_servers"]["setu"].get("url").is_none() && v["mcp_servers"]["setu"].get("env").is_none(), "{text}");
        assert_eq!(v["mcp_servers"]["other"]["token"].as_str(), Some("SECRET"));
        assert_eq!(v["mcp_servers"]["legacy"]["args"].as_array().unwrap().len(), 1);
        assert!(text.starts_with("model = \"gpt\"\n\n[mcp_servers.setu]\ncommand"));
        assert!(toml_repoint(&text, "/bin/setu", &[3010]).unwrap().is_none(), "idempotent");
        assert_eq!(toml_restore(&text, CODEX, &names).unwrap(), CODEX, "restoring all touched blocks is byte exact");
        assert!(toml_repoint("model = \"x\"\n", "/s", &[]).unwrap().is_none());
    }

    #[test]
    fn entries_already_on_the_new_setu_are_left_alone() {
        let claude = r#"{"mcpServers":{"setu":{"type":"stdio","command":"/Users/u/.local/bin/setu","args":["mcp"]}},"projects":{"/p":{"mcpServers":{"setu":{"type":"http","url":"http://localhost:2999/mcp"}}}}}"#;
        let (_, touched) = json_repoint(claude, Fmt::ClaudeJson, "/new/setu", &[]).unwrap().unwrap();
        assert_eq!(touched.len(), 1, "only the project's old HTTP entry is repointed");
        let codex = "[mcp_servers.setu]\ncommand = \"/Users/u/.local/bin/setu\"\nargs = [\"mcp\"]\n";
        assert!(toml_repoint(codex, "/new/setu", &[]).unwrap().is_none());
        let old_codex = "[mcp_servers.setu]\nurl = \"http://localhost:2999/mcp\"\n";
        assert!(toml_repoint(old_codex, "/new/setu", &[]).unwrap().is_some());
    }

    #[test]
    fn scan_reports_names_only() {
        assert_eq!(scan(CLAUDE, Fmt::ClaudeJson, "/s", &[]).unwrap(), ["setu", "setu"]);
        assert_eq!(scan(CODEX, Fmt::Codex, "/s", &[]).unwrap(), ["setu"]);
    }
}
