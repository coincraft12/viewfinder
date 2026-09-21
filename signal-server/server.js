// Viewfinder 원격 보기용 WebRTC 시그널링 릴레이
// - 영상 데이터는 절대 이 서버를 거치지 않음. 브로드캐스터(PC)와 뷰어(폰 등)가 SDP/ICE
//   정보만 이 서버를 통해 교환하고, 실제 영상은 두 기기가 P2P로 직접 주고받음(WebRTC).
// - "방(room)"은 token으로 구분됨. 같은 token을 아는 사람만 같은 방에 들어올 수 있음
//   (개인용 도구 수준의 최소 인증 — 엔터프라이즈급 보안 아님).
// - 실행: node server.js (PORT는 SIGNAL_PORT 환경변수, 기본 8790)

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = process.env.SIGNAL_PORT || 8790;

const server = createServer((req, res) => {
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
