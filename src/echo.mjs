import AiBot, { generateReqId } from '@wecom/aibot-node-sdk';

const botId = process.env.WECOM_BOT_ID?.trim();
const secret = process.env.WECOM_BOT_SECRET?.trim();

if (!botId || !secret) {
  console.error('缺少 WECOM_BOT_ID 或 WECOM_BOT_SECRET。请使用 ./start-echo.zsh 启动。');
  process.exit(1);
}

// SDK 创建后不再让后续子进程继承凭据。
delete process.env.WECOM_BOT_ID;
delete process.env.WECOM_BOT_SECRET;

const client = new AiBot.WSClient({
  botId,
  secret,
  maxReconnectAttempts: -1,
});

let authenticated = false;

const timestamp = () => new Date().toLocaleString('zh-CN', { hour12: false });

client.on('connected', () => {
  console.log(`[${timestamp()}] WebSocket 已连接，正在认证…`);
});

client.on('authenticated', () => {
  authenticated = true;
  console.log(`[${timestamp()}] 认证成功。现在请在企业微信中向机器人发送：ping-001`);
});

client.on('message.text', async (frame) => {
  const content = frame.body?.text?.content?.trim() || '';
  console.log(`[${timestamp()}] 收到文本：${content || '(空消息)'}`);

  const preview = content.slice(0, 500);
  const reply = preview ? `pong：${preview}` : 'pong';
  const streamId = generateReqId('echo');

  try {
    await client.replyStream(frame, streamId, reply, true);
    console.log(`[${timestamp()}] 已回复：${reply}`);
  } catch (error) {
    console.error(`[${timestamp()}] 回复失败：${error instanceof Error ? error.message : String(error)}`);
  }
});

client.on('disconnected', (reason) => {
  console.warn(`[${timestamp()}] 连接断开：${reason || '未知原因'}`);
});

client.on('reconnecting', (attempt) => {
  console.log(`[${timestamp()}] 正在第 ${attempt} 次重连…`);
});

client.on('error', (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${timestamp()}] 企业微信连接错误：${message}`);
});

const shutdown = () => {
  console.log(`\n[${timestamp()}] 正在断开连接…`);
  client.disconnect();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[${timestamp()}] 正在启动企业微信回声测试…`);
client.connect();

setTimeout(() => {
  if (!authenticated) {
    console.warn(`[${timestamp()}] 尚未认证成功，请检查 Bot ID、新 Secret 和机器人是否已被其他程序连接。`);
  }
}, 15_000);
