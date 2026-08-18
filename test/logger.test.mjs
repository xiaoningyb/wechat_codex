import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/logger.mjs';

test('redacts secrets and temporary response URLs', () => {
  const value = redact({ secret: 'abc', userid: 'user-1', nested: { response_url: 'https://x.test?a=1', text: 'Bearer abc.def' } });
  assert.equal(value.secret, '[REDACTED]');
  assert.equal(value.nested.response_url, '[REDACTED]');
  assert.equal(value.userid, '[REDACTED]');
  assert.equal(value.nested.text, 'Bearer [REDACTED]');
});
