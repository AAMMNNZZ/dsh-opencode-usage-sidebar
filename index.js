/**
 * Host half of the OpenCode subscription usage bundle.
 *
 * The browser must never see the provider key, and opencode.ai refuses that
 * request from a page context anyway (Cloudflare + CLI identity headers), so
 * the Host resolves the credential and performs the upstream GET itself. The
 * browser half only polls this one same-origin route.
 *
 * Zero dependencies on purpose: a locally installed bundle is linked into the
 * profile, so a bare specifier would have to resolve from the checkout that
 * has no `node_modules`.
 */

const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';
const DEFAULT_CREDENTIAL_REF = 'OPENCODE_GO_API_KEY';
const ROUTE_PATH = '/dsh-opencode-usage/api/usage';
const STREAM_PATH = '/dsh-opencode-usage/api/stream';
const WINDOW_KEYS = ['rolling', 'weekly', 'monthly'];
const FETCH_TIMEOUT_MS = 12_000;
/** Ceiling on concurrent SSE readers; one tab each, plus room for a stuck reload. */
const MAX_STREAM_CLIENTS = 12;
/** Heartbeat cadence that keeps an idle proxy from closing the stream. */
const HEARTBEAT_MS = 25_000;
/** Coalesce the burst of `api-session/status` events one turn can produce. */
const TURN_SETTLE_MS = 1_200;

/** Bundle row name; also the Client module id. */
export const name = 'dsh-opencode-usage';

/** The credential seam is required; the web server is acquired lazily below. */
export const inject = ['credentials'];

/**
 * Resolve the row's optional config with environment fallbacks.
 * @param config - raw `config` from the Loader row (may be undefined).
 * @returns normalized options.
 */
function resolveOptions(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    endpoint: text(raw.endpoint) ?? text(process.env.DSH_OPENCODE_USAGE_ENDPOINT) ?? DEFAULT_ENDPOINT,
    credentialRef:
      text(raw.credentialRef) ?? text(process.env.DSH_OPENCODE_USAGE_CREDENTIAL) ?? DEFAULT_CREDENTIAL_REF,
    pollIntervalSec: Math.max(15, Math.round(number(raw.pollIntervalSec ?? process.env.DSH_OPENCODE_USAGE_POLL, 60))),
    cacheMs: Math.max(0, Math.round(number(raw.cacheMs, 15_000))),
  };
}

/**
 * Normalize one upstream window into the flat shape the browser draws.
 * @param key - window key (`rolling` | `weekly` | `monthly`).
 * @param window - upstream window object.
 * @returns the normalized window, or null when the payload has no such window.
 */
function normalizeWindow(key, window) {
  if (window === null || typeof window !== 'object') return null;
  const percent = Number(window.percent);
  const clamped = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const resetsAt = typeof window.resetsAt === 'string' && window.resetsAt ? window.resetsAt : null;
  return {
    key,
    percent: Math.round(clamped * 10) / 10,
    resetsAt,
    status: typeof window.status === 'string' ? window.status : 'ok',
    limited: window.status === 'rate-limited' || clamped >= 100,
  };
}

/**
 * Map the upstream body `{ usage: { rolling, weekly, monthly } }`.
 * @param body - parsed upstream JSON.
 * @returns normalized windows in display order.
 */
function normalizeUsage(body) {
  const usage = body && typeof body === 'object' && body.usage && typeof body.usage === 'object' ? body.usage : body;
  if (usage === null || typeof usage !== 'object') return [];
  return WINDOW_KEYS.map((key) => normalizeWindow(key, usage[key])).filter(Boolean);
}

/**
 * Write one JSON response.
 * @param res - response owner.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Ask the subscription endpoint with the provider key.
 * @param options - resolved plugin options.
 * @param key - the raw credential value.
 * @returns `{ ok: true, windows, plan }` or `{ ok: false, detail }`.
 */
async function fetchUsage(options, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(options.endpoint, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        'user-agent': 'opencode/1.0',
        'x-opencode-client': 'desktop',
        'x-opencode-project': 'global',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, detail: `upstream ${response.status}` };
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, status: 502, detail: 'upstream returned non-JSON' };
    }
    const windows = normalizeUsage(body);
    if (windows.length === 0) {
      return { ok: false, status: 502, detail: 'upstream returned no usage windows' };
    }
    return { ok: true, windows };
  } catch (error) {
    const timedOut = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    return { ok: false, status: 504, detail: timedOut ? 'upstream timed out' : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Handle one `/dsh-opencode-usage/api/usage` request, with a short result cache.
 * @param ctx - Host context carrying `credentials`.
 * @param options - resolved plugin options.
 * @param cache - mutable cache cell shared by the route.
 * @param req - incoming request.
 * @param res - response owner.
 */
async function handleRequest(ctx, options, cache, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET' });
    res.end();
    return;
  }
  // Read-only, but it describes the operator's subscription: refuse a request
  // another site initiated from a browser tab.
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(res, 403, { ok: false, reason: 'forbidden' });
    return;
  }

  const now = Date.now();
  if (cache.payload !== null && now - cache.at < options.cacheMs) {
    sendJson(res, 200, { ...cache.payload, cached: true });
    return;
  }

  let credential;
  try {
    credential = await ctx.credentials.resolve(options.credentialRef);
  } catch {
    credential = undefined;
  }
  if (credential === undefined || typeof credential.value !== 'string' || credential.value === '') {
    const payload = {
      ok: false,
      reason: 'missing-credential',
      credentialRef: options.credentialRef,
      pollIntervalSec: options.pollIntervalSec,
    };
    cache.at = now;
    cache.payload = payload;
    sendJson(res, 200, payload);
    return;
  }

  const result = await fetchUsage(options, credential.value);
  const payload = result.ok
    ? {
        ok: true,
        provider: 'opencode-go',
        source: credential.source,
        fetchedAt: new Date().toISOString(),
        pollIntervalSec: options.pollIntervalSec,
        windows: result.windows,
      }
    : {
        ok: false,
        reason: 'upstream',
        detail: result.detail,
        pollIntervalSec: options.pollIntervalSec,
        windows: [],
      };
  cache.at = now;
  cache.payload = payload;
  sendJson(res, 200, payload);
}

/**
 * Mount one event-stream reader and hold it open until the browser leaves.
 * @param options - resolved plugin options.
 * @param clients - live response set owned by the plugin effect.
 * @param req - incoming request.
 * @param res - response owner.
 */
function handleStream(options, clients, req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' });
    res.end();
    return;
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(res, 403, { ok: false, reason: 'forbidden' });
    return;
  }
  if (clients.size >= MAX_STREAM_CLIENTS) {
    sendJson(res, 503, { ok: false, reason: 'too-many-streams' });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // Reconnect quickly after a Host reload, and state the retry interval up front.
  res.write(`retry: 4000\nevent: ready\ndata: ${JSON.stringify({ pollIntervalSec: options.pollIntervalSec })}\n\n`);
  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      // A torn socket is handled by the close listener below.
    }
  }, HEARTBEAT_MS);

  const release = () => {
    clearInterval(heartbeat);
    clients.delete(res);
  };
  res.on('close', release);
  res.on('error', release);
}

/**
 * Wake every open stream and drop the cached payload so the next read is fresh.
 * @param clients - live response set.
 * @param cache - mutable cache cell shared by the route.
 */
function broadcastRefresh(clients, cache) {
  cache.at = 0;
  cache.payload = null;
  for (const client of clients) {
    try {
      client.write('event: usage\ndata: {}\n\n');
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * Mount the bundle: the usage route, the turn-end stream, and the trigger that
 * makes a finished turn refresh the numbers instead of waiting for the timer.
 * @param ctx - Host context.
 * @param config - row config (optional).
 */
export function apply(ctx, config) {
  const options = resolveOptions(config);
  const cache = { at: 0, payload: null };
  const clients = new Set();

  // `api-session/status` fires for every live Agent, so one User turn (plus its
  // subagents) settles into a single refresh.
  ctx.effect(() => {
    let pending = null;
    const onStatus = (sessionId, running) => {
      if (running === true || pending !== null) return;
      pending = setTimeout(() => {
        pending = null;
        broadcastRefresh(clients, cache);
      }, TURN_SETTLE_MS);
    };
    const off = ctx.on('api-session/status', onStatus);
    return () => {
      off();
      if (pending !== null) clearTimeout(pending);
    };
  }, 'dsh-opencode-usage: turn-end refresh');

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const stopUsage = webCtx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (req, res) => handleRequest(ctx, options, cache, req, res),
      });
      const stopStream = webCtx.webServer.register({
        kind: 'exact',
        path: STREAM_PATH,
        handler: (req, res) => handleStream(options, clients, req, res),
      });
      return () => {
        stopUsage();
        stopStream();
        for (const client of clients) {
          try {
            client.end();
          } catch {
            // Already gone.
          }
        }
        clients.clear();
      };
    }, 'dsh-opencode-usage: subscription usage routes');
  });
}
