import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAppServer } from '../src/codex-app-server.mjs';
import { Bridge } from '../src/bridge.mjs';
import { Store } from '../src/store.mjs';
import { createLogger } from '../src/logger.mjs';
import { fileURLToPath } from 'node:url';

class FakeWeCom extends EventEmitter {
  constructor() { super(); this.replies = []; }
  async replyStream(_frame, streamId, content, finish) { this.replies.push({ streamId, content, finish }); this.emit('reply', this.replies.at(-1)); }
  async sendMessage() {}
  async updateTemplateCard() {}
}

const logger = createLogger();
const codex = new CodexAppServer({ logger });
const wecom = new FakeWeCom();
const cwd = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-bridge-')), 'state.sqlite'));
const config = {
  projects: [{ id: 'bridge', name: 'bridge', path: cwd }], defaultProject: 'bridge', authorizedUsers: [],
  model: null, effort: null, streamIntervalMs: 500,
};
const bridge = new Bridge({ wecom, codex, store, config, logger }); bridge.attach();
const finished = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('等待企业微信模拟回复超时')), 120_000);
  wecom.on('reply', (reply) => { if (reply.finish && reply.content.includes('BRIDGE_CHAIN_OK')) { clearTimeout(timeout); resolve(); } });
});

try {
  await codex.start();
  wecom.emit('message.text', { headers: { req_id: 'test' }, body: { msgid: 'msg-real-bridge', chattype: 'single', from: { userid: 'test-user' }, text: { content: '只回复 BRIDGE_CHAIN_OK，不要调用任何工具。' } } });
  await finished;
  const final = wecom.replies.at(-1);
  if (!final.finish) throw new Error('最终消息没有 finish 标志');
  console.log(`REAL_BRIDGE_OK replies=${wecom.replies.length}`);
} finally {
  codex.stop(); store.close();
}
