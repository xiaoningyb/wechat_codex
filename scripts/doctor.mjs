#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, readSecret } from '../src/config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const configArgIndex = process.argv.findIndex((item) => item === '--config');
const configPath = configArgIndex >= 0 ? process.argv[configArgIndex + 1] : process.env.WECOM_CODEX_CONFIG || resolve(root, 'config.json');
const withSecret = args.has('--with-secret');
const checks = [];

function record(name, ok, detail = '') {
  checks.push({ name, ok, detail });
}

function commandExists(command) {
  if (command.includes('/')) return existsSync(command);
  const result = spawnSync('/bin/zsh', ['-lc', `command -v ${JSON.stringify(command)}`], { encoding: 'utf8' });
  return result.status === 0 && Boolean(result.stdout.trim());
}

record('Node.js >= 22', Number(process.versions.node.split('.')[0]) >= 22, process.version);
record('package.json exists', existsSync(resolve(root, 'package.json')));
record('package-lock.json exists', existsSync(resolve(root, 'package-lock.json')));
record('config file exists', existsSync(resolve(configPath)), configPath);

let config = null;
try {
  config = loadConfig(configPath);
  record('config loads', true, config.configPath);
} catch (error) {
  record('config loads', false, error.message);
}

if (config) {
  record('botId configured', Boolean(config.botId), config.botId ? 'set' : 'missing');
  record('project allowlist not empty', config.projects.length > 0, `${config.projects.length} project(s)`);
  for (const project of config.projects) {
    let ok = false;
    try { ok = statSync(project.path).isDirectory(); } catch {}
    record(`project path: ${project.id}`, ok, project.path);
  }
  record('defaultProject exists', config.projects.some((item) => item.id === config.defaultProject), config.defaultProject);
  record('admin host loopback', ['127.0.0.1', '::1', 'localhost'].includes(config.adminHost), config.adminHost);
  record('codex command available', commandExists(config.codexCommand), config.codexCommand);
  if (withSecret) {
    try {
      const secret = readSecret(config);
      record('keychain secret available', Boolean(secret), config.keychain?.service || 'wecom-codex-bridge');
    } catch (error) {
      record('keychain secret available', false, error.message);
    }
  }
}

const failed = checks.filter((item) => !item.ok);
for (const item of checks) {
  const mark = item.ok ? '✅' : '❌';
  console.log(`${mark} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}

if (failed.length) {
  console.error(`\n${failed.length} check(s) failed.`);
  process.exit(1);
}

console.log('\nAll checks passed.');
