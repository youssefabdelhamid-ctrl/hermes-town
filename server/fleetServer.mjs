// Same-host collector: expose configured Town snapshots and SSE through one
// origin. Profiles keep independent cursors, journals, and bridge credentials.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { isLoopbackHost, SECURITY_HEADERS } from './townServer.mjs';
import { AGENT_KEY, ROLES, PUBLIC_VERSION, TOOL_NAME, DETAIL_NAME, displayNameFor } from './lib/contract.mjs';
import { contentTypeFor, resolveStatic } from './lib/staticFiles.mjs';

export const FLEET_VERSION = 'hermes-town.fleet.v1';
const integer = v => Number.isSafeInteger(v) && v >= 0;
const timestamp = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const exactKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));

export function parseFleetConfig(config) {
  if (!exactKeys(config, ['buddies']) || !Array.isArray(config.buddies) || !config.buddies.length || config.buddies.length > 64) {
    throw new Error('Fleet config requires 1–64 buddies');
  }
  const ids = new Set(), origins = new Set();
  return config.buddies.map(b => {
    if (!exactKeys(b, ['id', 'name', 'url']) || typeof b.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(b.id)
      || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 48 || /[\x00-\x1f\x7f]/.test(b.name)) throw new Error('Invalid buddy id or name');
    const url = new URL(b.url);
    if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname.replace(/^\[|\]$/g, ''))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Buddy URL must be a loopback HTTP origin');
    if (ids.has(b.id) || origins.has(url.origin)) throw new Error('Duplicate buddy id or URL');
    ids.add(b.id); origins.add(url.origin);
    return { id: b.id, name: b.name.trim(), url: url.origin };
  });
}

// Rebuild public data rather than blindly forwarding upstream bytes. No
// credentials, paths, transcripts, or arbitrary upstream display text survive.
export function publicEvent(e) {
  if (!e || typeof e !== 'object' || !/^e\d+$/.test(e.id) || !AGENT_KEY.test(e.agentId)
    || !integer(e.cursor) || !integer(e.seq) || !timestamp(e.at)) return null;
  const out = { id: e.id, agentId: e.agentId, cursor: e.cursor, seq: e.seq, at: e.at, type: e.type };
  if (ROLES.includes(e.role)) out.role = e.role;
  switch (e.type) {
    case 'agent.spawned':
      if (!out.role) return null;
      out.displayName = displayNameFor(out.role, e.agentId); break;
    case 'agent.assigned': out.action = 'turn started'; break;
    case 'agent.tool_started':
      out.tool = typeof e.tool === 'string' && TOOL_NAME.test(e.tool) ? e.tool : 'tool';
      if (typeof e.detail === 'string' && DETAIL_NAME.test(e.detail) && !e.detail.includes('..')) out.detail = e.detail;
      break;
    case 'agent.waiting': break;
    case 'agent.completed': out.action = 'turn completed'; break;
    case 'agent.failed': out.reason = 'reported failure'; break;
    case 'agent.departed': break;
    default: return null;
  }
  return out;
}
const bridge = b => b && integer(b.receivedEvents) && (b.lastEventAt === null || timestamp(b.lastEventAt))
  ? { receivedEvents: b.receivedEvents, lastEventAt: b.lastEventAt } : null;
function metadata(b) {
  if (!b || !/^[a-f0-9]{16}$/.test(b.streamId) || !integer(b.cursor) || !timestamp(b.at)) throw new Error('Invalid Town snapshot');
  return { v: PUBLIC_VERSION, streamId: b.streamId, cursor: b.cursor, at: b.at, bridge: bridge(b.bridge) };
}
async function readBounded(response, limit) {
  let bytes = 0, chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Town response too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createFleetServer({ config, staticRoot = null }) {
  const buddies = parseFleetConfig(config);
  const root = staticRoot === null ? null : fs.realpathSync(path.resolve(staticRoot));
  const requests = new Set();
  function json(res, status, value) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  }
  async function proxy(req, res, url, buddy, kind) {
    const controller = new AbortController();
    requests.add(controller);
    const abort = () => controller.abort();
    res.on('close', abort);
    // Bound time to first response; SSE remains open until its viewer leaves.
    const timeout = setTimeout(abort, 4000);
    try {
      const upstream = new URL(`/api/town/${kind}`, buddy.url);
      for (const key of ['since', 'stream']) {
        const value = url.searchParams.get(key);
        if (value !== null && value.length <= 64) upstream.searchParams.set(key, value);
      }
      if (kind === 'snapshot') upstream.searchParams.set('residents', 'all');
      if (kind === 'events' && /^\d{1,16}$/.test(req.headers['last-event-id'] ?? '')) upstream.searchParams.set('since', req.headers['last-event-id']);
      const response = await fetch(upstream, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error('Town unavailable');
      if (kind === 'snapshot') {
        const data = JSON.parse(await readBounded(response, 8 * 1024 * 1024));
        if (!Array.isArray(data.events) || data.events.length > 256 * 49) throw new Error('Invalid events');
        const safe = metadata(data);
        safe.events = data.events.map(publicEvent).filter(Boolean);
        safe.omitted = { stale: 0, departed: 0 };
        safe.recent = [];
        json(res, 200, safe);
      } else {
        if (!response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('Invalid Town stream');
        clearTimeout(timeout);
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        let pending = '';
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true });
          if (pending.length > 128 * 1024) throw new Error('Town frame too large');
          let end;
          while ((end = pending.indexOf('\n\n')) !== -1) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2);
            const lines = frame.split('\n');
            const type = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
            const raw = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
            if (!raw) continue;
            const body = JSON.parse(raw);
            let data;
            if (type === 'town') data = publicEvent(body);
            else if (type === 'hello') data = metadata(body);
            else if (type === 'heartbeat' && timestamp(body.at) && integer(body.cursor)) data = { at: body.at, cursor: body.cursor, bridge: bridge(body.bridge) };
            else if (type === 'bridge') data = bridge(body);
            else if (type === 'reset') data = {};
            if (data) {
              const id = type === 'town' ? `id: ${data.cursor}\n` : '';
              if (!res.write(`${id}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)) await once(res, 'drain', { signal: controller.signal });
            }
          }
        }
        res.end();
      }
    } catch {
      controller.abort();
      if (!res.destroyed) {
        if (res.headersSent) res.end(); else json(res, 503, { error: 'buddy_unavailable' });
      }
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
      res.removeListener('close', abort);
    }
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method_not_allowed' }); return; }
    if (url.pathname === '/api/town/fleet') {
      json(res, 200, { v: FLEET_VERSION, buddies: buddies.map(({ id, name }) => ({ id, name })) }); return;
    }
    const match = /^\/api\/town\/fleet\/([a-z][a-z0-9_-]{0,31})\/(snapshot|events)$/.exec(url.pathname);
    if (match) {
      const buddy = buddies.find(b => b.id === match[1]);
      if (!buddy) { json(res, 404, { error: 'not_found' }); return; }
      if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }); return; }
      void proxy(req, res, url, buddy, match[2]); return;
    }
    if (url.pathname.startsWith('/api/') || root === null) { json(res, 404, { error: 'not_found' }); return; }
    const file = resolveStatic(root, url.pathname);
    if (!file.ok) { json(res, file.reason === 'traversal' ? 403 : 404, { error: 'not_found' }); return; }
    const stream = fs.createReadStream(file.file);
    stream.on('error', () => { if (res.headersSent) res.destroy(); else json(res, 404, { error: 'not_found' }); });
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': contentTypeFor(file.file) });
    if (req.method === 'HEAD') { stream.destroy(); res.end(); } else stream.pipe(res);
  });
  return {
    server,
    listen(port, host = '127.0.0.1') {
      if (!isLoopbackHost(host)) return Promise.reject(new Error('Fleet only binds to loopback'));
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
      });
    },
    async close() {
      for (const controller of requests) controller.abort();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
