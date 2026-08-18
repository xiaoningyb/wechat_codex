import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`配置项 ${name} 不能为空`);
  return value.trim();
}

export function readSecret(config, env = process.env) {
  const envSecret = env.WECOM_BOT_SECRET?.trim();
  if (envSecret) return envSecret;
  const service = config.keychain?.service || 'wecom-codex-bridge';
  const account = config.keychain?.account || config.botId;
  const result = spawnSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('未在 macOS 钥匙串找到机器人 Secret。请运行 ./scripts/setup-keychain.zsh');
  return result.stdout.trim();
}

export function loadConfig(configPath = process.env.WECOM_CODEX_CONFIG || './config.json') {
  const absoluteConfigPath = resolve(configPath);
  const configDirectory = dirname(absoluteConfigPath);
  const raw = JSON.parse(readFileSync(absoluteConfigPath, 'utf8'));
  const projects = (raw.projects || []).map((project) => {
    const id = requiredString(project.id, 'projects[].id');
    const configuredPath = requiredString(project.path, `projects.${id}.path`);
    if (!isAbsolute(configuredPath)) throw new Error(`项目 ${id} 必须使用绝对路径`);
    return { id, name: project.name?.trim() || id, path: realpathSync(configuredPath) };
  });
  if (!projects.length) throw new Error('至少需要配置一个 projects 项目');
  if (new Set(projects.map((item) => item.id)).size !== projects.length) throw new Error('projects.id 不能重复');
  const defaultProject = raw.defaultProject || projects[0].id;
  if (!projects.some((item) => item.id === defaultProject)) throw new Error('defaultProject 不在 projects 中');
  const adminHost = raw.adminHost || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(adminHost)) throw new Error('adminHost 只允许本机回环地址');
  const adminPort = Number(raw.adminPort || 17321);
  if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535) throw new Error('adminPort 必须是 1-65535 的整数');
  return {
    ...raw, configPath: absoluteConfigPath,
    botId: requiredString(process.env.WECOM_BOT_ID || raw.botId, 'botId'), projects, defaultProject,
    authorizedUsers: Array.isArray(raw.authorizedUsers) ? raw.authorizedUsers.filter(Boolean) : [],
    databasePath: resolve(raw.databasePath || './.data/bridge.sqlite'), codexCommand: raw.codexCommand || 'codex',
    model: raw.model || null, effort: raw.effort || null, streamIntervalMs: Math.max(500, Number(raw.streamIntervalMs || 900)),
    progressIntervalMs: Math.max(5000, Number(raw.progressIntervalMs || 30000)),
    auditLogDirectory: resolve(configDirectory, raw.auditLogDirectory || './logs/audit'),
    auditMaxFileBytes: Math.max(1024 * 1024, Number(raw.auditMaxFileBytes || 50 * 1024 * 1024)),
    auditRetentionDays: Math.max(1, Number(raw.auditRetentionDays || 30)),
    adminEnabled: raw.adminEnabled !== false, adminHost, adminPort,
  };
}

export function projectById(config, id) { return config.projects.find((project) => project.id === id) || null; }

export function projectByPath(config, path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  let canonical;
  try { canonical = realpathSync(path); } catch { canonical = resolve(path); }
  return config.projects.find((project) => {
    try { return realpathSync(project.path) === canonical; } catch { return resolve(project.path) === canonical; }
  }) || null;
}
