/**
 * Host half of the screenshot bundle: registers two HTTP routes on the composed
 * webServer (`/api/screenshot/capture`, `/api/screenshot/poll`) behind a
 * loopback same-origin fence, and captures the screen by spawning Windows
 * PowerShell directly through `node:child_process`. The browser half polls
 * until the capture completes and receives the PNG as base64 in the poll
 * response.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, statSync } from 'node:fs';

/** Diagnostic log sink: system temp dir, one append-only JSONL file. Module-level so both the module functions and the route handlers share it. */
const LOG_PATH = `${process.env.TEMP ?? process.env.TMP ?? 'C:\\Windows\\Temp'}\\dsh-screenshot-debug.jsonl`;
function logLine(message, data) {
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify({ time: new Date().toISOString(), message, data })}\n`, 'utf8');
  } catch {
    // A failed diagnostic write must never break the request path.
  }
}

/** The capture behaviors the Client half may request. */
const MODES = { direct: 'direct', hide: 'hide' };

/** Default Config values, applied only to absent or invalid fields. */
const DEFAULTS = {
  windowMatchTitle: 'DeepSeek',
  hideDelayMs: 400,
  /** Default to the primary display: a multi-display virtual screen squeezes the preview and makes selecting painful. */
  scope: 'primary',
  maxBase64Bytes: 16 * 1024 * 1024,
};

/** Reason string a poll returns while its capture is still running. */
/**
 * Resolve one capture request against the validated plugin Config.
 * @param {Record<string, unknown>} config - the plugin's Config row values.
 * @param {{ mode?: string }} request - the capture request body.
 * @returns {{ mode: string, windowMatchTitle: string, hideDelayMs: number, virtualScreen: boolean, maxBase64Bytes: number }} normalized options.
 * @throws when `request.mode` is neither `direct` nor `hide`.
 */
function resolveCaptureOptions(config, request) {
  const requestedMode = typeof request.mode === 'string' ? request.mode : MODES.direct;
  if (requestedMode !== MODES.direct && requestedMode !== MODES.hide) {
    throw new Error(`screenshot.capture: unknown mode "${requestedMode}"`);
  }
  const windowMatchTitle = typeof config.windowMatchTitle === 'string' && config.windowMatchTitle !== ''
    ? config.windowMatchTitle
    : DEFAULTS.windowMatchTitle;
  const requestedDelay = typeof config.hideDelayMs === 'number' && Number.isFinite(config.hideDelayMs) && config.hideDelayMs >= 1
    ? config.hideDelayMs
    : DEFAULTS.hideDelayMs;
  const requestedLimit = typeof config.maxBase64Bytes === 'number' && Number.isFinite(config.maxBase64Bytes) && config.maxBase64Bytes >= 1
    ? config.maxBase64Bytes
    : DEFAULTS.maxBase64Bytes;
  const requestedScope = config.scope === 'primary' || config.scope === 'all' ? config.scope : DEFAULTS.scope;
  return {
    mode: requestedMode,
    windowMatchTitle,
    hideDelayMs: Math.min(requestedDelay, 5000),
    virtualScreen: requestedScope === 'all',
    maxBase64Bytes: requestedLimit,
  };
}

/**
 * The hot resident crop server: one pwsh process precompiled at plugin
 * activation, serving shot commands over stdin/stdout. This removes the
 * ~460 ms pwsh cold start from every screenshot — the dominant latency.
 * State: null while starting/absent, the ChildProcess once up.
 */
let hotServer = null;
/** The in-flight shot request, resolved by the server's result line. */
let hotPending = null;
/** Buffered stdout fragments of the line currently being received. */
let hotLine = '';

/**
 * Handle one stdout line from the hot server: readiness handshake or shot
 * result.
 * @param {string} line - one complete JSON line.
 * @returns {void}
 */
function hotOnLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    logLine('hot server: unparseable line dropped', { length: trimmed.length });
    return;
  }
  if (hotPending !== null) {
    const pending = hotPending;
    hotPending = null;
    if (value.status === 'ok') {
      logLine('native crop ok', { width: value.width, height: value.height, bytes: value.dataBase64.length });
      pending.resolve(value);
    } else if (value.status === 'cancel') {
      pending.resolve({ cancelled: true });
    } else {
      pending.reject(new Error(String(value.error ?? 'unknown hot server error')));
    }
  }
}

/**
 * Start the hot resident server (idempotent). Loads the C# form source into
 * the process once; later shots skip all compilation and process startup.
 * Every failure mode — pwsh missing (ENOENT), spawn error, crash before
 * ready — is turned into a rejected promise here and must never reach the
 * Electron main process as an uncaught exception.
 * @returns {Promise<void>} resolves when the server answers ready.
 */
async function ensureHotServer() {
  if (hotServer !== null && hotServer.exitCode === null) {
    return;
  }
  const cs = readFileSync(new URL('./crop-form.cs', import.meta.url), 'utf8');
  const ps1 = readFileSync(new URL('./crop-server.ps1', import.meta.url), 'utf8');
  await new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error !== undefined) rejectReady(error); else resolveReady();
    };
    let child;
    try {
      child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-STA', '-NonInteractive', '-Command', ps1], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      hotServer = null;
      settle(new Error(`PowerShell 7 is required (install: winget install Microsoft.PowerShell). Starting it failed: ${String(error.message ?? error)}`));
      return;
    }
    hotServer = child;
    hotLine = '';
    // spawn('pwsh') failures arrive ASYNCHRONOUSLY as an 'error' event
    // (ENOENT when pwsh is not installed); without this handler the
    // exception propagates into the Electron main process and crashes it.
    child.on('error', (error) => {
      hotServer = null;
      settle(new Error(`PowerShell 7 is required (install: winget install Microsoft.PowerShell). Starting it failed: ${String(error.message ?? error)}`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      hotLine += chunk;
      let newlineAt = hotLine.indexOf('\n');
      while (newlineAt !== -1) {
        hotOnLine(hotLine.slice(0, newlineAt));
        hotLine = hotLine.slice(newlineAt + 1);
        newlineAt = hotLine.indexOf('\n');
      }
      if (!settled && hotServer === child) settle();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { logLine('hot server stderr', { text: String(chunk).slice(0, 200) }); });
    child.on('exit', () => {
      if (hotServer === child) hotServer = null;
      if (hotPending !== null) {
        const pending = hotPending;
        hotPending = null;
        pending.reject(new Error('hot server exited'));
      }
      settle(new Error('hot server exited before becoming ready'));
    });
    try {
      child.stdin.write(JSON.stringify({ cmd: 'loadcs', cs }) + '\n', (writeError) => {
        if (writeError && !settled) settle(new Error(`hot server stdin failed: ${String(writeError.message ?? writeError)}`));
      });
    } catch (error) {
      settle(new Error(`hot server stdin failed: ${String(error.message ?? error)}`));
    }
    setTimeout(() => settle(new Error('hot server did not become ready within 30s (is PowerShell 7 installed and on PATH?)')), 30000);
  });
}

/**
 * Run one shot through the hot resident server.
 * @param {{ hide: boolean, windowMatchTitle: string, hideDelayMs: number }} options - shot parameters.
 * @returns {Promise<{ dataBase64: string, width: number, height: number } | { cancelled: boolean }>} the crop result.
 */
async function hotShot(options) {
  await ensureHotServer();
  const hide = options.hide === true;
  logLine('native crop launching (hot)', { mode: options.hide ? 'hide' : 'direct' });
  return new Promise((resolve, reject) => {
    hotPending = { resolve, reject };
    try {
      hotServer.stdin.write(JSON.stringify({
        cmd: 'shot',
        hide,
        window: options.windowMatchTitle,
        delay: Math.min(Math.max(options.hideDelayMs, 120), 5000),
        // The Host half's own pid: the hide-window lookup walks the ancestor
        // process chain from here, so it finds THE app's main window by
        // process identity instead of guessing by title substring.
        hostPid: process.pid,
      }) + '\n');
    } catch (error) {
      hotPending = null;
      reject(new Error(`hot server write failed: ${String(error)}`));
    }
  });
}

/**
 * Run the native full-screen crop overlay through the hot resident server:
 * capture → overlay over the whole screen → selection → crop, all inside an
 * already-warm pwsh process. Hide mode defers the window restore until the
 * overlay closes inside the server, so the flow reads: minimize → overlay
 * over a screen without the app → selection → the app comes back.
 * @param {{ maxBase64Bytes: number, mode: string, windowMatchTitle: string, hideDelayMs: number }} options - normalized options.
 * @returns {Promise<{ dataBase64: string, width: number, height: number }>} the cropped PNG, base64-encoded, plus its pixel size.
 */
async function runNativeCrop(options) {
  try {
    const result = await hotShot({
      hide: options.mode === 'hide',
      windowMatchTitle: options.windowMatchTitle,
      hideDelayMs: options.hideDelayMs,
    });
    if (result.cancelled) throw new Error('crop-cancelled');
    return result;
  } catch (error) {
    // The hide restore lives inside the server's shot handler; nothing to do
    // here beyond rethrowing for the route's cancelled/failed split.
    throw error;
  }
}

/** Loopback hostname forms the source fence accepts. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The request-source fence for the screenshot routes: the Host header must
 * name a loopback authority (DNS-rebinding defense), and any attached browser
 * marker (Fetch Metadata, Origin) must say same-origin. The page reaches these
 * routes same-origin over `http://127.0.0.1:<port>`, so the happy path sends
 * `sec-fetch-site: same-origin` and an Origin equal to the Host authority.
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @returns {boolean} whether the request may reach the capture pipeline.
 */
function sameOriginLoopback(req) {
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  const separator = host.lastIndexOf(':');
  const hostname = (separator > 0 ? host.slice(0, separator) : host).toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Services the Host half requires; cordis waits and stays PENDING when absent. */
export const inject = ['webServer'];

/**
 * Host plugin: registers the capture and poll routes on the composed
 * webServer; each capture spawns PowerShell directly.
 * @param {object} ctx - the cordis context with the injected services.
 * @param {Record<string, unknown>} config - the plugin's Config row values.
 * @returns {() => void} disposal removing the two routes.
 */
export function apply(ctx, config) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) throw new Error('screenshot bundle: webServer service resolved undefined after inject');
  const resolvedConfig = typeof config === 'object' && config !== null ? config : {};

  /**
   * Self-service HMR: the dev SSE channel drives the browser half's hot
   * reload, but its producer (the fs watcher behind clientModules.rebuilt)
   * only runs when the harness watches sources. Pushing `rebuilt` here makes
   * every edit to this bundle's client.js reach the open page without a
   * restart, including in a packaged desktop app. Optional service: absent
   * compositions keep the plain static behavior.
   */
  const clientModules = ctx.get('clientModules');
  let unwatch = () => {};
  if (clientModules !== undefined && typeof clientModules.rebuilt === 'function') {
    const bundleId = 'dsh-screenshot-button';
    const clientPath = new URL('./client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const lastRev = { value: '' };
    const watchTimer = setInterval(() => {
      try {
        const stats = statSync(clientPath);
        const rev = `${stats.size}-${stats.mtimeMs}`;
        if (rev !== lastRev.value) {
          const firstRun = lastRev.value === '';
          lastRev.value = rev;
          if (!firstRun) {
            logLine('client bundle changed, pushing rebuilt', { clientPath });
            clientModules.rebuilt(bundleId);
          }
        }
      } catch {
        // A missing file or a transient stat error just skips this tick.
      }
    }, 1500);
    unwatch = () => { clearInterval(watchTimer); };
  }

  /** Write one JSON response. */
  function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  }

  /** Read and parse a bounded JSON request body, or null. */
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) return null;
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return null;
    }
  }

  const disposeLog = webServer.register({
    kind: 'exact',
    path: '/api/screenshot/v5/log',
    handler: async (req, res) => {
      if (!sameOriginLoopback(req)) { json(res, 403, { error: 'forbidden' }); return; }
      const body = await readBody(req);
      if (body === null || typeof body !== 'object') { json(res, 400, { error: 'invalid body' }); return; }
      logLine(String(body.message ?? '(no message)'), body.data ?? null);
      json(res, 200, { ok: true });
    },
  });

  /**
   * The native full-screen crop route: capture, show the WeChat-style native
   * overlay over the whole screen, and return the cropped PNG. Synchronous
   * by design — the response arrives when the user finishes (or cancels)
   * the selection, so the browser half needs no polling.
   */
  const disposeNative = webServer.register({
    kind: 'exact',
    path: '/api/screenshot/v5/cropnative',
    handler: async (req, res) => {
      if (!sameOriginLoopback(req)) { json(res, 403, { error: 'forbidden' }); return; }
      const body = await readBody(req);
      if (body === null || typeof body !== 'object') { json(res, 400, { error: 'invalid body' }); return; }
      let options;
      try {
        options = resolveCaptureOptions(resolvedConfig, body);
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      logLine('native crop requested', { mode: options.mode });
      try {
        const result = await runNativeCrop(options);
        json(res, 200, { status: 'ok', dataBase64: result.dataBase64, width: result.width, height: result.height });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'crop-cancelled') {
          logLine('native crop cancelled by user', null);
          json(res, 200, { status: 'cancelled' });
          return;
        }
        logLine('native crop failed', { error: message });
        json(res, 500, { error: message });
      }
    },
  });

  // Warm the resident server at activation so the first screenshot skips the
  // cold start too; a failed warm-up only means the first shot pays it.
  void ensureHotServer().catch(error => { logLine('hot server warm-up failed', { error: String(error) }); });

  return () => {
    disposeLog(); disposeNative(); unwatch();
    try {
      if (hotServer !== null && hotServer.exitCode === null) hotServer.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n');
    } catch { /* the process may already be gone */ }
  };
}
