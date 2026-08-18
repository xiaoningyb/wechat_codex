import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, chmodSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const CREDENTIAL_KEYS = /^(secret|bot_?secret|client_?secret|token|authorization|response_url|aeskey|access_token|password|cookie)$/i;
const IDENTITY_KEYS = /^(userid|user_id|conversation_key|conversationKey|target|msgid|messageId)$/i;
const AUDIT_FILE = /^audit-(\d{4}-\d{2}-\d{2})\.(\d{4})\.jsonl$/;
const TEXT_SECRETS = [
  /([?&](?:access_token|key|secret|token)=)[^&\s]+/gi,
  /(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,
  /((?:Bot\s*)?Secret\s*[：:]\s*)[^\s,，;；]+/gi,
  /((?:password|token|access_token|authorization)\s*[：:=]\s*)[^\s,，;；]+/gi,
  /(["']?(?:secret|token|password|authorization)["']?\s*:\s*["'])[^"']+/gi,
];

function hashIdentity(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}`;
}

function scrubText(value) {
  return TEXT_SECRETS.reduce((text, pattern) => text.replace(pattern, '$1[REDACTED]'), value);
}

export function sanitizeAudit(value, key = '', seen = new WeakSet()) {
  if (CREDENTIAL_KEYS.test(key)) return '[REDACTED]';
  if (IDENTITY_KEYS.test(key) && value !== null && value !== undefined) return hashIdentity(value);
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => sanitizeAudit(item, '', seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const output = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizeAudit(item, name, seen)]));
    seen.delete(value);
    return output;
  }
  return value;
}

export class AuditLogger extends EventEmitter {
  constructor({ directory, maxFileBytes = 50 * 1024 * 1024, retentionDays = 30, onError = null, now = () => new Date() }) {
    super();
    this.directory = directory;
    this.maxFileBytes = Math.max(1024, Number(maxFileBytes));
    this.retentionDays = Math.max(1, Number(retentionDays));
    this.onError = onError;
    this.now = now;
    this.currentDate = null;
    this.currentPart = 0;
    this.currentPath = null;
    this.currentSize = 0;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.prune();
  }

  record(event, data = {}) {
    try {
      const timestamp = this.now();
      const entry = sanitizeAudit({ timestamp: timestamp.toISOString(), event, data });
      const line = `${JSON.stringify(entry)}\n`;
      this.ensureTarget(timestamp.toISOString().slice(0, 10), Buffer.byteLength(line));
      appendFileSync(this.currentPath, line, { encoding: 'utf8', mode: 0o600 });
      chmodSync(this.currentPath, 0o600);
      this.currentSize += Buffer.byteLength(line);
      this.emit('entry', entry);
    } catch (error) {
      if (this.onError) this.onError(error);
    }
  }

  ensureTarget(date, incomingBytes) {
    if (this.currentDate !== date) {
      this.prune();
      this.currentDate = date;
      const parts = readdirSync(this.directory).map((name) => name.match(AUDIT_FILE)).filter((match) => match?.[1] === date).map((match) => Number(match[2]));
      this.currentPart = parts.length ? Math.max(...parts) : 1;
      this.currentPath = this.pathFor(date, this.currentPart);
      try { this.currentSize = statSync(this.currentPath).size; } catch { this.currentSize = 0; }
    }
    if (this.currentSize > 0 && this.currentSize + incomingBytes > this.maxFileBytes) {
      this.currentPart += 1;
      this.currentPath = this.pathFor(date, this.currentPart);
      this.currentSize = 0;
    }
  }

  pathFor(date, part) { return join(this.directory, `audit-${date}.${String(part).padStart(4, '0')}.jsonl`); }

  prune() {
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(this.directory)) {
      if (!AUDIT_FILE.test(name)) continue;
      const path = join(this.directory, name);
      try { if (statSync(path).mtimeMs < cutoff) unlinkSync(path); } catch (error) { if (this.onError) this.onError(error); }
    }
  }
}
