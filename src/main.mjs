import AiBot from '@wecom/aibot-node-sdk';
import { loadConfig, readSecret } from './config.mjs';
import { createLogger } from './logger.mjs';
import { Store } from './store.mjs';
import { CodexAppServer } from './codex-app-server.mjs';
import { Bridge } from './bridge.mjs';
import { AuditLogger } from './audit-logger.mjs';
import { AdminServer } from './admin-server.mjs';

const logger = createLogger({ debug: process.env.DEBUG === '1' });
let config;
try { config = loadConfig(); } catch (error) { logger.error(error.message); process.exit(1); }
let secret;
try { secret = readSecret(config); } catch (error) { logger.error(error.message); process.exit(1); }
delete process.env.WECOM_BOT_ID; delete process.env.WECOM_BOT_SECRET;

const audit = new AuditLogger({
  directory: config.auditLogDirectory,
  maxFileBytes: config.auditMaxFileBytes,
  retentionDays: config.auditRetentionDays,
  onError: (error) => logger.error('写入审计日志失败', error.message),
});
const store = new Store(config.databasePath);
const admin = config.adminEnabled ? new AdminServer({ host: config.adminHost, port: config.adminPort, store, audit, auditDirectory: config.auditLogDirectory, databasePath: config.databasePath, logger }) : null;
const codex = new CodexAppServer({ command: config.codexCommand, logger, audit });
const wecom = new AiBot.WSClient({ botId: config.botId, secret, maxReconnectAttempts: -1, logger });
secret = null;
const bridge = new Bridge({ wecom, codex, store, config, logger, audit }); bridge.attach();
codex.on('exit', (error) => { if (!shuttingDown) { audit.record('service.codexExit', { error: error.message }); logger.error('Codex App Server 异常退出，桥接服务将重启', error.message); setTimeout(() => process.exit(1), 500).unref(); } });
wecom.on('connected', () => { audit.record('wecom.connection.connected'); logger.info('企业微信 WebSocket 已连接，正在认证'); });
wecom.on('authenticated', () => { audit.record('wecom.connection.authenticated'); logger.info('企业微信机器人认证成功'); });
wecom.on('disconnected', (reason) => { audit.record('wecom.connection.disconnected', { reason }); logger.warn('企业微信连接断开', reason || '未知原因'); });
wecom.on('reconnecting', (attempt) => { audit.record('wecom.connection.reconnecting', { attempt }); logger.info(`企业微信第 ${attempt} 次重连`); });
wecom.on('error', (error) => { const message = error instanceof Error ? error.message : String(error); audit.record('wecom.connection.error', { message }); logger.error('企业微信连接错误', message); });

let shuttingDown = false;
await codex.start();
const adminAddress = admin ? await admin.start() : null;
if (adminAddress) logger.info(`管理后台已启动：${adminAddress}`);
wecom.connect(); audit.record('service.started', { projects: config.projects.map(({ id, path }) => ({ id, path })), adminAddress });
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true; logger.info(`收到 ${signal}，正在退出`);
  audit.record('service.stopping', { signal });
  wecom.disconnect(); codex.stop(); await admin?.stop(); store.close(); process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT')); process.on('SIGTERM', () => void shutdown('SIGTERM'));
