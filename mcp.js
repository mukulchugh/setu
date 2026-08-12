// mcp.js — MCP (Model Context Protocol) client logic: connecting to stdio or
// HTTP servers, OAuth 2.1 auth for HTTP servers that require it. Owns all
// protocol logic and is deliberately unaware of HTTP routing or portal.js's
// WS layer, mirroring the lib.js (protocol/domain logic) vs portal.js
// (orchestration + routing) split. portal.js's mcpRoutes calls straight into
// the exported functions here and polls mcpStatuses() for its GET response.
//
// All API shapes here are verified against the actually-installed
// @modelcontextprotocol/sdk (read directly from node_modules, not assumed
// from docs -- an earlier docs lookup returned a newer/different version's
// signatures than what's installed, e.g. finishAuth() takes a plain
// authorization-code string here, not a URLSearchParams object, and
// clientInformation()/saveClientInformation()/tokens()/saveTokens() take no
// issuer/context parameter at all -- issuer-keying below is entirely this
// file's own responsibility, not something the SDK provides).

// Subpath imports need an explicit .js extension -- verified directly: the
// package's exports map only declares "." and "./client" (no extension
// needed there); every deeper subpath falls through to the wildcard
// "./*" entry, which does NOT auto-append .js, so an extensionless import
// of e.g. "@modelcontextprotocol/sdk/client/stdio" fails to resolve.
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import { loadMcpTokens, saveMcpTokens, PORTAL_PORT } from './lib.js';

const STDERR_TAIL_MAX = 20;

// serverId -> {status, tools, stderrTail, error}
// status: 'disconnected' | 'connecting' | 'awaiting-auth' | 'connected' | 'error'
const serverStatus = new Map();
// serverId -> {client, transport} for connected servers, so disconnect can
// close them cleanly. Tool-calling against these is the next plan's job.
const activeClients = new Map();
// serverId -> {state, transport, provider} -- bridges the redirect-then-
// callback gap. Keyed by serverId, not state: the callback route already
// gives us serverId from the URL path (one in-flight attempt per server is
// the only sane model), so state is used purely for CSRF verification, not
// routing.
const pendingAuth = new Map();

function setStatus(serverId, patch) {
  const prev = serverStatus.get(serverId) ?? { status: 'disconnected', tools: [], stderrTail: [], error: null };
  serverStatus.set(serverId, { ...prev, ...patch });
}

export function mcpStatus(serverId) {
  return serverStatus.get(serverId) ?? { status: 'disconnected', tools: [], stderrTail: [], error: null };
}

export function mcpStatuses() {
  return Object.fromEntries(serverStatus.entries());
}

function pushStderr(serverId, text) {
  const cur = serverStatus.get(serverId)?.stderrTail ?? [];
  const lines = [...cur, ...text.split('\n').filter(Boolean)];
  setStatus(serverId, { stderrTail: lines.slice(-STDERR_TAIL_MAX) });
}

// ---- OAuth provider ----
// One instance per connect attempt, closure-capturing serverId/workspace and
// the issuer resolved up front by connectHttpServer (see below) -- resolving
// it before construction, rather than waiting on saveDiscoveryState's
// callback, avoids a chicken-and-egg gap where an early clientInformation()
// call wouldn't yet know which issuer's stored info to return.
class SetuOAuthProvider {
  constructor(workspace, serverId, issuer) {
    this.workspace = workspace;
    this.serverId = serverId;
    this.issuer = issuer;
    this._codeVerifier = null;
    this._discovery = undefined;
  }
  get redirectUrl() {
    return `http://localhost:${PORTAL_PORT}/api/mcp/oauth/callback/${this.serverId}`;
  }
  get clientMetadata() {
    return {
      client_name: 'Setu',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Setu is a local desktop tool -- it cannot keep a client secret
      // confidential, so it registers as a public client, not the
      // client_secret_post the SDK's own demo client uses (that demo's
      // authorization server happens to issue a secret; not every AS does,
      // and 'none' is the correct declaration for a client with no way to
      // protect one either way).
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return loadMcpTokens(this.workspace)[this.issuer]?.clientInformation;
  }
  saveClientInformation(info) {
    const tokens = loadMcpTokens(this.workspace);
    tokens[this.issuer] = { ...(tokens[this.issuer] ?? {}), clientInformation: info };
    saveMcpTokens(this.workspace, tokens);
  }
  tokens() {
    return loadMcpTokens(this.workspace)[this.issuer]?.tokens;
  }
  saveTokens(t) {
    const tokens = loadMcpTokens(this.workspace);
    tokens[this.issuer] = { ...(tokens[this.issuer] ?? {}), tokens: t };
    saveMcpTokens(this.workspace, tokens);
  }
  redirectToAuthorization(url) {
    // Hand off to the user's real browser -- same macOS `open` shell-out
    // openInGhostty already uses to launch an external program.
    Bun.spawn(['open', url.toString()]);
  }
  // Optional per the interface, but implemented here deliberately: if left
  // unimplemented, the SDK generates its own CSRF state internally with no
  // way for this provider to retrieve what value it used, and finishMcpAuth
  // needs that value to verify the callback's state param against. this.state
  // (not local to the method) so pendingAuth can read it back after the
  // UnauthorizedError throw.
  state() {
    this.lastState = crypto.randomUUID();
    return this.lastState;
  }
  saveCodeVerifier(v) { this._codeVerifier = v; }
  codeVerifier() {
    if (!this._codeVerifier) throw new Error('no code verifier saved');
    return this._codeVerifier;
  }
  saveDiscoveryState(state) { this._discovery = state; }
  discoveryState() { return this._discovery; }
}

// ---- stdio ----

async function connectStdioServer(server) {
  setStatus(server.id, { status: 'connecting', error: null, stderrTail: [] });
  try {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: server.env,
      stderr: 'pipe', // default is 'inherit' (parent process's own stderr) -- 'pipe' is required for the .stderr getter below to return a real stream
    });
    transport.stderr?.on('data', chunk => pushStderr(server.id, chunk.toString()));
    transport.onclose = () => {
      activeClients.delete(server.id);
      setStatus(server.id, { status: 'disconnected' });
    };
    transport.onerror = err => {
      activeClients.delete(server.id);
      setStatus(server.id, { status: 'error', error: String(err?.message ?? err) });
    };

    const client = new Client({ name: 'setu', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const { tools } = await client.listTools();
    activeClients.set(server.id, { client, transport });
    setStatus(server.id, { status: 'connected', tools, error: null });
  } catch (e) {
    setStatus(server.id, { status: 'error', error: String(e?.message ?? e) });
  }
}

// ---- http ----

async function connectHttpServer(server, workspace) {
  setStatus(server.id, { status: 'connecting', error: null });
  try {
    if (server.httpAuthMode === 'oauth') {
      // Resolve the issuer before constructing the provider -- see
      // SetuOAuthProvider's comment for why this ordering matters.
      const { authorizationServerUrl } = await discoverOAuthServerInfo(server.url);
      const provider = new SetuOAuthProvider(workspace, server.id, authorizationServerUrl);
      await attemptOAuthConnect(server, provider);
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
      });
      transport.onclose = () => {
        activeClients.delete(server.id);
        setStatus(server.id, { status: 'disconnected' });
      };
      transport.onerror = err => {
        activeClients.delete(server.id);
        setStatus(server.id, { status: 'error', error: String(err?.message ?? err) });
      };
      const client = new Client({ name: 'setu', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      const { tools } = await client.listTools();
      activeClients.set(server.id, { client, transport });
      setStatus(server.id, { status: 'connected', tools, error: null });
    }
  } catch (e) {
    setStatus(server.id, { status: 'error', error: String(e?.message ?? e) });
  }
}

// Shared by the initial connect attempt and the reconnect after finishAuth
// completes -- always builds a fresh transport (a started transport can't be
// reused per the SDK's own requirement), reusing the same provider instance
// so its saved tokens/client info carry over. server must be the full config
// object (needs server.url), not just an id.
async function attemptOAuthConnect(server, provider) {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { authProvider: provider });
  transport.onclose = () => {
    activeClients.delete(server.id);
    pendingAuth.delete(server.id);
    setStatus(server.id, { status: 'disconnected' });
  };
  transport.onerror = err => {
    activeClients.delete(server.id);
    setStatus(server.id, { status: 'error', error: String(err?.message ?? err) });
  };

  const client = new Client({ name: 'setu', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    activeClients.set(server.id, { client, transport });
    pendingAuth.delete(server.id);
    setStatus(server.id, { status: 'connected', tools, error: null });
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      // redirectToAuthorization(url) already fired by this point -- the
      // user's browser is on its way to the authorization server. Stash
      // this exact transport/provider pair so the callback route can finish
      // the flow on the SAME transport instance the SDK requires, then
      // reconnect on a fresh one.
      pendingAuth.set(server.id, { state: provider.lastState, transport, provider });
      setStatus(server.id, { status: 'awaiting-auth', error: null });
      return;
    }
    // Any other failure here means this was the post-finishAuth reconnect
    // attempt (a fresh, first-time connect never has a pendingAuth entry to
    // begin with) -- clear it so a stale, already-consumed transport doesn't
    // linger in the map past its one legitimate use.
    pendingAuth.delete(server.id);
    setStatus(server.id, { status: 'error', error: String(e?.message ?? e) });
  }
}

// ---- exported entry points ----

export async function connectMcpServer(server, workspace) {
  if (server.transport === 'stdio') return connectStdioServer(server);
  return connectHttpServer(server, workspace);
}

// Called by the GET /api/mcp/oauth/callback/:serverId route with the
// authorization code and state extracted from the callback's query params.
// server is the full config object looked up fresh from mcp-servers.json by
// the route (needed for server.url on the reconnect below).
export async function finishMcpAuth(server, code, state) {
  const pending = pendingAuth.get(server.id);
  if (!pending) return { ok: false, error: 'No pending authorization for this server (expired, or already completed).' };
  if (pending.state !== state) {
    pendingAuth.delete(server.id);
    return { ok: false, error: 'State mismatch -- possible CSRF, aborting.' };
  }
  try {
    await pending.transport.finishAuth(code);
  } catch (e) {
    pendingAuth.delete(server.id);
    setStatus(server.id, { status: 'error', error: String(e?.message ?? e) });
    return { ok: false, error: String(e?.message ?? e) };
  }
  // Reconnect on a fresh transport instance, reusing the same provider (its
  // saved tokens now satisfy the connection) -- attemptOAuthConnect clears
  // pendingAuth itself once this settles, whichever way it goes.
  await attemptOAuthConnect(server, pending.provider);
  return { ok: true };
}

export function disconnectMcpServer(serverId) {
  const active = activeClients.get(serverId);
  if (active) {
    active.transport.close?.();
    activeClients.delete(serverId);
  }
  pendingAuth.delete(serverId);
  setStatus(serverId, { status: 'disconnected', tools: [], error: null, stderrTail: [] });
}
