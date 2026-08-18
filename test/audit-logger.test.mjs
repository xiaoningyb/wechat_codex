import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger, sanitizeAudit } from '../src/audit-logger.mjs';

test('writes append-only JSONL with identity hashing and credential redaction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wecom-audit-'));
  const fixed = new Date('2026-08-17T12:00:00.000Z');
  const audit = new AuditLogger({ directory, now: () => fixed });
  audit.record('wecom.inbound', {
    userid: 'XiaoNing', conversationKey: 'user:XiaoNing',
    text: 'Secret：super-secret Bearer abc.def',
    nested: { authorization: 'Bearer raw-token' },
  });
  const files = readdirSync(directory);
  assert.deepEqual(files, ['audit-2026-08-17.0001.jsonl']);
  const entry = JSON.parse(readFileSync(join(directory, files[0]), 'utf8').trim());
  assert.match(entry.data.userid, /^sha256:/);
  assert.notEqual(entry.data.userid, 'XiaoNing');
  assert.equal(entry.data.nested.authorization, '[REDACTED]');
  assert.equal(entry.data.text.includes('super-secret'), false);
  assert.equal(entry.data.text.includes('abc.def'), false);
  assert.equal(statSync(join(directory, files[0])).mode & 0o777, 0o600);
});

test('rotates audit JSONL files by size', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wecom-audit-rotate-'));
  const audit = new AuditLogger({ directory, maxFileBytes: 1024, now: () => new Date('2026-08-17T12:00:00.000Z') });
  audit.record('large.one', { content: 'a'.repeat(800) });
  audit.record('large.two', { content: 'b'.repeat(800) });
  assert.deepEqual(readdirSync(directory).sort(), ['audit-2026-08-17.0001.jsonl', 'audit-2026-08-17.0002.jsonl']);
});

test('handles circular audit payloads without failing', () => {
  const value = { name: 'root' }; value.self = value;
  assert.equal(sanitizeAudit(value).self, '[Circular]');
});
