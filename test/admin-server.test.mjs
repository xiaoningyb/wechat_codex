import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminServer } from '../src/admin-server.mjs';
import { AuditLogger } from '../src/audit-logger.mjs';
import { Store } from '../src/store.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wecom-admin-'));
  const store = new Store(join(directory, 'state.sqlite'));
  const auditDirectory = join(directory, 'audit');
  const audit = new AuditLogger({ directory: auditDirectory });
  const logger = { error() {} };
  const admin = new AdminServer({ host: '127.0.0.1', port: 0, store, audit, auditDirectory, databasePath: join(directory, 'state.sqlite'), logger });
  return { directory, store, audit, auditDirectory, admin };
}

test('serves the local dashboard and read-only SQLite APIs', async () => {
  const { store, audit, admin } = fixture();
  store.upsertSession({ conversation_key: 'user:u1', userid: 'u1', project_id: 'p1', thread_id: 'thread-1', mode: 'readOnly', active_turn_id: null });
  audit.record('test.initial', { ok: true });
  const address = await admin.start();
  try {
    const page = await fetch(address);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /WeCom Codex 管理后台/);

    const status = await (await fetch(`${address}/api/status`)).json();
    assert.equal(status.address, address);

    const tables = await (await fetch(`${address}/api/db/tables`)).json();
    assert.equal(tables.tables.includes('sessions'), true);

    const rowsResponse = await fetch(`${address}/api/db/rows?table=sessions&limit=10&offset=0`);
    assert.equal(rowsResponse.status, 200);
    const rows = await rowsResponse.json();
    assert.equal(rows.total, 1);
    assert.equal(rows.rows[0].thread_id, 'thread-1');

    const invalid = await fetch(`${address}/api/db/rows?table=sessions%3BDROP%20TABLE%20sessions`);
    assert.equal(invalid.status, 400);
    const writeAttempt = await fetch(`${address}/api/db/tables`, { method: 'POST' });
    assert.equal(writeAttempt.status, 405);

    const recent = await (await fetch(`${address}/api/audit/recent?limit=10`)).json();
    assert.equal(recent.entries.some((entry) => entry.event === 'test.initial'), true);
  } finally {
    await admin.stop(); store.close();
  }
});

test('streams new audit entries over SSE', async () => {
  const { store, audit, admin } = fixture();
  const address = await admin.start();
  const controller = new AbortController();
  try {
    const response = await fetch(`${address}/api/audit/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read();
    audit.record('test.live', { value: 42 });
    let text = '';
    for (let index = 0; index < 5 && !text.includes('test.live'); index += 1) {
      const chunk = await reader.read(); text += new TextDecoder().decode(chunk.value || new Uint8Array());
    }
    assert.match(text, /test\.live/);
    await reader.cancel();
  } finally {
    controller.abort(); await admin.stop(); store.close();
  }
});

test('rejects non-loopback bind addresses', () => {
  const { store, audit, auditDirectory } = fixture();
  assert.throws(() => new AdminServer({ host: '0.0.0.0', port: 17321, store, audit, auditDirectory, databasePath: 'test', logger: { error() {} } }), /回环地址/);
  store.close();
});
