import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';

test('persists owner, session and message deduplication', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-store-')), 'state.sqlite'));
  assert.equal(store.claimOwner('u1'), true); assert.equal(store.claimOwner('u2'), false);
  store.markProcessed('m1'); assert.equal(store.hasProcessed('m1'), true);
  store.upsertSession({ conversation_key: 'user:u1', userid: 'u1', project_id: 'p1', thread_id: null, mode: 'readOnly', active_turn_id: null });
  assert.equal(store.getSession('user:u1').project_id, 'p1');
  store.replaceThreadAliases('user:u1', [{ threadId: 'thread-1', projectId: 'p1' }, { threadId: 'thread-2', projectId: 'p2' }]);
  assert.equal(store.resolveThreadAlias('user:u1', 2).thread_id, 'thread-2');
  store.setInteractionState('user:u1', 'select_thread', { count: 2 });
  assert.deepEqual(store.getInteractionState('user:u1').payload, { count: 2 });
  store.clearInteractionState('user:u1');
  assert.equal(store.getInteractionState('user:u1'), null);
  store.close();
});

test('recovers stale active work after a service restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wecom-recovery-')), 'state.sqlite');
  let store = new Store(path);
  store.upsertSession({ conversation_key: 'user:u1', userid: 'u1', project_id: 'p1', thread_id: 'thread-1', mode: 'readOnly', active_turn_id: 'turn-1' });
  store.createTurn({ turnId: 'turn-1', conversationKey: 'user:u1', threadId: 'thread-1', prompt: 'test' });
  store.close();
  store = new Store(path);
  assert.equal(store.getSession('user:u1').active_turn_id, null);
  assert.equal(store.db.prepare('select status from turns where turn_id=?').get('turn-1').status, 'interrupted');
  store.close();
});
