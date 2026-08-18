const SENSITIVE_KEYS = /^(secret|token|authorization|response_url|aeskey|userid|corpid)$/i;
const SECRET_PATTERNS = [
  /([?&](?:access_token|key|secret|token)=)[^&\s]+/gi,
  /(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,
];

export function redact(value, key = '') {
  if (SENSITIVE_KEYS.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '$1[REDACTED]'), value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

function serialize(value) {
  if (typeof value === 'string') return redact(value);
  try { return JSON.stringify(redact(value)); } catch { return '[无法序列化]'; }
}

export function createLogger({ debug = false } = {}) {
  const write = (level, message, args) => {
    if (level === 'DEBUG' && !debug) return;
    const suffix = args.length ? ` ${args.map(serialize).join(' ')}` : '';
    const line = `[${new Date().toISOString()}] [${level}] ${serialize(message)}${suffix}`;
    (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(line);
  };
  return {
    debug: (message, ...args) => write('DEBUG', message, args),
    info: (message, ...args) => write('INFO', message, args),
    warn: (message, ...args) => write('WARN', message, args),
    error: (message, ...args) => write('ERROR', message, args),
  };
}
