// Viewfinder 모션 클립 → Hetzner Storage Box(WebDAV) 업로드 릴레이
// - 이 스크립트만 Storage Box 계정 정보를 가짐. viewfinder.html(브라우저)에는 절대 안 들어감.
// - viewfinder.html은 이 서버(http://localhost:8787)로:
//     POST /upload        — webm 파일 업로드
//     GET  /clips         — 업로드된 클립 목록 조회 (날짜별 폴더 전부 훑음)
//     GET  /file?path=... — 클립 재생용 스트림 (path는 반드시 PREFIX로 시작해야 함)
// - Node 내장 모듈만 사용(https/http) + dotenv. 별도 SDK 불필요.
//
// 실행 전 준비: npm install dotenv
// 실행: node hetzner-upload-relay.js  (또는 "viewfinder 시작.bat" 더블클릭)

import 'dotenv/config';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewfinder-client.log');

const PORT = process.env.RELAY_PORT || 8787;
const WEBDAV_URL = process.env.WEBDAV_URL;       // 예: https://u499532.your-storagebox.de
const WEBDAV_USER = process.env.WEBDAV_USER;     // 예: u499532
const WEBDAV_PASS = process.env.WEBDAV_PASS;
const PREFIX = (process.env.WEBDAV_PREFIX || 'viewfinder-motion/').replace(/^\/+/, '');

if (!WEBDAV_URL || !WEBDAV_USER || !WEBDAV_PASS) {
  console.error('[relay] .env에 WEBDAV_URL / WEBDAV_USER / WEBDAV_PASS 를 설정하세요.');
  process.exit(1);
}

const authHeader = 'Basic ' + Buffer.from(`${WEBDAV_USER}:${WEBDAV_PASS}`).toString('base64');

function webdavRequest(method, pathSuffix, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const target = new URL(WEBDAV_URL.replace(/\/+$/, '') + '/' + pathSuffix.replace(/^\/+/, ''));
    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname,
        method,
        headers: {
          Authorization: authHeader,
          ...(body ? { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } : {}),
          ...(extraHeaders || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// WebDAV는 S3와 달리 상위 폴더가 미리 있어야 PUT이 됨 — 없으면 만들고, 있으면 그냥 넘어감
const knownDirs = new Set();
async function ensureDir(dirPath) {
  if (knownDirs.has(dirPath)) return;
  const res = await webdavRequest('MKCOL', dirPath);
  if (res.statusCode === 201) console.log(`[relay] 폴더 생성됨: ${dirPath}`);
  else if (res.statusCode === 405 || res.statusCode === 409) { /* 이미 있음 — 조용히 통과 */ }
  else console.warn(`[relay] MKCOL 예상 밖 응답(${dirPath}): HTTP ${res.statusCode}`);
  knownDirs.add(dirPath);
}
ensureDir(PREFIX).catch((err) => console.error('[relay] 폴더 확인 실패:', err.message || err));

// PROPFIND(Depth: 1) 응답 XML을 파싱 (Apache mod_dav 기준, 네임스페이스 접두사는 유동적이라 정규식으로 느슨하게 매칭)
// Depth: infinity는 이 서버에서 403으로 막혀 있어서, 폴더 하나씩 Depth:1로 훑어서 직접 재귀함
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
    entries.push({
      path: href,
      isCollection,
      size: sizeMatch ? Number(sizeMatch[1]) : null,
      modified: modMatch ? modMatch[1] : null,
    });
  }
  return entries;
}

// PREFIX 아래 날짜 폴더들을 한 단계씩 훑어서 .webm 파일 전부 모음
async function listAllClips() {
  const files = [];
  const top = await webdavRequest('PROPFIND', PREFIX, undefined, { Depth: '1' });
  if (top.statusCode !== 207) throw new Error(`PROPFIND 실패(${PREFIX}): HTTP ${top.statusCode}`);
  const topEntries = parsePropfindLevel(top.body.toString('utf8'));
  const selfPath = topEntries[0] && topEntries[0].path; // 첫 항목은 자기 자신(PREFIX 폴더)
  for (const entry of topEntries) {
    if (entry.path === selfPath) continue; // 자기 자신 제외
    if (entry.isCollection) {
      // 날짜 폴더 하나 더 내려가서 훑음
      const sub = await webdavRequest('PROPFIND', entry.path, undefined, { Depth: '1' });
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

const MAX_BYTES = 200 * 1024 * 1024; // 200MB 안전장치

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  // ── POST /log — 브라우저 콘솔 에러를 서버 로그 파일로도 남김
  // (Sharon한테 콘솔 캡처해달라고 매번 부탁 안 해도 내가 viewfinder-client.log 직접 읽어서 확인 가능)
  if (req.method === 'POST' && url.pathname === '/log') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8').slice(0, 4000);
      const line = `[${new Date().toISOString()}] ${body}\n`;
      console.error('[client]', body);
      fs.appendFile(LOG_FILE, line, () => {});
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // ── GET /clips — 업로드된 클립 목록 ──────────────────────────────
  if (req.method === 'GET' && url.pathname === '/clips') {
    listAllClips()
      .then((clips) => sendJson(res, 200, { ok: true, clips }))
      .catch((err) => sendJson(res, 500, { ok: false, error: String(err.message || err) }));
    return;
  }

  // ── GET /file?path=... — 클립 재생 스트림 ────────────────────────
  // Range 헤더를 그대로 WebDAV로 전달해 206 Partial Content를 지원해야
  // <video>가 MediaRecorder 웹m 파일의 실제 재생시간을 뒤에서부터 스캔해서 알아낼 수 있음
  // (Range를 안 넘겨주면 브라우저가 duration을 못 구해서 항상 0초로 보임)
  if (req.method === 'GET' && url.pathname === '/file') {
    const path = (url.searchParams.get('path') || '').replace(/^\/+/, '');
    if (!path.startsWith(PREFIX) || path.includes('..')) {
      return sendJson(res, 400, { ok: false, error: 'invalid path' });
    }
    const range = req.headers['range'];
    webdavRequest('GET', path, undefined, range ? { Range: range } : undefined)
      .then((result) => {
        if (result.statusCode !== 200 && result.statusCode !== 206) {
          return sendJson(res, 404, { ok: false, error: `파일을 찾을 수 없음: HTTP ${result.statusCode}` });
        }
        const headers = {
          'Content-Type': 'video/webm',
          'Accept-Ranges': 'bytes',
          'Content-Length': result.body.length,
        };
        if (result.statusCode === 206 && result.headers['content-range']) {
          headers['Content-Range'] = result.headers['content-range'];
        }
        res.writeHead(result.statusCode, headers);
        res.end(result.body);
      })
      .catch((err) => sendJson(res, 500, { ok: false, error: String(err.message || err) }));
    return;
  }

  // ── POST /upload — 클립 업로드 ───────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/upload') {
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        aborted = true;
        sendJson(res, 413, { ok: false, error: 'file too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (aborted) return;
      try {
        const buffer = Buffer.concat(chunks);
        const rawName = req.headers['x-filename'] || `motion-${Date.now()}.webm`;
        const safeName = String(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');

        // 날짜별 하위 폴더로 정리 (예: viewfinder-motion/2026-09-21/motion-....webm)
        const dateFolder = new Date().toISOString().slice(0, 10);
        const dirPath = `${PREFIX}${dateFolder}/`;
        await ensureDir(dirPath);
        const key = `${dirPath}${safeName}`;

        const result = await webdavRequest('PUT', key, buffer);
        if (result.statusCode !== 201 && result.statusCode !== 204) {
          throw new Error(`WebDAV 업로드 실패: HTTP ${result.statusCode}`);
        }

        console.log(`[relay] uploaded ${key} (${(buffer.length / 1024).toFixed(0)} KB)`);
        sendJson(res, 200, { ok: true, key });
      } catch (err) {
        console.error('[relay] upload failed:', err);
        sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[relay] listening on http://localhost:${PORT}`);
  console.log(`[relay] uploading to WebDAV ${WEBDAV_URL}/${PREFIX}`);
});
