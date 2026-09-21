// Viewfinder 원격 보기용 서버 (custody-staging에 배포되어 상시 구동)
// - WebRTC 시그널링 릴레이: 영상 데이터는 절대 이 서버를 거치지 않음. 브로드캐스터(PC)와
//   뷰어(폰 등)가 SDP/ICE 정보만 이 서버를 통해 교환하고, 실제 영상은 두 기기가 P2P로 직접 주고받음.
// - 저장된 클립 열람: Hetzner Storage Box(WebDAV)에서 직접 읽어와 GET /clips, GET /file로 제공.
//   (PC의 로컬 relay(hetzner-upload-relay.js)와 달리 이건 인터넷 어디서나 접근 가능해야 하는 용도)
// - "방(room)"/클립 열람 모두 token으로만 구분됨 — 아는 사람만 접근 가능한 수준의 최소 인증
//   (개인용 도구 수준, 엔터프라이즈급 보안 아님).
// - 실행: node server.js (PORT는 SIGNAL_PORT 환경변수, 기본 8790)

import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';

const PORT = process.env.SIGNAL_PORT || 8790;
const WEBDAV_URL = process.env.WEBDAV_URL;
const WEBDAV_USER = process.env.WEBDAV_USER;
const WEBDAV_PASS = process.env.WEBDAV_PASS;
const PREFIX = (process.env.WEBDAV_PREFIX || 'viewfinder-motion/').replace(/^\/+/, '');
const hasWebdav = Boolean(WEBDAV_URL && WEBDAV_USER && WEBDAV_PASS);
if (!hasWebdav) {
  console.warn('[signal] .env에 WEBDAV_* 없음 — 원격 클립 열람(/clips, /file)은 비활성 상태로 시작함');
}

const authHeader = hasWebdav ? 'Basic ' + Buffer.from(`${WEBDAV_USER}:${WEBDAV_PASS}`).toString('base64') : null;

function webdavRequest(method, pathSuffix, extraHeaders) {
  return new Promise((resolve, reject) => {
    const target = new URL(WEBDAV_URL.replace(/\/+$/, '') + '/' + pathSuffix.replace(/^\/+/, ''));
    const req = https.request(
      { hostname: target.hostname, path: target.pathname, method, headers: { Authorization: authHeader, ...(extraHeaders || {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// PROPFIND(Depth: 1) XML 파싱 — hetzner-upload-relay.js와 동일 로직(WebDAV 서버가 Depth:infinity를 막아놔서 한 단계씩 재귀)
function parsePropfindLevel(xml) {
  const entries = [];
  const blocks = xml.match(/<D:response[\s\S]*?<\/D:response>/g) || [];
  for (const block of blocks) {
    const hrefMatch = /<D:href>([^<]*)<\/D:href>/.exec(block);
    if (!hrefMatch) continue;
    const href = decodeURIComponent(hrefMatch[1]).replace(/^\/+/, '');
    const isCollection = /:collection\s*\/?>/.test(block);
    const sizeMatch = /:getcontentlength>(\d+)</.exec(block);
    const modMatch = /:getlastmodified>([^<]*)</.exec(block);
    entries.push({ path: href, isCollection, size: sizeMatch ? Number(sizeMatch[1]) : null, modified: modMatch ? modMatch[1] : null });
  }
  return entries;
}

async function listAllClips() {
  const files = [];
  const top = await webdavRequest('PROPFIND', PREFIX, { Depth: '1' });
  if (top.statusCode !== 207) throw new Error(`PROPFIND 실패(${PREFIX}): HTTP ${top.statusCode}`);
  const topEntries = parsePropfindLevel(top.body.toString('utf8'));
  const selfPath = topEntries[0] && topEntries[0].path;
  for (const entry of topEntries) {
    if (entry.path === selfPath) continue;
    if (entry.isCollection) {
      const sub = await webdavRequest('PROPFIND', entry.path, { Depth: '1' });
      if (sub.statusCode !== 207) continue;
      const subEntries = parsePropfindLevel(sub.body.toString('utf8'));
      const subSelfPath = subEntries[0] && subEntries[0].path;
      for (const f of subEntries) {
        if (f.path === subSelfPath || f.isCollection) continue;
        if (!f.path.endsWith('.webm')) continue;
        files.push({ path: f.path, name: f.path.split('/').pop(), size: f.size, modified: f.modified });
      }
    } else if (entry.path.endsWith('.webm')) {
      files.push({ path: entry.path, name: entry.path.split('/').pop(), size: entry.size, modified: entry.modified });
    }
  }
  return files.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // 클립 열람은 URL에 token만 있으면 통과(라이브 보기와 동일한 최소 보안 수준) — 실제 값 검증은 안 함
  const requireToken = () => Boolean(url.searchParams.get('token'));

  if (req.method === 'GET' && url.pathname === '/viewfinder-clips') {
    if (!hasWebdav) return sendJson(res, 503, { ok: false, error: 'webdav not configured on server' });
    if (!requireToken()) return sendJson(res, 401, { ok: false, error: 'token required' });
    listAllClips()
      .then((clips) => sendJson(res, 200, { ok: true, clips }))
      .catch((err) => sendJson(res, 500, { ok: false, error: String(err.message || err) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/viewfinder-file') {
    if (!hasWebdav) return sendJson(res, 503, { ok: false, error: 'webdav not configured on server' });
    if (!requireToken()) return sendJson(res, 401, { ok: false, error: 'token required' });
    const path = (url.searchParams.get('path') || '').replace(/^\/+/, '');
    if (!path.startsWith(PREFIX) || path.includes('..')) return sendJson(res, 400, { ok: false, error: 'invalid path' });
    const range = req.headers['range'];
    webdavRequest('GET', path, range ? { Range: range } : undefined)
      .then((result) => {
        if (result.statusCode !== 200 && result.statusCode !== 206) {
          return sendJson(res, 404, { ok: false, error: `파일을 찾을 수 없음: HTTP ${result.statusCode}` });
        }
        const headers = { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': result.body.length };
        if (result.statusCode === 206 && result.headers['content-range']) headers['Content-Range'] = result.headers['content-range'];
        res.writeHead(result.statusCode, headers);
        res.end(result.body);
      })
      .catch((err) => sendJson(res, 500, { ok: false, error: String(err.message || err) }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('viewfinder-signal-server ok');
});

const wss = new WebSocketServer({ server });

// token -> { broadcaster: ws|null, viewers: Map<viewerId, ws> }
const rooms = new Map();

function getRoom(token) {
  if (!rooms.has(token)) rooms.set(token, { broadcaster: null, viewers: new Map() });
  return rooms.get(token);
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const role = url.searchParams.get('role');
  const token = url.searchParams.get('token');

  if (!token || (role !== 'broadcaster' && role !== 'viewer')) {
    ws.close(1008, 'invalid role/token');
    return;
  }
  const room = getRoom(token);

  if (role === 'broadcaster') {
    room.broadcaster = ws;
    // 브로드캐스터가 (재)접속했을 때 이미 기다리고 있던 뷰어가 있으면 알려줌
    for (const viewerId of room.viewers.keys()) {
      safeSend(ws, { type: 'viewer-joined', viewerId });
    }
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const viewer = room.viewers.get(msg.viewerId);
      safeSend(viewer, msg);
    });
    ws.on('close', () => {
      if (room.broadcaster === ws) room.broadcaster = null;
    });
  } else {
    const viewerId = randomUUID();
    room.viewers.set(viewerId, ws);
    safeSend(ws, { type: 'joined', viewerId });
    safeSend(room.broadcaster, { type: 'viewer-joined', viewerId });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      msg.viewerId = viewerId; // 뷰어가 뭐라 보내든 서버가 확실히 본인 id로 태깅해서 위조 방지
      safeSend(room.broadcaster, msg);
    });
    ws.on('close', () => {
      room.viewers.delete(viewerId);
      safeSend(room.broadcaster, { type: 'viewer-left', viewerId });
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[signal] listening on 127.0.0.1:${PORT}`);
});
