import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bridge } from '../src/bridge.mjs';
import { Store } from '../src/store.mjs';

class FakeWeCom extends EventEmitter {
  constructor() { super(); this.sent = []; this.updated = []; this.replies = []; }
  async replyStream(_frame, streamId, content, finish) { this.replies.push({ streamId, content, finish }); }
  async sendMessage(target, body) { this.sent.push({ target, body }); }
  async updateTemplateCard(_frame, card) { this.updated.push(card); }
}

class FakeCodex extends EventEmitter {
  constructor(thread) { super(); this.thread = thread; this.calls = []; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/read') return { thread: this.thread };
    if (method === 'thread/list') return { data: this.thread.cwd === params.cwd ? [this.thread] : [] };
    throw new Error(`unexpected method ${method}`);
  }
  async resumeThread(threadId) { this.calls.push({ method: 'thread/resume', threadId }); return this.thread; }
  async startThread(params) { this.calls.push({ method: 'thread/start', params }); return { id: 'thread-new', cwd: params.cwd, status: { type: 'idle' } }; }
  async startTurn(params) { this.calls.push({ method: 'turn/start', params }); return { id: 'turn-target' }; }
}

test('routes an approval card decision back to App Server', async () => {
  const wecom = new FakeWeCom(); const codex = new EventEmitter();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-approval-')), 'state.sqlite'));
  const bridge = new Bridge({ wecom, codex, store, config: { projects: [], authorizedUsers: [], streamIntervalMs: 500 }, logger: { error() {} } });
  const session = { conversation_key: 'user:u1' };
  bridge.turns.set('turn-1', { target: 'u1', session });
  let response;
  await bridge.handleServerRequest({
    message: { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'npm test', cwd: '/tmp/project' } },
    respond: (value) => { response = value; },
  });
  assert.equal(wecom.sent.length, 1);
  const taskId = wecom.sent[0].body.template_card.task_id;
  await bridge.handleCard({ body: { event: { eventtype: 'template_card_event', template_card_event: { card_type: 'button_interaction', event_key: 'approve', task_id: taskId } } } });
  assert.deepEqual(response, { decision: 'accept' });
  assert.equal(store.getApproval(taskId).status, 'accept');
  assert.deepEqual(wecom.updated[0].card_action, { type: 1, url: 'https://work.weixin.qq.com/' });
  await bridge.handleCard({ body: { event: { template_card_event: { event_key: 'approve', task_id: taskId } } } });
  assert.equal(wecom.updated[1].main_title.title, '已允许 ✅');
  store.close();
});

test('confirms separately when an accepted approval card cannot be updated', async () => {
  const wecom = new FakeWeCom(); const codex = new EventEmitter();
  wecom.updateTemplateCard = async () => { throw { errcode: 42045, errmsg: 'invalid card' }; };
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-card-fallback-')), 'state.sqlite'));
  const warnings = [];
  const bridge = new Bridge({ wecom, codex, store, config: { projects: [], authorizedUsers: [], streamIntervalMs: 500 }, logger: { error() {}, warn(...args) { warnings.push(args); } } });
  const session = { conversation_key: 'user:u1' };
  bridge.turns.set('turn-1', { target: 'u1', session });
  let response;
  await bridge.handleServerRequest({
    message: { id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'npm test', cwd: '/tmp/project' } },
    respond: (value) => { response = value; },
  });
  const taskId = wecom.sent[0].body.template_card.task_id;
  await bridge.handleCard({ body: { event: { template_card_event: { event_key: 'approve', task_id: taskId } } } });
  assert.deepEqual(response, { decision: 'accept' });
  assert.equal(store.getApproval(taskId).status, 'accept');
  assert.equal(wecom.sent[1].body.markdown.content.includes('已允许'), true);
  assert.equal(warnings.length, 1);
  store.close();
});

test('ignores malformed approval events without crashing', async () => {
  const wecom = new FakeWeCom(); const codex = new EventEmitter();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-malformed-')), 'state.sqlite'));
  const warnings = [];
  const bridge = new Bridge({ wecom, codex, store, config: { projects: [], authorizedUsers: [], streamIntervalMs: 500 }, logger: { error() {}, warn(...args) { warnings.push(args); } } });
  await bridge.handleCard({ body: { event: { event_key: 'approve' } } });
  assert.equal(warnings.length, 1);
  store.close();
});

test('creates a diagnostic approval card without starting a Codex command', async () => {
  const wecom = new FakeWeCom(); const codex = new EventEmitter();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-diagnostic-')), 'state.sqlite'));
  const bridge = new Bridge({ wecom, codex, store, config: { projects: [], authorizedUsers: [], streamIntervalMs: 500 }, logger: { error() {}, info() {} } });
  const session = { conversation_key: 'user:u1', thread_id: null };
  await bridge.sendApprovalTest({ body: { from: { userid: 'u1' }, chattype: 'single' } }, session, async () => {});
  assert.equal(wecom.sent.length, 1);
  assert.equal(wecom.sent[0].body.template_card.main_title.title, '审批卡片全链路测试');
  const taskId = wecom.sent[0].body.template_card.task_id;
  assert.equal(store.getApproval(taskId).kind, 'test');
  assert.equal(store.getApproval(taskId).status, 'pending');
  store.close();
});

test('sends a message directly to an allowlisted App Server thread', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-target-project-'));
  const wecom = new FakeWeCom();
  const codex = new FakeCodex({ id: 'thread-target', cwd: projectPath, status: { type: 'idle' }, name: 'target' });
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-direct-send-')), 'state.sqlite'));
  const config = { projects: [{ id: 'target', name: 'Target', path: projectPath }], defaultProject: 'target', authorizedUsers: [], streamIntervalMs: 500, model: null, effort: null };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  const session = { conversation_key: 'user:u1', userid: 'u1', project_id: 'target', thread_id: null, mode: 'readOnly', active_turn_id: null };
  store.upsertSession(session);
  store.replaceThreadAliases(session.conversation_key, [{ threadId: 'thread-target', projectId: 'target' }]);
  const frame = { body: { msgid: 'm-direct', chattype: 'single', from: { userid: 'u1' } } };
  await bridge.sendToThread(frame, session, '1', '更新插件');
  assert.equal(codex.calls.some((call) => call.method === 'thread/resume' && call.threadId === 'thread-target'), true);
  const start = codex.calls.find((call) => call.method === 'turn/start');
  assert.equal(start.params.threadId, 'thread-target');
  assert.equal(start.params.cwd, projectPath);
  assert.equal(start.params.text, '更新插件');
  assert.equal(store.getSession('user:u1').active_turn_id, 'turn-target');
  store.close();
});

test('sends a separate completion notification when a Codex turn finishes', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-completion-project-'));
  const wecom = new FakeWeCom(); const codex = new EventEmitter();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-completion-store-')), 'state.sqlite'));
  const config = { projects: [{ id: 'p1', name: '项目一', path: projectPath }], defaultProject: 'p1', authorizedUsers: [], streamIntervalMs: 500 };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  const session = { conversation_key: 'user:u1', userid: 'u1', project_id: 'p1', thread_id: 'thread-1', mode: 'readOnly', active_turn_id: 'turn-1' };
  store.upsertSession(session);
  store.createTurn({ turnId: 'turn-1', conversationKey: session.conversation_key, threadId: session.thread_id, prompt: '执行任务' });
  bridge.turns.set('turn-1', {
    frame: { body: { msgid: 'm-finish', chattype: 'single', from: { userid: 'u1' } } },
    streamId: 'stream-1',
    target: 'u1',
    session,
    text: '最终结果',
    lastSent: '',
    statuses: ['🔧 npm test'],
  });
  await bridge.finishTurn('turn-1', 'completed');
  assert.equal(wecom.replies.at(-1).finish, true);
  assert.equal(wecom.replies.at(-1).content.includes('最终结果'), true);
  assert.equal(wecom.sent.length, 1);
  assert.equal(wecom.sent[0].target, 'u1');
  assert.equal(wecom.sent[0].body.markdown.content.startsWith('```text\n'), true);
  assert.equal(wecom.sent[0].body.markdown.content.includes('✅ Codex 任务已完成'), true);
  assert.equal(wecom.sent[0].body.markdown.content.includes('线程：thread-1'), true);
  assert.equal(store.getSession(session.conversation_key).active_turn_id, null);
  assert.equal(store.db.prepare('SELECT status FROM turns WHERE turn_id=?').get('turn-1').status, 'completed');
  store.close();
});

test('keeps pending start context so early approval requests show a card', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-early-approval-project-'));
  const wecom = new FakeWeCom();
  let bridge;
  let approvalResponse;
  class EarlyApprovalCodex extends FakeCodex {
    async startTurn(params) {
      this.calls.push({ method: 'turn/start', params });
      await bridge.handleServerRequest({
        message: { id: 21, method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId, turnId: 'turn-early', itemId: 'cmd-1', command: 'npm test', cwd: params.cwd } },
        respond: (value) => { approvalResponse = value; },
      });
      return { id: 'turn-early' };
    }
  }
  const codex = new EarlyApprovalCodex({ id: 'thread-early', cwd: projectPath, status: { type: 'idle' } });
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-early-approval-store-')), 'state.sqlite'));
  const config = { projects: [{ id: 'p1', name: '项目一', path: projectPath }], defaultProject: 'p1', authorizedUsers: [], streamIntervalMs: 500, progressIntervalMs: 5000, model: null, effort: null };
  bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  const session = { conversation_key: 'user:u1', userid: 'u1', project_id: 'p1', thread_id: 'thread-early', mode: 'readOnly', active_turn_id: null };
  await bridge.startOrSteer({ body: { msgid: 'm-early', chattype: 'single', from: { userid: 'u1' } } }, session, '需要审批');
  assert.equal(wecom.sent.length, 1);
  assert.equal(wecom.sent[0].body.template_card.main_title.title, 'Codex 等待你的确认');
  assert.equal(store.getSession(session.conversation_key).active_turn_id, 'turn-early');
  const taskId = wecom.sent[0].body.template_card.task_id;
  await bridge.handleCard({ body: { event: { template_card_event: { event_key: 'approve', task_id: taskId } } } });
  assert.deepEqual(approvalResponse, { decision: 'accept' });
  store.close();
});

test('updates the original stream for quiet long-running turns', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-progress-project-'));
  const wecom = new FakeWeCom(); const codex = new EventEmitter();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-progress-store-')), 'state.sqlite'));
  const config = { projects: [{ id: 'p1', name: '项目一', path: projectPath }], defaultProject: 'p1', authorizedUsers: [], streamIntervalMs: 500, progressIntervalMs: 5000 };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  const session = { conversation_key: 'user:u1', userid: 'u1', project_id: 'p1', thread_id: 'thread-1', mode: 'readOnly', active_turn_id: 'turn-quiet' };
  bridge.turns.set('turn-quiet', {
    frame: { body: { msgid: 'm-progress', chattype: 'single', from: { userid: 'u1' } } },
    streamId: 'stream-progress',
    target: 'u1',
    session,
    threadId: 'thread-1',
    prompt: '长任务',
    text: '',
    lastSent: '',
    statuses: [],
    startedAt: Date.now() - 65000,
    lastActivityAt: Date.now() - 60000,
  });
  await bridge.sendProgressNotification('turn-quiet');
  assert.equal(wecom.sent.length, 0);
  assert.equal(wecom.replies.length, 1);
  assert.equal(wecom.replies[0].streamId, 'stream-progress');
  assert.equal(wecom.replies[0].finish, false);
  assert.equal(wecom.replies[0].content.includes('Codex 仍在执行'), true);
  assert.equal(wecom.replies[0].content.includes('<font'), false);
  assert.equal(wecom.replies[0].content.includes('等待 Codex 输出或授权请求'), true);
  store.close();
});

test('treats running-status questions as status checks instead of steer input', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-status-probe-project-'));
  const wecom = new FakeWeCom(); const codex = new FakeCodex({ id: 'thread-1', cwd: projectPath, status: { type: 'active' } });
  let steered = false;
  codex.steer = async () => { steered = true; };
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-status-probe-store-')), 'state.sqlite'));
  const config = { projects: [{ id: 'p1', name: '项目一', path: projectPath }], defaultProject: 'p1', authorizedUsers: [], streamIntervalMs: 500, progressIntervalMs: 5000 };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  const session = { conversation_key: 'user:u1', userid: 'u1', project_id: 'p1', thread_id: 'thread-1', mode: 'readOnly', active_turn_id: 'turn-1' };
  store.upsertSession(session);
  bridge.turns.set('turn-1', {
    frame: { body: { msgid: 'm-existing', chattype: 'single', from: { userid: 'u1' } } },
    streamId: 'stream-1',
    target: 'u1',
    session,
    threadId: 'thread-1',
    prompt: '长任务',
    text: '处理中',
    lastSent: '',
    statuses: ['🔧 npm test'],
    startedAt: Date.now() - 10000,
    lastActivityAt: Date.now() - 9000,
  });
  await bridge.handleText({ body: { msgid: 'm-status-probe', chattype: 'single', from: { userid: 'u1' }, text: { content: '是否运行结束' } } });
  assert.equal(steered, false);
  assert.equal(wecom.sent.at(-1).body.markdown.content.includes('✅ Codex 仍在执行'), true);
  store.close();
});

test('slash status reports the current active turn details', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-status-active-project-'));
  const wecom = new FakeWeCom(); const codex = new FakeCodex({ id: 'thread-1', cwd: projectPath, status: { type: 'active' } });
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-status-active-store-')), 'state.sqlite'));
  const config = { projects: [{ id: 'p1', name: '项目一', path: projectPath }], defaultProject: 'p1', authorizedUsers: [], streamIntervalMs: 500, progressIntervalMs: 5000, model: 'gpt-5.5' };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  const session = { conversation_key: 'user:u1', userid: 'u1', project_id: 'p1', thread_id: 'thread-1', mode: 'workspaceWrite', active_turn_id: 'turn-active' };
  store.upsertSession(session);
  store.createTurn({ turnId: 'turn-active', conversationKey: session.conversation_key, threadId: session.thread_id, prompt: '执行长任务' });
  store.saveApproval({ taskId: 'approval-status', requestId: '1', conversationKey: session.conversation_key, threadId: session.thread_id, turnId: 'turn-active', itemId: 'cmd-1', kind: 'command', payload: '{}' });
  bridge.turns.set('turn-active', {
    frame: { body: { msgid: 'm-existing', chattype: 'single', from: { userid: 'u1' } } },
    streamId: 'stream-1',
    target: 'u1',
    session,
    threadId: 'thread-1',
    prompt: '执行长任务',
    text: '已经完成第一步',
    lastSent: '',
    statuses: ['🔧 npm test'],
    startedAt: Date.now() - 10000,
    lastActivityAt: Date.now() - 9000,
  });
  await bridge.handleText({ body: { msgid: 'm-status-active', chattype: 'single', from: { userid: 'u1' }, text: { content: '/状态' } } });
  const content = wecom.sent.at(-1).body.markdown.content;
  assert.equal(content.startsWith('```text\n'), true);
  assert.equal(content.includes('✅ 当前会话状态'), true);
  assert.equal(content.includes('项目：项目一 (p1)'), true);
  assert.equal(content.includes('模式：可写'), true);
  assert.equal(content.includes('模型：gpt-5.5'), true);
  assert.equal(content.includes('执行状态：✅ 执行中'), true);
  assert.equal(content.includes('任务：turn-active'), true);
  assert.equal(content.includes('最近状态：🔧 npm test'), true);
  assert.equal(content.includes('待处理：⚠️ 1 个审批/输入请求'), true);
  assert.equal(content.includes('当前输出：\n已经完成第一步'), true);
  store.close();
});

test('slash status reports the latest completed turn when idle', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-status-idle-project-'));
  const wecom = new FakeWeCom(); const codex = new FakeCodex({ id: 'thread-1', cwd: projectPath, status: { type: 'idle' } });
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-status-idle-store-')), 'state.sqlite'));
  const config = { projects: [{ id: 'p1', name: '项目一', path: projectPath }], defaultProject: 'p1', authorizedUsers: [], streamIntervalMs: 500, progressIntervalMs: 5000, model: null };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  const session = { conversation_key: 'user:u1', userid: 'u1', project_id: 'p1', thread_id: 'thread-1', mode: 'readOnly', active_turn_id: null };
  store.upsertSession(session);
  store.createTurn({ turnId: 'turn-done', conversationKey: session.conversation_key, threadId: session.thread_id, prompt: '上一条输入' });
  store.completeTurn('turn-done', 'completed', '上一条输出');
  await bridge.handleText({ body: { msgid: 'm-status-idle', chattype: 'single', from: { userid: 'u1' }, text: { content: '/status' } } });
  const content = wecom.sent.at(-1).body.markdown.content;
  assert.equal(content.includes('执行状态：ℹ️ 空闲'), true);
  assert.equal(content.includes('最近任务：turn-done'), true);
  assert.equal(content.includes('最近任务状态：✅ 已完成'), true);
  assert.equal(content.includes('最近输入：\n上一条输入'), true);
  assert.equal(content.includes('最近输出：\n上一条输出'), true);
  store.close();
});

test('rejects cross-thread sends outside configured project roots', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-allowed-project-'));
  const outsidePath = mkdtempSync(join(tmpdir(), 'wecom-outside-project-'));
  const wecom = new FakeWeCom(); const codex = new FakeCodex({ id: 'outside', cwd: outsidePath, status: { type: 'idle' } });
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-reject-send-')), 'state.sqlite'));
  const config = { projects: [{ id: 'allowed', name: 'Allowed', path: projectPath }], defaultProject: 'allowed', authorizedUsers: [], streamIntervalMs: 500 };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  const session = { conversation_key: 'user:u1', userid: 'u1', project_id: 'allowed', thread_id: null, mode: 'readOnly', active_turn_id: null };
  await bridge.sendToThread({ body: { msgid: 'm-reject', chattype: 'single', from: { userid: 'u1' } } }, session, 'outside', '执行');
  assert.equal(codex.calls.some((call) => call.method === 'turn/start'), false);
  assert.equal(wecom.sent.at(-1).body.markdown.content.includes('不属于配置中的允许目录'), true);
  store.close();
});

test('grants only requested permissions for the current turn', async () => {
  const wecom = new FakeWeCom(); const codex = new EventEmitter();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-permissions-')), 'state.sqlite'));
  const bridge = new Bridge({ wecom, codex, store, config: { projects: [], authorizedUsers: [], streamIntervalMs: 500 }, logger: { error() {}, warn() {} } });
  bridge.turns.set('turn-perm', { target: 'u1', session: { conversation_key: 'user:u1' } });
  let response;
  const permissions = { filesystem: { read: ['/Users/u/.drip'], write: ['/Users/u/.drip'] } };
  await bridge.handleServerRequest({ message: { id: 9, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-perm', itemId: 'perm-1', cwd: '/tmp/project', permissions } }, respond: (value) => { response = value; } });
  const taskId = wecom.sent[0].body.template_card.task_id;
  await bridge.handleCard({ body: { event: { template_card_event: { event_key: 'approve', task_id: taskId } } } });
  assert.deepEqual(response, { permissions, scope: 'turn' });
  store.close();
});

test('routes the slash conversation command, lists every page, and selects by the next number', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-select-project-'));
  const threads = [
    { id: 'thread-newer', cwd: projectPath, status: { type: 'idle' }, name: '较新对话', updatedAt: 20 },
    { id: 'thread-older', cwd: projectPath, status: { type: 'notLoaded' }, name: '较早对话', updatedAt: 10 },
  ];
  const turnsByThread = {
    'thread-newer': { id: 'turn-newer', status: 'completed', items: [
      { id: 'user-newer', type: 'userMessage', content: [{ type: 'text', text: '请完整保留\n这段输入' }] },
      { id: 'commentary-newer', type: 'agentMessage', phase: 'commentary', text: '正在处理' },
      { id: 'agent-newer', type: 'agentMessage', phase: 'final_answer', text: '这是完整的\n最终输出' },
    ] },
    'thread-older': { id: 'turn-older', status: 'completed', items: [
      { id: 'user-older', type: 'userMessage', content: [{ type: 'text', text: '旧对话输入' }] },
      { id: 'agent-older', type: 'agentMessage', text: '旧对话输出' },
    ] },
  };
  class PaginatedCodex extends FakeCodex {
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === 'thread/list') return params.cursor ? { data: [threads[1]], nextCursor: null } : { data: [threads[0]], nextCursor: 'page-2' };
      if (method === 'thread/turns/list') return { data: [turnsByThread[params.threadId]], nextCursor: null };
      if (method === 'thread/read') return { thread: threads.find((thread) => thread.id === params.threadId) };
      throw new Error(`unexpected method ${method}`);
    }
  }
  const wecom = new FakeWeCom(); const codex = new PaginatedCodex(threads[0]);
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-select-thread-')), 'state.sqlite'));
  const config = { projects: [{ id: 'p1', name: '项目一', path: projectPath }], defaultProject: 'p1', authorizedUsers: ['u1'], streamIntervalMs: 500, model: null };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  const session = { conversation_key: 'user:u1', userid: 'u1', project_id: 'p1', thread_id: null, mode: 'readOnly', active_turn_id: null };
  store.upsertSession(session);
  const frame = { body: { msgid: 'm-select', chattype: 'single', from: { userid: 'u1' }, text: { content: '/选择对话' } } };
  await bridge.handleText(frame);
  assert.equal(store.getInteractionState(session.conversation_key).kind, 'select_thread');
  assert.equal(store.resolveThreadAlias(session.conversation_key, 2).thread_id, 'thread-older');
  assert.equal(wecom.sent[0].body.markdown.content.startsWith('```text\n'), true);
  assert.equal(wecom.sent[0].body.markdown.content.includes('共 2 个'), true);
  assert.equal(wecom.sent[0].body.markdown.content.includes('✅ 项目：项目一\n\n1. 会话：较新对话\n状态：idle'), true);
  assert.equal(wecom.sent[0].body.markdown.content.includes('最后一次输入'), false);
  assert.equal(wecom.sent[0].body.markdown.content.includes('thread-newer'), false);
  assert.equal(codex.calls.filter((call) => call.method === 'thread/turns/list').length, 0);
  await bridge.handleThreadSelection(frame, session, '2');
  assert.equal(store.getSession(session.conversation_key).thread_id, 'thread-older');
  assert.equal(store.getInteractionState(session.conversation_key), null);
  assert.equal(codex.calls.some((call) => call.method === 'thread/resume' && call.threadId === 'thread-older'), true);
  assert.equal(codex.calls.filter((call) => call.method === 'thread/turns/list').length, 1);
  assert.deepEqual(codex.calls.find((call) => call.method === 'thread/turns/list').params, { threadId: 'thread-older', limit: 1, sortDirection: 'desc', itemsView: 'full' });
  assert.equal(wecom.sent.at(-1).body.markdown.content.includes('最后一次输入：\n旧对话输入'), true);
  assert.equal(wecom.sent.at(-1).body.markdown.content.includes('最后一次输出：\n旧对话输出'), true);
  store.close();
});

test('groups the conversation list by project while keeping global conversation numbers', async () => {
  const firstPath = mkdtempSync(join(tmpdir(), 'wecom-group-first-'));
  const secondPath = mkdtempSync(join(tmpdir(), 'wecom-group-second-'));
  const firstThreads = [
    { id: 'first-old', cwd: firstPath, status: { type: 'idle' }, name: '项目一旧会话', updatedAt: 10 },
    { id: 'first-new', cwd: firstPath, status: { type: 'idle' }, name: '项目一新会话', updatedAt: 20 },
  ];
  const secondThreads = [
    { id: 'second-newest', cwd: secondPath, status: { type: 'notLoaded' }, name: '项目二会话', updatedAt: 30 },
  ];
  class GroupedCodex extends FakeCodex {
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === 'thread/list') return { data: params.cwd === firstPath ? firstThreads : secondThreads, nextCursor: null };
      throw new Error(`unexpected method ${method}`);
    }
  }
  const projects = [
    { id: 'first', name: '项目一', path: firstPath },
    { id: 'second', name: '项目二', path: secondPath },
  ];
  const wecom = new FakeWeCom(); const codex = new GroupedCodex(firstThreads[0]);
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-group-store-')), 'state.sqlite'));
  const config = { projects, defaultProject: 'first', authorizedUsers: ['u1'], streamIntervalMs: 500, model: null };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  const session = { conversation_key: 'user:u1', userid: 'u1', project_id: 'first', thread_id: null, mode: 'readOnly', active_turn_id: null };
  store.upsertSession(session);
  await bridge.handleText({ body: { msgid: 'm-group', chattype: 'single', from: { userid: 'u1' }, text: { content: '/选择会话' } } });
  const content = wecom.sent[0].body.markdown.content;
  assert.equal(content.includes('✅ 项目：项目一\n\n1. 会话：项目一新会话'), true);
  assert.equal(content.includes('2. 会话：项目一旧会话'), true);
  assert.equal(content.includes('✅ 项目：项目二\n\n3. 会话：项目二会话'), true);
  assert.equal(store.resolveThreadAlias('user:u1', 1).thread_id, 'first-new');
  assert.equal(store.resolveThreadAlias('user:u1', 2).thread_id, 'first-old');
  assert.equal(store.resolveThreadAlias('user:u1', 3).thread_id, 'second-newest');
  store.close();
});

test('requires a slash for system operations and creates a conversation with the slash command', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-new-project-'));
  const wecom = new FakeWeCom(); const codex = new FakeCodex({ id: 'unused', cwd: projectPath, status: { type: 'idle' } });
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-new-thread-')), 'state.sqlite'));
  const config = { projects: [{ id: 'p1', name: '项目一', path: projectPath }], defaultProject: 'p1', authorizedUsers: ['u1'], streamIntervalMs: 500, model: null };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  await bridge.handleText({ body: { msgid: 'm-new-hint', chattype: 'single', from: { userid: 'u1' }, text: { content: '新建对话' } } });
  assert.equal(codex.calls.some((call) => call.method === 'thread/start'), false);
  assert.equal(wecom.sent.at(-1).body.markdown.content.includes('/新建对话'), true);
  await bridge.handleText({ body: { msgid: 'm-new', chattype: 'single', from: { userid: 'u1' }, text: { content: '/新建对话' } } });
  assert.equal(store.getSession('user:u1').thread_id, 'thread-new');
  assert.equal(codex.calls.some((call) => call.method === 'thread/start'), true);
  assert.equal(wecom.sent.at(-1).body.markdown.content.includes('已新建空白对话'), true);
  store.close();
});

test('lists account models with a slash command and uses the selected model for future work', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-model-project-'));
  class ModelCodex extends FakeCodex {
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === 'model/list') return { data: [
        { id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5', description: 'stable', hidden: false, isDefault: true },
        { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'coding', hidden: false, isDefault: false },
      ], nextCursor: null };
      return super.request(method, params);
    }
  }
  const wecom = new FakeWeCom(); const codex = new ModelCodex({ id: 'unused', cwd: projectPath, status: { type: 'idle' } });
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-model-store-')), 'state.sqlite'));
  const config = { projects: [{ id: 'p1', name: '项目一', path: projectPath }], defaultProject: 'p1', authorizedUsers: ['u1'], streamIntervalMs: 500, model: 'gpt-5.5', effort: null };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  await bridge.handleText({ body: { msgid: 'm-model-list', chattype: 'single', from: { userid: 'u1' }, text: { content: '/选择模型' } } });
  assert.equal(store.getInteractionState('user:u1').kind, 'select_model');
  assert.equal(wecom.sent.at(-1).body.markdown.content.includes('共 2 个'), true);
  await bridge.handleText({ body: { msgid: 'm-model-pick', chattype: 'single', from: { userid: 'u1' }, text: { content: '2' } } });
  assert.equal(store.getSetting('selected_model:user:u1'), 'gpt-5.6-sol');
  await bridge.handleText({ body: { msgid: 'm-model-task', chattype: 'single', from: { userid: 'u1' }, text: { content: '运行任务' } } });
  const threadStart = codex.calls.find((call) => call.method === 'thread/start');
  const turnStart = codex.calls.find((call) => call.method === 'turn/start');
  assert.equal(threadStart.params.model, 'gpt-5.6-sol');
  assert.equal(turnStart.params.model, 'gpt-5.6-sol');
  store.close();
});

test('starts the first turn of a newly created blank conversation without resuming it', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-blank-first-turn-'));
  const wecom = new FakeWeCom(); const codex = new FakeCodex({ id: 'unused', cwd: projectPath, status: { type: 'idle' } });
  codex.ensureThreadLoaded = async (threadId) => { codex.calls.push({ method: 'thread/loaded', threadId }); return { loaded: true }; };
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-blank-store-')), 'state.sqlite'));
  const config = { projects: [{ id: 'p1', name: '项目一', path: projectPath }], defaultProject: 'p1', authorizedUsers: [], streamIntervalMs: 500, model: null, effort: null };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn() {} } });
  const session = { conversation_key: 'user:u1', userid: 'u1', project_id: 'p1', thread_id: null, mode: 'readOnly', active_turn_id: null };
  const frame = { body: { msgid: 'm-blank', chattype: 'single', from: { userid: 'u1' } } };
  await bridge.createNewConversation(frame, session);
  await bridge.startOrSteer({ body: { ...frame.body, msgid: 'm-blank-first' } }, session, '我是谁');
  assert.equal(codex.calls.some((call) => call.method === 'thread/resume'), false);
  assert.equal(codex.calls.some((call) => call.method === 'turn/start' && call.params.threadId === 'thread-new'), true);
  store.close();
});

test('replaces a blank thread that was lost across an App Server restart', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'wecom-lost-blank-'));
  const wecom = new FakeWeCom(); const codex = new FakeCodex({ id: 'unused', cwd: projectPath, status: { type: 'idle' } });
  codex.ensureThreadLoaded = async () => { throw new Error('thread/resume: no rollout found for thread id missing-blank'); };
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-lost-blank-store-')), 'state.sqlite'));
  const warnings = [];
  const config = { projects: [{ id: 'p1', name: '项目一', path: projectPath }], defaultProject: 'p1', authorizedUsers: [], streamIntervalMs: 500, model: null, effort: null };
  const bridge = new Bridge({ wecom, codex, store, config, logger: { error() {}, warn(...args) { warnings.push(args); } } });
  const session = { conversation_key: 'user:u1', userid: 'u1', project_id: 'p1', thread_id: 'missing-blank', mode: 'readOnly', active_turn_id: null };
  store.upsertSession(session);
  await bridge.startOrSteer({ body: { msgid: 'm-recover-blank', chattype: 'single', from: { userid: 'u1' } } }, session, '继续');
  assert.equal(session.thread_id, 'thread-new');
  assert.equal(store.getSession(session.conversation_key).thread_id, 'thread-new');
  assert.equal(codex.calls.some((call) => call.method === 'turn/start' && call.params.threadId === 'thread-new'), true);
  assert.equal(warnings.length, 1);
  store.close();
});
