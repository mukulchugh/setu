"""Drives `setu mcp` over stdio and checks that the fake secret never appears in any response."""
import json, os, socket, subprocess, sys, time

binary, worktree, home = sys.argv[1:4]
SECRET = "MCPLEAK"
seen = []  # every raw response line


class Mcp:
    def __init__(self):
        self.p = subprocess.Popen([binary, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.n = 0

    def rpc(self, method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            self.n += 1
            msg["id"] = self.n
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        if notify:
            return None
        line = self.p.stdout.readline()
        assert line, "mcp server closed stdout: " + self.p.stderr.read()
        seen.append(line)
        out = json.loads(line)
        assert out["id"] == self.n
        return out

    def tool(self, tname, **args):
        out = self.rpc("tools/call", {"name": tname, "arguments": args})
        res = out["result"]
        text = res["content"][0]["text"]
        try:
            data = json.loads(text)
        except ValueError:
            data = text
        return res["isError"], data


m = Mcp()
init = m.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e-client", "version": "1"}})
assert init["result"]["serverInfo"]["name"] == "setu"
m.rpc("notifications/initialized", notify=True)
tools = m.rpc("tools/list")["result"]["tools"]
names = sorted(t["name"] for t in tools)
print("tools:", ", ".join(names))
assert not any("reveal" in n for n in names)
assert all(t["inputSchema"]["type"] == "object" for t in tools)
assert m.rpc("ping")["result"] == {}

err, run = m.tool("run_start", path=worktree)
assert not err, run
key = run["run"]
print("run_start ->", key, run["status"])
for _ in range(60):
    err, runs = m.tool("run_list")
    mine = [r for r in runs if r["run"] == key]
    if mine and mine[0]["status"] == "running":
        break
    time.sleep(0.5)
else:
    raise SystemExit("run never became running: %s" % runs)
print("run_list -> %d run(s), %s is running" % (len(runs), key))

err, logs = m.tool("run_logs", run=key, proc="web", lines=50)
assert not err, logs
assert "[redacted:API_TOKEN]" in logs["text"], logs
assert SECRET not in logs["text"]
print("run_logs (proc=web) ->", logs["text"].strip().splitlines()[0])
err, logs_all = m.tool("run_logs", run=key)
assert not err and "[redacted:API_TOKEN]" in logs_all["text"]
err, url = m.tool("run_url", run=key)
assert not err and url["url"].startswith("http://"), url
print("run_url ->", url["url"])

err, al = m.tool("run_alias_add", run=key, host="Demo.E2E.local")
assert not err and al["host"] == "demo.e2e.local" and al["warnings"] == [], al
err, bad_alias = m.tool("run_alias_add", run=key, host="10.0.0.1")
assert err, "an IP must be refused"
err, al_list = m.tool("run_alias_list", run=key)
assert not err and [(a["host"], a["source"]) for a in al_list] == [("demo.e2e.local", "custom")], al_list
err, al_all = m.tool("run_alias_list")
assert not err and len(al_all) == 1, al_all
err, ls_after = m.tool("run_list")
assert [r for r in ls_after if r["run"] == key][0]["aliases"] == ["demo.e2e.local"]
err, al_rm = m.tool("run_alias_remove", run=key, host="demo.e2e.local")
assert not err and al_rm["removed"] is True, al_rm
err, al_none = m.tool("run_alias_list", run=key)
assert not err and al_none == [], al_none
print("run_alias_add/list/remove -> ok")

err, lst = m.tool("env_list", scope="project", target="e2e")
assert not err and any(v["name"] == "API_TOKEN" and v["secret"] for v in lst["vars"]), lst
print("env_list -> names:", [v["name"] for v in lst["vars"]])
err, eff = m.tool("env_effective", run=key)
assert not err and any(v["name"] == "API_TOKEN" for v in eff["vars"])
print("env_effective -> %d vars" % len(eff["vars"]))

err, pend = m.tool("env_set", scope="project", target="e2e", name="OTHER_TOKEN")
assert not err and pend["status"] == "pending_user_input", pend
print("env_set (no value) ->", pend["status"], "|", pend["next"])
err, setr = m.tool("env_set", scope="project", target="e2e", name="PLAIN_MODE", value="verbose", secret=False)
assert not err and setr["secret"] is False, setr
print("env_set (value) ->", setr["name"], "secret =", setr["secret"])
err, unset = m.tool("env_unset", scope="project", target="e2e", name="PLAIN_MODE")
assert not err and unset["existed"] is True

err, disk = m.tool("disk_report")
assert not err and "worktrees" in disk
print("disk_report -> %d worktree(s)" % len(disk["worktrees"]))
err, clean = m.tool("disk_clean")
assert not err and clean["applied"] is False

err, restarted = m.tool("run_restart", run=key)
assert not err, restarted
print("run_restart ->", restarted["status"])
err, bad = m.tool("run_logs", run=key, proc="../x")
assert err, "path-like proc name must be refused"
err, stopped = m.tool("run_stop", run=key)
assert not err and stopped["status"] == "stopped", stopped
print("run_stop ->", stopped["status"])

blob = "".join(seen)
assert SECRET not in blob, "secret leaked through MCP"
print("checked %d MCP responses: secret never appears" % len(seen))

# Raw socket: the daemon must refuse reveal for actor=mcp.
s = socket.socket(socket.AF_UNIX)
s.connect(os.path.join(home, "state", "d.sock"))
s.sendall((json.dumps({"cmd": "env.reveal", "actor": "mcp", "scope": "project", "target": "e2e", "name": "API_TOKEN"}) + "\n").encode())
reply = s.makefile().readline()
r = json.loads(reply)
assert r["ok"] is False and SECRET not in reply, reply
print("raw env.reveal with actor=mcp -> refused:", r["error"])
m.p.stdin.close()
m.p.wait(timeout=5)
