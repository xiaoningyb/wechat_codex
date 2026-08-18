import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.mjs';
import { CodexAppServer } from '../src/codex-app-server.mjs';
import { createLogger } from '../src/logger.mjs';
import { Store } from '../src/store.mjs';
import { AuditLogger } from '../src/audit-logger.mjs';

class FakeWeCom extends EventEmitter {
  constructor() { super(); this.replies = []; }
  async replyStream(_frame, streamId, content, finish) {
    const reply = { streamId, content, finish };
    this.replies.push(reply); this.emit('reply', reply);
  }
  async sendMessage() {}
  async updateTemplateCard() {}
}

function waitForTurn(codex, turnId, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${turnId} 完成超时`)), timeoutMs);
    const listener = (message) => {
      if (message.method !== 'turn/completed' || message.params.turn.id !== turnId) return;
      clearTimeout(timer); codex.off('notification', listener);
      if (message.params.turn.status === 'completed') resolve();
      else reject(new Error(`目标任务状态：${message.params.turn.status}`));
    };
    codex.on('notification', listener);
  });
}

const logger = createLogger();
const runtimeDirectory = mkdtempSync(join(tmpdir(), 'wecom-cross-thread-'));
const auditDirectory = join(runtimeDirectory, 'audit');
const audit = new AuditLogger({ directory: auditDirectory });
const codex = new CodexAppServer({ logger, audit });
const wecom = new FakeWeCom();
const cwd = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const store = new Store(join(runtimeDirectory, 'state.sqlite'));
const config = { projects: [{ id: 'bridge', name: 'bridge', path: cwd }], defaultProject: 'bridge', authorizedUsers: [], model: null, effort: null, streamIntervalMs: 500 };
const bridge = new Bridge({ wecom, codex, store, config, logger, audit }); bridge.attach();

try {
  await codex.start();
  const targetThread = await codex.startThread({ cwd, mode: 'readOnly' });
  const setupTurn = await codex.startTurn({ threadId: targetThread.id, text: '只回复 TARGET_READY，不要调用任何工具。', cwd, mode: 'readOnly' });
  await waitForTurn(codex, setupTurn.id);

  const session = { conversation_key: 'user:test-user', userid: 'test-user', project_id: 'bridge', thread_id: null, mode: 'readOnly', active_turn_id: null };
  store.upsertSession(session);
  const frame = { body: { msgid: 'msg-real-cross-thread', chattype: 'single', from: { userid: 'test-user' } } };
  await bridge.beginThreadSelection(frame, session);
  const alias = store.db.prepare('SELECT position FROM thread_aliases WHERE conversation_key=? AND thread_id=?').get(session.conversation_key, targetThread.id);
  if (!alias) throw new Error('真实目标线程未出现在“选择对话”列表中');
  await bridge.handleThreadSelection(frame, session, String(alias.position));
  if (store.getSession(session.conversation_key).thread_id !== targetThread.id) throw new Error('输入序号后没有进入真实目标线程');
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待跨对话企业微信回复超时')), 120_000);
    wecom.on('reply', (reply) => {
      if (!reply.finish || !reply.content.includes('CROSS_THREAD_OK')) return;
      clearTimeout(timer); resolve(reply);
    });
  });
  await bridge.startOrSteer(frame, session, '只回复 CROSS_THREAD_OK，不要调用任何工具。');
  await completed;
  if (store.getSession(session.conversation_key).active_turn_id !== null) throw new Error('跨对话完成后 active_turn_id 未清空');
  await bridge.createNewConversation(frame, session);
  const newThreadId = store.getSession(session.conversation_key).thread_id;
  if (!newThreadId || newThreadId === targetThread.id) throw new Error('没有立即创建新的空白线程');
  const emptyContextCompleted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待空白对话首轮回复超时')), 120_000);
    wecom.on('reply', (reply) => {
      if (!reply.finish || !reply.content.includes('EMPTY_CONTEXT_OK')) return;
      clearTimeout(timer); resolve(reply);
    });
  });
  await bridge.startOrSteer({ body: { ...frame.body, msgid: 'msg-real-empty-context' } }, session, '只回复 EMPTY_CONTEXT_OK，不要调用任何工具。');
  await emptyContextCompleted;
  const auditEntries = readdirSync(auditDirectory).flatMap((name) => readFileSync(join(auditDirectory, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  const events = new Set(auditEntries.map((entry) => entry.event));
  for (const required of ['codex.rpc.outbound', 'codex.rpc.inbound', 'wecom.outbound.replyStream']) {
    if (!events.has(required)) throw new Error(`真实审计日志缺少事件：${required}`);
  }
  if (!auditEntries.some((entry) => entry.event === 'codex.rpc.outbound' && entry.data.message.method === 'turn/start')) throw new Error('真实审计日志缺少 turn/start');
  if (!auditEntries.some((entry) => entry.event === 'codex.rpc.inbound' && entry.data.message.method === 'turn/completed')) throw new Error('真实审计日志缺少 turn/completed');
  console.log(`REAL_DIALOG_FLOW_OK selected=${targetThread.id} created=${newThreadId}`);
} finally {
  codex.stop(); store.close();
}
