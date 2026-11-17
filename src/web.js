import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateInitData, createSessions } from './auth.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const MAX_BODY = 16 * 1024;
const MAX_STREAMS_PER_USER = 5;
const MIN_POST_INTERVAL_MS = 500;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const inRange = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (body === null || typeof body !== 'object') throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

/** HTTP server for the Mini App: static files, JSON API and a live event stream. */
export function createWeb({ service, config, me }) {
  const sessions = createSessions(config.botToken);
  const streams = new Map(); // userId -> Set<ServerResponse>
  const lastPost = new Map(); // userId -> ms

  const push = (userId, event, data) => {
    for (const res of streams.get(userId) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  service.on('location', (userId) => {
    const location = service.locationOf(userId);
    for (const viewer of service.audience(userId)) push(viewer, 'loc', { id: userId, location });
  });
  service.on('changed', (userIds) => {
    for (const id of new Set(userIds)) push(id, 'refresh', {});
  });

  const heartbeat = setInterval(() => {
    for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
  }, 20_000);
  heartbeat.unref();

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  /** @returns the signed-in user's id; throws 401 otherwise */
  const authenticate = (req, url) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
    const userId = sessions.verify(token);
    if (userId == null || !service.getUser(userId)) throw new HttpError(401, 'unauthorized');
    return userId;
  };

  const stateFor = (userId) => {
    const user = service.getUser(userId);
    return {
      ...service.stateFor(userId),
      inviteLink: `https://t.me/${me.username}?start=${user.invite_code}`,
      serverTime: Date.now(),
    };
  };

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'POST /api/auth') {
      const body = await readJson(req);
      const data = validateInitData(body.initData, config.botToken);
      if (!data) throw new HttpError(401, 'bad init data');
      const user = service.upsertUser(data.user, { photoUrl: data.user.photo_url ?? null });
      return json(res, 200, { token: sessions.issue(user.id) });
    }

    const userId = authenticate(req, url);

    if (route === 'GET /api/state') return json(res, 200, stateFor(userId));

    if (route === 'POST /api/location') {
      const body = await readJson(req);
      const lat = inRange(body.lat, -90, 90);
      const lon = inRange(body.lon, -180, 180);
      if (lat == null || lon == null) throw new HttpError(400, 'bad coordinates');
      const now = Date.now();
      if (now - (lastPost.get(userId) ?? 0) < MIN_POST_INTERVAL_MS) return json(res, 200, { stored: false });
      lastPost.set(userId, now);
      const stored = service.updateLocation(userId, {
        lat,
        lon,
        accuracy: inRange(body.accuracy, 0, 100_000),
        heading: inRange(body.heading, 0, 360),
        speed: inRange(body.speed, 0, 500),
        altitude: inRange(body.altitude, -1000, 100_000),
        source: 'app',
      });
      return json(res, 200, { stored });
    }

    if (route === 'POST /api/pause') {
      const body = await readJson(req);
      service.setPaused(userId, body.paused === true);
      return json(res, 200, stateFor(userId));
    }

    if (route === 'GET /api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      let set = streams.get(userId);
      if (!set) streams.set(userId, (set = new Set()));
      if (set.size >= MAX_STREAMS_PER_USER) set.values().next().value.end();
      set.add(res);
      res.on('close', () => {
        set.delete(res);
        if (!set.size && streams.get(userId) === set) streams.delete(userId);
      });
      return;
    }

    throw new HttpError(404, 'not found');
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'bad path');
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = join(PUBLIC_DIR, normalize(pathname));
    if (!file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, 'not found');
    let data;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': pathname.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return await serveStatic(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[web]', err);
      if (res.headersSent) return res.end();
      json(res, status, { error: status === 500 ? 'internal error' : err.message });
    }
  });

  return {
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => resolve(server.address().port));
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const set of streams.values()) for (const res of set) res.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
