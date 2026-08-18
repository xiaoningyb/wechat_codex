import { CodexAppServer } from '../src/codex-app-server.mjs';
import { createLogger } from '../src/logger.mjs';
import { fileURLToPath } from 'node:url';

const codex = new CodexAppServer({ logger: createLogger() });
let output = '';
let turnId;
const completed = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('等待 Codex 完成超时')), 120_000);
  codex.on('notification', (message) => {
    if (message.method === 'item/agentMessage/delta' && message.params.turnId === turnId) output += message.params.delta || '';
    if (message.method === 'turn/completed' && message.params.turn.id === turnId) {
      clearTimeout(timeout);
      if (message.params.turn.status === 'completed') resolve();
      else reject(new Error(`Codex 状态：${message.params.turn.status}`));
    }
  });
});

try {
  await codex.start();
  const cwd = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  const thread = await codex.startThread({ cwd, mode: 'readOnly' });
  const turn = await codex.startTurn({ threadId: thread.id, text: '只回复 BRIDGE_OK，不要调用任何工具。', cwd, mode: 'readOnly' });
  turnId = turn.id;
  await completed;
  if (!output.includes('BRIDGE_OK')) throw new Error(`未收到预期输出，实际为：${output}`);
  console.log(`REAL_APP_SERVER_OK thread=${thread.id} turn=${turn.id}`);
} finally {
  codex.stop();
}
