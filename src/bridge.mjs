import { randomUUID } from 'node:crypto';
import { generateReqId } from '@wecom/aibot-node-sdk';
import { HELP, parseCommand } from './commands.mjs';
import { projectById, projectByPath } from './config.mjs';

function truncate(text, max = 18000) { return text.length <= max ? text : `…（前文已省略）\n${text.slice(-max)}`; }
function approvalCard(taskId, params, kind) {
  const detail = kind === 'command'
    ? `命令：${params.command || '(未提供)'}\n目录：${params.cwd || '(未提供)'}\n原因：${params.reason || 'Codex 请求授权'}`
    : kind === 'permissions'
      ? `权限范围：${JSON.stringify(requestedPermissions(params), null, 2)}\n目录：${params.cwd || '(未提供)'}\n原因：${params.reason || 'Codex 请求额外权限'}`
      : `文件修改授权\n原因：${params.reason || 'Codex 请求写入文件'}`;
  const desc = kind === 'command' ? '命令执行审批' : kind === 'permissions' ? '额外权限审批（仅本轮）' : '文件修改审批';
  return {
    card_type: 'button_interaction', main_title: { title: 'Codex 等待你的确认', desc },
    sub_title_text: truncate(detail, 700),
    button_list: [
      { text: '允许', key: `approve:${taskId}`, style: 1 },
      { text: '拒绝', key: `decline:${taskId}`, style: 2 },
      { text: '取消任务', key: `cancel:${taskId}`, style: 3 },
    ], task_id: taskId,
  };
}

function requestedPermissions(params) {
  if (params.permissions && typeof params.permissions === 'object') return params.permissions;
  const permissions = {};
  if (params.network !== undefined) permissions.network = params.network;
  if (params.filesystem !== undefined) permissions.filesystem = params.filesystem;
  return permissions;
}

function threadStatus(thread) { return thread?.status?.type || thread?.status || 'unknown'; }
function threadUpdatedAt(thread) { return Number(thread?.updatedAt || thread?.updated_at || thread?.createdAt || thread?.created_at || 0); }
function threadTitle(thread) { return thread?.name || thread?.title || thread?.preview || '(无标题)'; }
function userInputText(input) {
  if (input?.type === 'text') return input.text || '';
  if (input?.type === 'image') return `[图片：${input.url || '未知地址'}]`;
  if (input?.type === 'localImage') return `[本地图片：${input.path || '未知路径'}]`;
  if (input?.type === 'skill') return `[技能：${input.name || input.path || '未知'}]`;
  return input ? `[${input.type || '未知输入类型'}]` : '';
}
function lastTurnTranscript(turn) {
  if (!turn) return { input: '(空白对话，尚无输入)', output: '(尚无输出)' };
  const items = Array.isArray(turn.items) ? turn.items : [];
  const input = items.filter((item) => item?.type === 'userMessage')
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map(userInputText).filter(Boolean).join('\n');
  const agentMessages = items.filter((item) => item?.type === 'agentMessage' && typeof item.text === 'string');
  const finalMessages = agentMessages.filter((item) => item.phase === 'final_answer');
  const outputItems = finalMessages.length ? finalMessages : agentMessages;
  const output = outputItems.map((item) => item.text).filter(Boolean).join('\n\n');
  return { input: input || '(未读取到文本输入)', output: output || '(该轮尚无 Codex 文本输出)' };
}
function matchesPhrase(text, phrase) { return text.replace(/[\s。！!，,]+$/u, '') === phrase; }
function selectedModelKey(conversationKey) { return `selected_model:${conversationKey}`; }
function isStatusProbe(text) {
  const value = text.replace(/[\s。！!，,？?]+$/u, '');
  return ['是否运行结束', '运行结束了吗', '运行结束没', '任务结束了吗', '任务完成了吗', '是否完成', '完成了吗', '进度', '状态'].includes(value);
}
const LEGACY_COMMAND_HINTS = new Map([
  ['选择对话', '/选择对话'],
  ['选择会话', '/选择对话'],
  ['新建对话', '/新建对话'],
  ['选择模型', '/选择模型'],
]);
const ROOT_THREAD_SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];

function splitLongText(text, max = 16000) {
  const paragraphs = text.split('\n\n'); const chunks = []; let current = '';
  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= max) { current = next; continue; }
    if (current) chunks.push(current);
    if (paragraph.length <= max) current = paragraph;
    else {
      for (let offset = 0; offset < paragraph.length; offset += max) chunks.push(paragraph.slice(offset, offset + max));
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function turnCompletionLabel(status) {
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'interrupted') return '已停止';
  if (status === 'cancelled' || status === 'canceled') return '已取消';
  return status || '已结束';
}
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours} 小时 ${minutes} 分 ${seconds} 秒`;
  if (minutes) return `${minutes} 分 ${seconds} 秒`;
  return `${Math.max(1, seconds)} 秒`;
}
function formatLocalTime(timestamp) {
  if (!timestamp) return '无';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}
function statusLabel(status) {
  if (status === 'inProgress') return '执行中';
  return turnCompletionLabel(status);
}
function wxColor(text, tone = 'info') {
  const prefix = tone === 'warning' ? '⚠️' : tone === 'comment' ? 'ℹ️' : '✅';
  return `${prefix} ${text}`;
}
function statusTone(status) {
  if (status === 'failed' || status === 'interrupted' || status === 'cancelled' || status === 'canceled') return 'warning';
  if (status === 'completed') return 'info';
  if (status === 'inProgress') return 'info';
  return 'comment';
}
function formatHelpText(text) {
  return text
    .replace('**本机 Codex 控制命令**', wxColor('本机 Codex 控制命令', 'info'))
    .replace('**英文指令及含义**', wxColor('英文指令及含义', 'comment'))
    .replace('所有系统操作都必须以 /开头。', wxColor('所有系统操作都必须以 /开头。', 'warning'));
}
function markdownTextBlock(text) {
  const safeText = String(text).replaceAll('```', '｀｀｀');
  return `\`\`\`text\n${safeText}\n\`\`\``;
}

function resolvedApprovalCard(taskId, title, desc = '决定已发送给本机 Codex。') {
  return {
    card_type: 'text_notice',
    main_title: { title },
    sub_title_text: desc,
    // The bot endpoint currently enforces the documented text_notice range
    // [1, 2]. The SDK type also permits 0, but the server rejects it as 42045.
    card_action: { type: 1, url: 'https://work.weixin.qq.com/' },
    task_id: taskId,
  };
}

function diagnosticApprovalCard(taskId) {
  return {
    card_type: 'button_interaction',
    main_title: { title: '审批卡片全链路测试', desc: '不会执行任何系统命令' },
    sub_title_text: '点击“允许”验证按钮回调和卡片更新。',
    button_list: [
      { text: '允许', key: `approve:${taskId}`, style: 1 },
      { text: '拒绝', key: `decline:${taskId}`, style: 2 },
    ],
    task_id: taskId,
  };
}

export class Bridge {
  constructor({ wecom, codex, store, config, logger, audit = null }) {
    this.wecom = wecom; this.codex = codex; this.store = store; this.config = config; this.logger = logger; this.audit = audit;
    this.turns = new Map(); this.startingThreads = new Map(); this.pendingRequests = new Map(); this.lastDiff = new Map(); this.flushTimers = new Map(); this.progressTimers = new Map();
  }
  attach() {
    this.wecom.on('message.text', (frame) => { this.audit?.record('wecom.inbound', { eventType: 'message.text', frame }); this.runSafely('处理文本消息', () => this.handleText(frame)); });
    this.wecom.on('event.template_card_event', (frame) => { this.audit?.record('wecom.inbound', { eventType: 'event.template_card_event', frame }); this.runSafely('处理审批按钮', () => this.handleCard(frame)); });
    this.codex.on('notification', (message) => this.runSafely('处理 Codex 通知', () => this.handleNotification(message)));
    this.codex.on('serverRequest', (request) => this.runSafely('处理 Codex 请求', () => this.handleServerRequest(request)));
  }
  replyStream(frame, streamId, content, finish) {
    this.audit?.record('wecom.outbound.replyStream', { messageId: frame?.body?.msgid, target: this.target(frame?.body || {}), streamId, content, finish });
    return this.wecom.replyStream(frame, streamId, content, finish);
  }
  sendMessage(target, body) {
    this.audit?.record('wecom.outbound.sendMessage', { target, body });
    return this.wecom.sendMessage(target, body);
  }
  sendMarkdown(target, content) {
    return this.sendMessage(target, { msgtype: 'markdown', markdown: { content } });
  }
  sendSystemText(target, content) {
    return this.sendMarkdown(target, markdownTextBlock(content));
  }
  systemReply(frame, content) {
    return this.sendSystemText(this.target(frame?.body || {}), content);
  }
  updateTemplateCard(frame, card) {
    this.audit?.record('wecom.outbound.updateTemplateCard', { messageId: frame?.body?.msgid, target: this.target(frame?.body || {}), card });
    return this.wecom.updateTemplateCard(frame, card);
  }
  runSafely(label, operation) {
    Promise.resolve().then(operation).catch((error) => {
      const detail = error instanceof Error ? { name: error.name, message: error.message, code: error.code } : error;
      this.audit?.record('bridge.operation.failed', { label, detail });
      this.logger.error(`${label}失败`, detail);
    });
  }
  authorized(userid) { return this.config.authorizedUsers.length ? this.config.authorizedUsers.includes(userid) : this.store.claimOwner(userid); }
  conversation(body) { return body.chattype === 'group' ? `group:${body.chatid}` : `user:${body.from.userid}`; }
  target(body) { return body?.chattype === 'group' ? body.chatid : body?.from?.userid || body?.chatid || 'unknown'; }
  getOrCreateSession(body) {
    const conversationKey = this.conversation(body); let session = this.store.getSession(conversationKey);
    if (!session) {
      session = { conversation_key: conversationKey, userid: body.from.userid, project_id: this.config.defaultProject, thread_id: null, mode: 'readOnly', active_turn_id: null };
      this.store.upsertSession(session);
    }
    return session;
  }
  selectedModel(session) { return this.store.getSetting(selectedModelKey(session.conversation_key)) || this.config.model || null; }

  async handleText(frame) {
    const body = frame.body || {}; const text = body.text?.content?.trim() || '';
    if (!body.msgid || !body.from?.userid) return;
    if (this.store.hasProcessed(body.msgid)) return;
    this.store.markProcessed(body.msgid);
    if (body.chattype !== 'single') { await this.systemReply(frame, wxColor('当前版本只允许单聊控制本机 Codex。', 'warning')); return; }
    if (!this.authorized(body.from.userid)) { await this.systemReply(frame, wxColor('无权控制这台电脑上的 Codex。', 'warning')); return; }
    const session = this.getOrCreateSession(body); const pendingInput = this.store.pendingInput(session.conversation_key);
    if (pendingInput) { await this.answerUserInput(frame, pendingInput, text); return; }
    const command = parseCommand(text);
    if (command) { await this.handleCommand(frame, session, command); return; }
    const legacyCommand = LEGACY_COMMAND_HINTS.get(text.replace(/[\s。！!，,]+$/u, ''));
    if (legacyCommand) {
      await this.systemReply(frame, `${wxColor('系统操作需要以 /开头。', 'warning')}请发送 ${legacyCommand}`); return;
    }
    const interaction = this.store.getInteractionState(session.conversation_key);
    if (interaction?.kind === 'select_thread') { await this.handleThreadSelection(frame, session, text); return; }
    if (interaction?.kind === 'select_model') { await this.handleModelSelection(frame, session, text, interaction); return; }
    if (!text) { await this.systemReply(frame, wxColor('请输入任务内容，或发送 /帮助 查看命令。', 'comment')); return; }
    if (session.active_turn_id && isStatusProbe(text)) { await this.reportActiveTurn(frame, session); return; }
    await this.startOrSteer(frame, session, text);
  }

  async startOrSteer(frame, session, text) {
    if (session.active_turn_id) {
      try { await this.codex.steer(session.thread_id, session.active_turn_id, text); await this.systemReply(frame, wxColor('补充指令已加入当前任务。', 'info')); }
      catch (error) { await this.systemReply(frame, `${wxColor('补充指令失败', 'warning')}：${error.message}`); }
      return;
    }
    const streamId = generateReqId('codex');
    await this.replyStream(frame, streamId, '已交给本机 Codex，正在处理…', false);
    const project = projectById(this.config, session.project_id);
    try {
      if (!session.thread_id) {
        const thread = await this.codex.startThread({ cwd: project.path, mode: session.mode, model: this.selectedModel(session) }); session.thread_id = thread.id;
      } else {
        try {
          if (typeof this.codex.ensureThreadLoaded === 'function') await this.codex.ensureThreadLoaded(session.thread_id);
          else await this.codex.resumeThread(session.thread_id);
        } catch (error) {
          if (!/no rollout found/i.test(error.message || '')) throw error;
          const missingThreadId = session.thread_id;
          const thread = await this.codex.startThread({ cwd: project.path, mode: session.mode, model: this.selectedModel(session) });
          session.thread_id = thread.id; this.store.upsertSession(session);
          this.logger.warn('空白线程尚无 rollout，已自动重建', { missingThreadId, replacementThreadId: thread.id });
        }
      }
      const context = {
        frame,
        streamId,
        target: this.target(frame.body),
        session,
        threadId: session.thread_id,
        prompt: text,
        text: '',
        lastSent: '',
        statuses: [],
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        turnRecorded: false,
      };
      this.startingThreads.set(session.thread_id, context);
      const turn = await this.codex.startTurn({ threadId: session.thread_id, text, cwd: project.path, mode: session.mode, model: this.selectedModel(session), effort: this.config.effort, clientUserMessageId: frame.body.msgid });
      this.bindTurnContext(turn.id, context);
    } catch (error) {
      if (session.thread_id) this.startingThreads.delete(session.thread_id);
      this.logger.error('启动 Codex 任务失败', error.message);
      await this.replyStream(frame, streamId, `启动失败：${error.message}`, true);
    }
  }

  async handleCommand(frame, session, command) {
    const reply = async (text) => this.systemReply(frame, text);
    const project = projectById(this.config, session.project_id);
    switch (command.name) {
      case '/help': return reply(formatHelpText(HELP));
      case '/status': return reply(this.currentStatusText(session, project));
      case '/new':
        return this.createNewConversation(frame, session, reply);
      case '/readonly': session.mode = 'readOnly'; this.store.upsertSession(session); return reply(wxColor('已切换为只读模式。', 'info'));
      case '/write': session.mode = 'workspaceWrite'; this.store.upsertSession(session); return reply(`${wxColor('已切换为可写模式', 'info')}，仅允许写入：\n${project.path}`);
      case '/stop':
        if (!session.active_turn_id) return reply(wxColor('当前没有执行中的任务。', 'comment'));
        await this.codex.interrupt(session.thread_id, session.active_turn_id); return reply(wxColor('已发送停止指令。', 'warning'));
      case '/diff': return reply(this.lastDiff.get(session.thread_id) || wxColor('当前会话还没有文件变更。', 'comment'));
      case '/test-approval': return this.sendApprovalTest(frame, session, reply);
      case '/project': return this.handleProjectCommand(reply, session, command);
      case '/threads': return this.beginThreadSelection(frame, session, reply);
      case '/model': return this.beginModelSelection(frame, session, reply, command.args[0]);
      case '/resume': {
        if (session.active_turn_id) return reply(wxColor('当前任务仍在执行，请先发送 /停止。', 'warning'));
        const selector = command.args[0]; if (!selector) return reply(`${wxColor('用法', 'comment')}：/恢复对话 <线程ID或序号>`);
        let threadId;
        try { threadId = this.resolveThreadSelector(session, selector); }
        catch (error) { return reply(wxColor(error.message, 'warning')); }
        const result = await this.codex.request('thread/read', { threadId, includeTurns: false });
        const targetProject = projectByPath(this.config, result.thread.cwd);
        if (!targetProject) return reply(wxColor('拒绝恢复：该线程不属于允许的项目目录。', 'warning'));
        if (threadStatus(result.thread) === 'active') return reply(wxColor('该对话当前正在执行，暂时不能恢复。', 'warning'));
        await this.codex.resumeThread(threadId); session.project_id = targetProject.id; session.thread_id = threadId; this.store.upsertSession(session); return reply(`${wxColor('已恢复线程', 'info')}：${threadId}\n项目：${targetProject.name}`);
      }
      case '/send': {
        const selector = command.args[0];
        const message = selector ? command.rawArgs.slice(selector.length).trim() : '';
        if (!selector || !message) return reply(`${wxColor('用法', 'comment')}：/发送 <线程ID或序号> <消息>`);
        return this.sendToThread(frame, session, selector, message);
      }
      default: return reply(`${wxColor(`未知命令：${command.name}`, 'warning')}\n发送 /帮助 查看可用命令。`);
    }
  }

  async fetchAllAllowedThreads() {
    const results = await Promise.all(this.config.projects.map(async (project) => {
      const entries = []; let cursor = null; let pages = 0;
      do {
        const result = await this.codex.request('thread/list', {
          cwd: project.path, cursor, limit: 100, sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ROOT_THREAD_SOURCES,
        });
        entries.push(...(result.data || []).filter((thread) => projectByPath(this.config, thread.cwd)?.id === project.id).map((thread) => ({ thread, project })));
        cursor = result.nextCursor || null; pages += 1;
        if (cursor && pages >= 100) throw new Error(`项目 ${project.name} 的对话数量过多，已停止继续分页`);
      } while (cursor);
      return entries;
    }));
    const seen = new Set();
    return results.flat().sort((a, b) => threadUpdatedAt(b.thread) - threadUpdatedAt(a.thread)).filter(({ thread }) => {
      if (seen.has(thread.id)) return false;
      seen.add(thread.id); return true;
    });
  }

  async beginThreadSelection(frame, session, replyOverride = null) {
    const reply = replyOverride || (async (text) => this.systemReply(frame, text));
    if (session.active_turn_id) return reply(wxColor('当前任务仍在执行，请先发送 /停止。', 'warning'));
    let entries;
    try { entries = await this.fetchAllAllowedThreads(); }
    catch (error) { return reply(`${wxColor('读取 Codex 对话失败', 'warning')}：${error.message}`); }
    if (!entries.length) {
      this.store.clearInteractionState(session.conversation_key);
      return reply(`${wxColor('没有找到允许目录下的 Codex 对话。', 'comment')}发送 /新建对话 可以创建一个空白上下文。`);
    }
    const orderedEntries = []; const projectBlocks = [];
    for (const project of this.config.projects) {
      const projectEntries = entries.filter((entry) => entry.project.id === project.id);
      if (!projectEntries.length) continue;
      const lines = projectEntries.map((entry) => {
        orderedEntries.push(entry);
        return `${orderedEntries.length}. 会话：${threadTitle(entry.thread)}\n状态：${threadStatus(entry.thread)}`;
      });
      projectBlocks.push(`${wxColor(`项目：${project.name}`, 'info')}\n\n${lines.join('\n\n')}`);
    }
    this.store.replaceThreadAliases(session.conversation_key, orderedEntries.map(({ thread, project }) => ({ threadId: thread.id, projectId: project.id })));
    this.store.setInteractionState(session.conversation_key, 'select_thread', { count: orderedEntries.length });
    const chunks = splitLongText(`Codex 对话列表（共 ${orderedEntries.length} 个）：\n\n${projectBlocks.join('\n\n')}\n\n请直接输入序号进入对应对话，或输入“取消”。`);
    await reply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
      await this.sendSystemText(this.target(frame.body), chunk);
    }
  }

  async loadLastTurnTranscript(threadId) {
    const result = await this.codex.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
    return lastTurnTranscript(result.data?.[0]);
  }

  async handleThreadSelection(frame, session, text) {
    const reply = async (message) => this.systemReply(frame, message);
    if (matchesPhrase(text, '取消') || matchesPhrase(text, '取消选择')) {
      this.store.clearInteractionState(session.conversation_key); return reply(wxColor('已取消选择对话。', 'comment'));
    }
    if (!/^\d+$/.test(text)) return reply(wxColor('请输入列表中的序号，或输入“取消”。', 'comment'));
    const alias = this.store.resolveThreadAlias(session.conversation_key, Number(text));
    if (!alias) return reply(wxColor('序号不存在，请发送 /选择对话 重新获取列表。', 'warning'));
    let result;
    try { result = await this.codex.request('thread/read', { threadId: alias.thread_id, includeTurns: false }); }
    catch (error) { return reply(`${wxColor('读取所选对话失败', 'warning')}：${error.message}`); }
    const project = projectByPath(this.config, result.thread?.cwd);
    if (!project) return reply(wxColor('拒绝选择：该对话不属于配置中的允许目录。', 'warning'));
    if (threadStatus(result.thread) === 'active') return reply(wxColor('该对话当前正在执行，请选择其他对话或稍后重试。', 'warning'));
    try { await this.codex.resumeThread(alias.thread_id); }
    catch (error) { return reply(`${wxColor('恢复所选对话失败', 'warning')}：${error.message}`); }
    session.project_id = project.id; session.thread_id = alias.thread_id; session.active_turn_id = null;
    this.store.upsertSession(session); this.store.clearInteractionState(session.conversation_key);
    let history;
    try {
      const transcript = await this.loadLastTurnTranscript(alias.thread_id);
      history = `最后一次输入：\n${transcript.input}\n\n最后一次输出：\n${transcript.output}`;
    } catch (error) {
      history = `最后一轮读取失败：${error.message || String(error)}`;
    }
    const chunks = splitLongText(`${wxColor('已进入对话', 'info')}：${threadTitle(result.thread)}\n项目：${project.name}\n线程：${alias.thread_id}\n\n${history}\n\n后续文字会继续使用这个对话的上下文。`);
    await reply(chunks[0]);
    for (const chunk of chunks.slice(1)) await this.sendSystemText(this.target(frame.body), chunk);
  }

  async createNewConversation(frame, session, replyOverride = null) {
    const reply = replyOverride || (async (text) => this.systemReply(frame, text));
    if (session.active_turn_id) return reply(wxColor('当前任务仍在执行，请先发送 /停止。', 'warning'));
    const project = projectById(this.config, session.project_id);
    try {
      const thread = await this.codex.startThread({ cwd: project.path, mode: session.mode, model: this.selectedModel(session) });
      session.thread_id = thread.id; session.active_turn_id = null;
      this.store.upsertSession(session); this.store.clearInteractionState(session.conversation_key);
      return reply(`${wxColor('已新建空白对话。', 'info')}\n项目：${project.name}\n线程：${thread.id}\n\n后续文字会使用这个新对话上下文。`);
    } catch (error) { return reply(`${wxColor('新建 Codex 对话失败', 'warning')}：${error.message}`); }
  }

  async fetchAllModels() {
    const models = []; let cursor = null; let pages = 0;
    do {
      const result = await this.codex.request('model/list', { cursor, limit: 100, includeHidden: false });
      models.push(...(result.data || []).filter((model) => !model.hidden));
      cursor = result.nextCursor || null; pages += 1;
      if (cursor && pages >= 20) throw new Error('可用模型数量过多，已停止继续分页');
    } while (cursor);
    const seen = new Set();
    return models.filter((model) => {
      const name = model.model || model.id;
      if (!name || seen.has(name)) return false;
      seen.add(name); return true;
    });
  }

  async beginModelSelection(frame, session, replyOverride = null, requestedModel = null) {
    const reply = replyOverride || (async (text) => this.systemReply(frame, text));
    if (session.active_turn_id) return reply('当前任务仍在执行，请先发送 /停止。');
    let models;
    try { models = await this.fetchAllModels(); }
    catch (error) { return reply(`${wxColor('读取 Codex 可用模型失败', 'warning')}：${error.message}`); }
    if (!models.length) return reply(wxColor('当前 Codex 账号没有返回可选模型。', 'comment'));
    if (requestedModel) {
      const selected = models.find((model) => (model.model || model.id) === requestedModel || model.id === requestedModel);
      if (!selected) return reply(`${wxColor(`模型 ${requestedModel} 不在当前账号的可用列表中。`, 'warning')}发送 /选择模型 查看列表。`);
      return this.applyModelSelection(session, selected, reply);
    }
    const current = this.selectedModel(session);
    const choices = models.map((model) => ({ id: model.id, model: model.model || model.id, displayName: model.displayName || model.model || model.id, description: model.description || '', isDefault: Boolean(model.isDefault) }));
    this.store.setInteractionState(session.conversation_key, 'select_model', { models: choices });
    const lines = choices.map((model, index) => `${index + 1}. ${model.model === current ? '✅' : '▫️'} ${model.displayName}\n${model.model}${model.isDefault ? ' （Codex 默认）' : ''}${model.description ? `\n${model.description}` : ''}`);
    const chunks = splitLongText(`Codex 可用模型（共 ${choices.length} 个）：\n\n${lines.join('\n\n')}\n\n请直接输入序号选择模型，或输入“取消”。`);
    await reply(chunks[0]);
    for (const chunk of chunks.slice(1)) await this.sendSystemText(this.target(frame.body), chunk);
  }

  applyModelSelection(session, model, reply) {
    const modelName = model.model || model.id;
    this.store.setSetting(selectedModelKey(session.conversation_key), modelName);
    this.store.clearInteractionState(session.conversation_key);
    return reply(`${wxColor('已选择模型', 'info')}：${model.displayName || modelName}\n${modelName}\n\n后续新任务会使用该模型。`);
  }

  async handleModelSelection(frame, session, text, interaction) {
    const reply = async (message) => this.systemReply(frame, message);
    if (matchesPhrase(text, '取消') || matchesPhrase(text, '取消选择')) {
      this.store.clearInteractionState(session.conversation_key); return reply(wxColor('已取消选择模型。', 'comment'));
    }
    if (!/^\d+$/.test(text)) return reply(wxColor('请输入列表中的序号，或输入“取消”。', 'comment'));
    const model = interaction.payload?.models?.[Number(text) - 1];
    if (!model) return reply(wxColor('序号不存在，请发送 /选择模型 重新获取列表。', 'warning'));
    return this.applyModelSelection(session, model, reply);
  }

  resolveThreadSelector(session, selector) {
    if (/^\d+$/.test(selector)) {
      const alias = this.store.resolveThreadAlias(session.conversation_key, Number(selector));
      if (!alias) throw new Error('会话序号不存在或已失效，请先发送 /选择对话 刷新列表。');
      return alias.thread_id;
    }
    return selector;
  }

  async sendToThread(frame, session, selector, text) {
    const reply = async (message) => this.systemReply(frame, message);
    if (session.active_turn_id) return reply(wxColor('当前企业微信任务仍在执行，请先发送 /停止。', 'warning'));
    let threadId;
    try { threadId = this.resolveThreadSelector(session, selector); }
    catch (error) { return reply(wxColor(error.message, 'warning')); }
    let result;
    try { result = await this.codex.request('thread/read', { threadId, includeTurns: false }); }
    catch (error) { return reply(`${wxColor('读取目标对话失败', 'warning')}：${error.message}`); }
    const project = projectByPath(this.config, result.thread?.cwd);
    if (!project) return reply(wxColor('拒绝发送：目标对话不属于配置中的允许目录。', 'warning'));
    if (threadStatus(result.thread) === 'active') return reply(wxColor('目标对话当前正在执行，请等待它完成后再发送。', 'warning'));
    session.project_id = project.id;
    session.thread_id = threadId;
    this.store.upsertSession(session);
    return this.startOrSteer(frame, session, text);
  }

  async sendApprovalTest(frame, session, reply) {
    const taskId = `approval_${randomUUID().replaceAll('-', '')}`;
    const turnId = `diagnostic_${randomUUID().replaceAll('-', '')}`;
    const target = this.target(frame.body);
    this.pendingRequests.set(taskId, {
      respond: (result) => this.logger.info('审批卡片全链路测试已响应', { decision: result.decision }),
      method: 'diagnostic/approval',
      params: {},
      target,
    });
    this.store.saveApproval({
      taskId,
      requestId: '"diagnostic"',
      conversationKey: session.conversation_key,
      threadId: session.thread_id || 'diagnostic',
      turnId,
      itemId: 'diagnostic',
      kind: 'test',
      payload: '{}',
    });
    try {
      await this.sendMessage(target, { msgtype: 'template_card', template_card: diagnosticApprovalCard(taskId) });
    } catch (error) {
      this.pendingRequests.delete(taskId);
      this.store.resolveApproval(taskId, 'send_failed');
      this.logger.error('发送审批测试卡片失败', error);
      await reply(wxColor('审批测试卡片发送失败，请查看本机服务日志。', 'warning'));
    }
  }

  async handleProjectCommand(reply, session, command) {
    if (command.args[0] === 'list' || !command.args.length) return reply(this.config.projects.map((item) => `${item.id === session.project_id ? '✅' : '▫️'} ${item.id} — ${item.name}\n${item.path}`).join('\n\n'));
    if (command.args[0] !== 'use' || !command.args[1]) return reply(`${wxColor('用法', 'comment')}：/项目 list 或 /项目 use <项目ID>`);
    if (session.active_turn_id) return reply(wxColor('当前任务仍在执行，不能切换项目。', 'warning'));
    const project = projectById(this.config, command.args[1]); if (!project) return reply(wxColor('项目不在允许列表中。', 'warning'));
    session.project_id = project.id; session.thread_id = null; this.store.upsertSession(session);
    return reply(`${wxColor('已切换到项目', 'info')}：${project.name}\n${project.path}\n下一条消息会创建新线程。`);
  }

  currentStatusText(session, project = null) {
    const currentProject = project || projectById(this.config, session.project_id);
    const activeTurnId = session.active_turn_id;
    const activeContext = activeTurnId ? this.turns.get(activeTurnId) : null;
    const activeTurn = activeTurnId ? this.store.getTurn(activeTurnId) : null;
    const latestTurn = activeTurn || this.store.latestTurn(session.conversation_key);
    const pendingApprovals = activeTurnId ? this.store.pendingApprovalsForTurn(activeTurnId) : [];
    const lines = [
      wxColor('当前会话状态', 'info'),
      '',
      `项目：${currentProject ? `${currentProject.name} (${currentProject.id})` : session.project_id}`,
      `模式：${session.mode === 'workspaceWrite' ? '可写' : '只读'}`,
      `模型：${this.selectedModel(session) || 'Codex 默认'}`,
      `线程：${session.thread_id || '未创建'}`,
      `执行状态：${activeTurnId ? wxColor('执行中', 'info') : wxColor('空闲', 'comment')}`,
    ];
    if (activeTurnId) {
      const startedAt = activeContext?.startedAt || activeTurn?.started_at || null;
      const recentStatus = activeContext?.statuses?.at(-1) || (activeContext ? '等待 Codex 输出或授权请求' : '本机进程重启后仅保留数据库状态');
      lines.push(
        `任务：${activeTurnId}`,
        `开始时间：${formatLocalTime(startedAt)}`,
        `已运行：${formatDuration(Date.now() - (startedAt || Date.now()))}`,
        `最近状态：${recentStatus}`,
        `待处理：${pendingApprovals.length ? wxColor(`${pendingApprovals.length} 个审批/输入请求`, 'warning') : wxColor('无', 'comment')}`,
      );
      const output = activeContext?.text || activeTurn?.final_text || '';
      if (output) lines.push('', `当前输出：\n${truncate(output, 1200)}`);
      else lines.push('', '当前输出：暂无');
      return lines.join('\n');
    }
    if (latestTurn) {
      lines.push(
        `最近任务：${latestTurn.turn_id}`,
        `最近任务状态：${wxColor(statusLabel(latestTurn.status), statusTone(latestTurn.status))}`,
        `开始时间：${formatLocalTime(latestTurn.started_at)}`,
        `完成时间：${formatLocalTime(latestTurn.completed_at)}`,
      );
      if (latestTurn.prompt) lines.push('', `最近输入：\n${truncate(latestTurn.prompt, 800)}`);
      if (latestTurn.final_text) lines.push('', `最近输出：\n${truncate(latestTurn.final_text, 1200)}`);
    } else {
      lines.push(`最近任务：${wxColor('无', 'comment')}`);
    }
    return lines.join('\n');
  }

  handleNotification(message) {
    const { method, params = {} } = message;
    if (method === 'turn/diff/updated') this.lastDiff.set(params.threadId, params.diff || '');
    const context = this.contextForParams(params); if (!context) return;
    this.markTurnActivity(context);
    const turnId = params.turnId || params.turn?.id || context.turnId;
    if (method === 'item/agentMessage/delta') { context.text += params.delta || ''; this.scheduleFlush(turnId); }
    else if (method === 'item/completed' && params.item?.type === 'agentMessage' && !context.text) context.text = params.item.text || '';
    else if (method === 'item/started') {
      if (params.item?.type === 'commandExecution') context.statuses.push(`🔧 执行命令：${truncate(params.item.command || '执行命令', 300)}`);
      if (params.item?.type === 'fileChange') context.statuses.push('📝 修改文件：正在修改文件');
      this.scheduleFlush(turnId);
    } else if (method === 'turn/completed') void this.finishTurn(params.turn.id, params.turn.status, params.turn.error);
  }
  bindTurnContext(turnId, context) {
    if (!turnId || !context) return context;
    context.turnId = turnId;
    context.session.active_turn_id = turnId;
    this.store.upsertSession(context.session);
    if (!context.turnRecorded) {
      this.store.createTurn({ turnId, conversationKey: context.session.conversation_key, threadId: context.threadId, prompt: context.prompt || '' });
      context.turnRecorded = true;
    }
    this.turns.set(turnId, context);
    if (context.threadId) this.startingThreads.delete(context.threadId);
    this.scheduleProgress(turnId);
    return context;
  }
  contextForParams(params = {}) {
    const turnId = params.turnId || params.turn?.id;
    if (turnId && this.turns.has(turnId)) return this.turns.get(turnId);
    const threadId = params.threadId || params.turn?.threadId;
    const context = threadId ? this.startingThreads.get(threadId) : null;
    if (context && turnId) return this.bindTurnContext(turnId, context);
    return context || null;
  }
  async waitForContext(params, timeoutMs = 1500) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const context = this.contextForParams(params);
      if (context) return context;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }
  markTurnActivity(context) { context.lastActivityAt = Date.now(); }
  scheduleFlush(turnId) {
    if (!turnId) return;
    if (this.flushTimers.has(turnId)) return;
    const timer = setTimeout(() => { this.flushTimers.delete(turnId); void this.flushTurn(turnId, false); }, this.config.streamIntervalMs);
    timer.unref?.();
    this.flushTimers.set(turnId, timer);
  }
  scheduleProgress(turnId) {
    if (!turnId || this.progressTimers.has(turnId)) return;
    const interval = Math.max(5000, Number(this.config.progressIntervalMs || 30000));
    const timer = setInterval(() => { void this.sendProgressNotification(turnId); }, interval);
    timer.unref?.();
    this.progressTimers.set(turnId, timer);
  }
  async flushTurn(turnId, finish) {
    const context = this.turns.get(turnId); if (!context) return;
    const status = context.statuses.length ? `${context.statuses.slice(-3).join('\n')}\n\n` : '';
    const content = truncate(`${status}${context.text || (finish ? '任务已完成。' : '正在处理…')}`);
    if (!finish && content === context.lastSent) return;
    context.lastSent = content; await this.replyStream(context.frame, context.streamId, content, finish);
  }
  progressText(context, turnId, colored = false) {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - (context.startedAt || Date.now())) / 1000));
    const recentStatus = context.statuses.at(-1) || '等待 Codex 输出或授权请求';
    const output = context.text ? `\n\n当前输出：\n${truncate(context.text, 1200)}` : '';
    const title = colored ? wxColor('Codex 仍在执行', 'info') : 'Codex 仍在执行';
    return `${title}\n\n线程：${context.threadId || context.session.thread_id || '未知线程'}\n任务：${turnId}\n已运行：${elapsedSeconds} 秒\n最近状态：${recentStatus}${output}`;
  }
  async sendProgressNotification(turnId) {
    const context = this.turns.get(turnId); if (!context) return;
    const interval = Math.max(5000, Number(this.config.progressIntervalMs || 30000));
    if (Date.now() - (context.lastActivityAt || 0) < interval) return;
    const content = truncate(this.progressText(context, turnId));
    if (content === context.lastSent) return;
    context.lastSent = content;
    await this.replyStream(context.frame, context.streamId, content, false);
  }
  async reportActiveTurn(frame, session) {
    const context = session.active_turn_id ? this.turns.get(session.active_turn_id) : null;
    const message = context
      ? this.progressText(context, session.active_turn_id, true)
      : `${wxColor('当前记录有执行中的任务，但本机内存没有对应运行上下文。', 'warning')}\n线程：${session.thread_id || '未知线程'}\n任务：${session.active_turn_id}\n建议等待完成通知；如果长时间无变化，可发送 /停止 后重新提交。`;
    await this.systemReply(frame, message);
  }
  async sendCompletionNotification(context, status, content) {
    const label = turnCompletionLabel(status);
    const tone = statusTone(status);
    const thread = context.session.thread_id || context.threadId || '未知线程';
    const chunks = splitLongText(`${wxColor(`Codex 任务${label}`, tone)}\n\n线程：${thread}\n状态：${wxColor(status || 'unknown', tone)}\n\n${content}`);
    for (const chunk of chunks) {
      await this.sendSystemText(context.target, chunk);
    }
  }
  async finishTurn(turnId, status, error) {
    const context = this.turns.get(turnId); if (!context) return;
    const timer = this.flushTimers.get(turnId); if (timer) clearTimeout(timer); this.flushTimers.delete(turnId);
    const progressTimer = this.progressTimers.get(turnId); if (progressTimer) clearInterval(progressTimer); this.progressTimers.delete(turnId);
    if (status === 'failed') context.text += `\n\n任务失败：${error?.message || '未知错误'}`;
    if (status === 'interrupted') context.text += '\n\n任务已停止。';
    context.session.active_turn_id = null;
    this.store.upsertSession(context.session);
    this.store.completeTurn(turnId, status, context.text);
    this.turns.delete(turnId);
    const statusText = context.statuses.length ? `${context.statuses.slice(-3).join('\n')}\n\n` : '';
    const finalContent = truncate(`${statusText}${context.text || '任务已完成。'}`);
    try {
      await this.replyStream(context.frame, context.streamId, finalContent, true);
    } catch (err) { this.logger.error('发送最终回复失败', err.message); }
    try {
      await this.sendCompletionNotification(context, status, finalContent);
    } catch (err) { this.logger.error('发送任务完成通知失败', err.message); }
  }

  async handleServerRequest({ message, respond }) {
    const params = message.params || {}; const context = await this.waitForContext(params);
    if (!context) {
      this.logger.warn('Codex 请求未找到活动任务上下文，已按拒绝处理', { method: message.method, threadId: params.threadId, turnId: params.turnId });
      respond(message.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' });
      return;
    }
    this.markTurnActivity(context);
    if (message.method === 'item/tool/requestUserInput') {
      const taskId = `input_${randomUUID().replaceAll('-', '')}`;
      this.pendingRequests.set(taskId, { respond, method: message.method, params });
      this.store.saveApproval({ taskId, requestId: JSON.stringify(message.id), conversationKey: context.session.conversation_key, threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, kind: 'input', payload: JSON.stringify(params) });
      const questions = params.questions?.map((item) => `• ${item.question}`).join('\n') || 'Codex 需要补充信息';
      await this.sendSystemText(context.target, `${wxColor('Codex 等待你的回复', 'warning')}\n\n${questions}\n\n直接发送下一条文本即可回答。`);
      return;
    }
    const kind = message.method.includes('commandExecution') ? 'command'
      : message.method.includes('fileChange') ? 'file'
        : message.method === 'item/permissions/requestApproval' ? 'permissions'
          : null;
    if (!kind) { respond({ decision: 'decline' }); return; }
    const taskId = `approval_${randomUUID().replaceAll('-', '')}`;
    this.pendingRequests.set(taskId, { respond, method: message.method, params, target: context.target });
    this.store.saveApproval({ taskId, requestId: JSON.stringify(message.id), conversationKey: context.session.conversation_key, threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, kind, payload: JSON.stringify(params) });
    try { await this.sendMessage(context.target, { msgtype: 'template_card', template_card: approvalCard(taskId, params, kind) }); }
    catch (error) {
      this.pendingRequests.delete(taskId); this.store.resolveApproval(taskId, 'send_failed'); respond({ decision: 'decline' }); this.logger.error('发送审批卡片失败', error.message);
    }
  }
  async handleCard(frame) {
    const event = frame.body?.event || {};
    // WeCom SDK issue #22: runtime nests the fields under template_card_event,
    // while the published TypeScript type puts them directly on event.
    const cardEvent = event.template_card_event && typeof event.template_card_event === 'object'
      ? event.template_card_event
      : event;
    const eventKey = typeof cardEvent.event_key === 'string' ? cardEvent.event_key : '';
    const [action, encodedTaskId] = eventKey.split(':');
    const taskId = typeof cardEvent.task_id === 'string' && cardEvent.task_id ? cardEvent.task_id : encodedTaskId;
    if (!taskId || !['approve', 'decline', 'cancel'].includes(action)) {
      this.logger.warn('忽略无法识别的审批按钮事件', { hasTaskId: Boolean(taskId), action: action || '(empty)' });
      return;
    }
    const pending = this.pendingRequests.get(taskId); const stored = this.store.getApproval(taskId);
    if (!pending || !stored || stored.status !== 'pending') {
      const previousTitle = stored?.status === 'accept' ? '已允许 ✅'
        : stored?.status === 'decline' ? '已拒绝'
          : stored?.status === 'cancel' ? '已取消任务'
            : '审批已失效';
      const previousDesc = stored?.status === 'accept' || stored?.status === 'decline' || stored?.status === 'cancel'
        ? '该决定此前已发送，请勿重复操作。'
        : '请重新提交任务。';
      await this.updateTemplateCard(frame, resolvedApprovalCard(taskId, previousTitle, previousDesc)); return;
    }
    const decision = action === 'approve' ? 'accept' : action === 'cancel' ? 'cancel' : 'decline';
    if (pending.method === 'item/permissions/requestApproval') {
      pending.respond({ permissions: decision === 'accept' ? requestedPermissions(pending.params) : {}, scope: 'turn' });
    } else pending.respond({ decision });
    this.pendingRequests.delete(taskId); this.store.resolveApproval(taskId, decision);
    const title = decision === 'accept' ? '已允许 ✅' : decision === 'cancel' ? '已取消任务' : '已拒绝';
    try {
      await this.updateTemplateCard(frame, resolvedApprovalCard(taskId, title));
    } catch (error) {
      // The Codex decision has already been delivered. Keep card rendering
      // failures from looking like an approval failure to the user.
      this.logger.warn('更新审批卡片失败，改发确认消息', error);
      const target = pending.target || this.turns.get(stored.turn_id)?.target;
      if (target) {
        const tone = decision === 'accept' ? 'info' : 'warning';
        await this.sendSystemText(target, `${wxColor(title, tone)}\n\n决定已发送给本机 Codex。`);
      }
    }
  }
  async answerUserInput(frame, stored, text) {
    const pending = this.pendingRequests.get(stored.task_id);
    if (!pending) {
      this.store.resolveApproval(stored.task_id, 'expired'); await this.systemReply(frame, wxColor('上一次提问已失效，请重新提交任务。', 'warning')); return;
    }
    const questions = pending.params.questions || [];
    const answers = Object.fromEntries(questions.map((question) => [question.id, { answers: [text] }]));
    pending.respond({ answers }); this.pendingRequests.delete(stored.task_id); this.store.resolveApproval(stored.task_id, 'answered');
    await this.systemReply(frame, wxColor('补充信息已发送给 Codex。', 'info'));
  }
}
