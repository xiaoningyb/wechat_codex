import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_PAGE } from './admin-page.mjs';

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOOPBACKS = new Set(['127.0.0.1', '::1', 'localhost']);

function jsonValue(_key, value) { return typeof value === 'bigint' ? value.toString() : value; }
function sendJson(response, status, value) {
  const body = JSON.stringify(value, jsonValue);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(body);
}

export class AdminServer {
  constructor({ host = '127.0.0.1', port = 17321, store, audit, auditDirectory, databasePath, logger }) {
    if (!LOOPBACKS.has(host)) throw new Error('管理后台只允许监听本机回环地址');
    this.host = host; this.port = Number(port); this.store = store; this.audit = audit; this.auditDirectory = auditDirectory; this.databasePath = databasePath; this.logger = logger;
    this.startedAt = Date.now(); this.server = null; this.sseClients = new Set();
  }

  async start() {
    if (this.server) return this.address();
    this.server = createServer((request, response) => this.handle(request, response));
    this.server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.host, resolve); });
    this.audit?.on('entry', this.onAuditEntry);
    return this.address();
  }

  async stop() {
    if (!this.server) return;
    this.audit?.off('entry', this.onAuditEntry);
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
    const server = this.server; this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }

  address() {
    const address = this.server?.address();
    const port = typeof address === 'object' && address ? address.port : this.port;
    return `http://${this.host.includes(':') ? `[${this.host}]` : this.host}:${port}`;
  }

  onAuditEntry = (entry) => {
    const payload = `data: ${JSON.stringify(entry, jsonValue)}\n\n`;
    for (const client of this.sseClients) client.write(payload);
  };

  handle(request, response) {
    try {
      this.applySecurityHeaders(response);
      if (!this.validHost(request.headers.host)) return sendJson(response, 403, { error: 'Host 不允许' });
      if (request.method !== 'GET') return sendJson(response, 405, { error: '管理后台仅支持只读 GET 请求' });
      const url = new URL(request.url || '/', this.address());
      if (url.pathname === '/') return this.page(response);
      if (url.pathname === '/api/status') return sendJson(response, 200, { uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000), address: this.address(), databasePath: this.databasePath, auditDirectory: this.auditDirectory });
      if (url.pathname === '/api/audit/recent') return sendJson(response, 200, { entries: this.recentAudit(url.searchParams) });
      if (url.pathname === '/api/audit/stream') return this.stream(request, response);
      if (url.pathname === '/api/db/tables') return sendJson(response, 200, { tables: this.tableNames() });
      if (url.pathname === '/api/db/rows') return this.rows(response, url.searchParams);
      return sendJson(response, 404, { error: '接口不存在' });
    } catch (error) {
      this.logger?.error('管理后台请求失败', error.message);
      if (!response.headersSent) sendJson(response, 500, { error: error.message }); else response.end();
    }
  }

  validHost(value) {
    if (!value) return false;
    const hostname = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.split(':')[0];
    return LOOPBACKS.has(hostname);
  }

  applySecurityHeaders(response) {
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }

  page(response) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(ADMIN_PAGE), 'Cache-Control': 'no-store' });
    response.end(ADMIN_PAGE);
  }

  stream(request, response) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    response.write('retry: 2000\n\n'); this.sseClients.add(response);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000); heartbeat.unref();
    request.on('close', () => { clearInterval(heartbeat); this.sseClients.delete(response); });
  }

  recentAudit(searchParams) {
    const limit = Math.min(1000, Math.max(1, Number(searchParams.get('limit') || 200)));
    const eventFilter = searchParams.get('event') || '';
    const files = readdirSync(this.auditDirectory).filter((name) => /^audit-\d{4}-\d{2}-\d{2}\.\d{4}\.jsonl$/.test(name)).sort().reverse();
    const entries = [];
    for (const file of files) {
      const lines = readFileSync(join(this.auditDirectory, file), 'utf8').split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        try { const entry = JSON.parse(line); if (!eventFilter || entry.event === eventFilter) entries.push(entry); } catch {}
        if (entries.length >= limit) return entries.reverse();
      }
    }
    return entries.reverse();
  }

  tableNames() {
    return this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name).filter((name) => TABLE_NAME.test(name));
  }

  rows(response, searchParams) {
    const table = searchParams.get('table') || '';
    if (!TABLE_NAME.test(table) || !this.tableNames().includes(table)) return sendJson(response, 400, { error: '数据表不允许' });
    const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit') || 50)));
    const offset = Math.max(0, Number(searchParams.get('offset') || 0));
    const quoted = `"${table}"`;
    const columns = this.store.db.prepare(`PRAGMA table_info(${quoted})`).all().map(({ name, type, notnull, pk }) => ({ name, type, notnull: Boolean(notnull), pk: Boolean(pk) }));
    const rows = this.store.db.prepare(`SELECT * FROM ${quoted} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(limit, offset);
    const total = Number(this.store.db.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get().count);
    return sendJson(response, 200, { table, columns, rows, total, limit, offset });
  }
}
