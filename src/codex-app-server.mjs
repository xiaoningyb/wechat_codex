import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class CodexAppServer extends EventEmitter {
  constructor({ command = 'codex', logger, audit = null, spawnFn = spawn } = {}) {
    super();
    this.command = command; this.logger = logger; this.audit = audit; this.spawnFn = spawnFn;
    this.nextId = 1; this.pending = new Map(); this.process = null;
  }
  async start() {
    if (this.process) return;
    this.process = this.spawnFn(this.command, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.audit?.record('codex.process.started', { command: this.command, args: ['app-server', '--listen', 'stdio://'] });
    this.process.on('error', (error) => {
      this.audit?.record('codex.process.error', { error: { name: error.name, message: error.message, code: error.code } });
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
      this.pending.clear(); this.emit('exit', error);
    });
    this.process.stderr.on('data', (chunk) => { const value = chunk.toString().trim(); if (value) { this.audit?.record('codex.process.stderr', { text: value }); this.logger.warn('Codex App Server', value); } });
    this.process.on('exit', (code, signal) => {
      this.audit?.record('codex.process.exited', { code, signal });
      const error = new Error(`Codex App Server 已退出 (code=${code}, signal=${signal})`);
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
      this.pending.clear(); this.process = null; this.emit('exit', error);
    });
    createInterface({ input: this.process.stdout }).on('line', (line) => this.#receive(line));
    await this.request('initialize', { clientInfo: { name: 'wecom_codex_local_bridge', title: 'WeCom Codex Local Bridge', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.notify('initialized', {});
    this.logger.info('Codex App Server 初始化成功');
  }
  stop() { if (this.process) this.process.kill('SIGTERM'); }
  request(method, params = {}) {
    if (!this.process?.stdin.writable) return Promise.reject(new Error('Codex App Server 未运行'));
    const id = this.nextId++; this.#write({ method, id, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: 等待 App Server 响应超时`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }
  notify(method, params = {}) { this.#write({ method, params }); }
  respond(id, result) { this.#write({ id, result }); }
  respondError(id, code, message) { this.#write({ id, error: { code, message } }); }
  async startThread({ cwd, mode = 'readOnly', model = null }) {
    const params = { cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: mode === 'workspaceWrite' ? 'workspace-write' : 'read-only', serviceName: 'wecom_codex_local_bridge' };
    if (model) params.model = model;
    return (await this.request('thread/start', params)).thread;
  }
  async resumeThread(threadId) { return (await this.request('thread/resume', { threadId })).thread; }
  async ensureThreadLoaded(threadId) {
    const result = await this.request('thread/loaded/list');
    if ((result.data || []).includes(threadId)) return { loaded: true };
    return { loaded: false, thread: await this.resumeThread(threadId) };
  }
  async startTurn({ threadId, text, cwd, mode, model = null, effort = null, clientUserMessageId = null }) {
    const sandboxPolicy = mode === 'workspaceWrite'
      ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      : { type: 'readOnly', networkAccess: false };
    const params = { threadId, input: [{ type: 'text', text }], cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy };
    if (model) params.model = model;
    if (effort) params.effort = effort;
    if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;
    return (await this.request('turn/start', params)).turn;
  }
  interrupt(threadId, turnId) { return this.request('turn/interrupt', { threadId, turnId }); }
  steer(threadId, turnId, text) { return this.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] }); }
  #write(message) { this.audit?.record('codex.rpc.outbound', { message }); this.process.stdin.write(`${JSON.stringify(message)}\n`); }
  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { this.audit?.record('codex.rpc.invalid', { line }); this.logger.warn('忽略无法解析的 App Server 输出'); return; }
    this.audit?.record('codex.rpc.inbound', { message });
    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`)); else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, 'id') && message.method) {
      this.emit('serverRequest', { message, respond: (result) => this.respond(message.id, result) }); return;
    }
    if (message.method) this.emit('notification', message);
  }
}
