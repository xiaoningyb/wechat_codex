import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServer } from '../src/codex-app-server.mjs';

test('does not resume a thread that is already loaded in App Server memory', async () => {
  const codex = new CodexAppServer({ logger: { warn() {} } });
  let resumed = false;
  codex.request = async (method) => {
    assert.equal(method, 'thread/loaded/list');
    return { data: ['thread-blank'] };
  };
  codex.resumeThread = async () => { resumed = true; };
  assert.deepEqual(await codex.ensureThreadLoaded('thread-blank'), { loaded: true });
  assert.equal(resumed, false);
});

test('resumes a stored thread only when it is not loaded', async () => {
  const codex = new CodexAppServer({ logger: { warn() {} } });
  codex.request = async () => ({ data: [] });
  codex.resumeThread = async (threadId) => ({ id: threadId });
  assert.deepEqual(await codex.ensureThreadLoaded('thread-stored'), { loaded: false, thread: { id: 'thread-stored' } });
});
