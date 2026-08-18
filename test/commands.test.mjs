import test from 'node:test';
import assert from 'node:assert/strict';
import { HELP, parseCommand } from '../src/commands.mjs';

test('parses commands and ordinary messages', () => {
  assert.deepEqual(parseCommand('/project use bridge'), { name: '/project', args: ['use', 'bridge'], rawArgs: 'use bridge' });
  assert.deepEqual(parseCommand('/test-approval'), { name: '/test-approval', args: [], rawArgs: '' });
  assert.deepEqual(parseCommand('/选择对话'), { name: '/threads', args: [], rawArgs: '' });
  assert.deepEqual(parseCommand('/新建对话'), { name: '/new', args: [], rawArgs: '' });
  assert.deepEqual(parseCommand('/选择模型 gpt-5.5'), { name: '/model', args: ['gpt-5.5'], rawArgs: 'gpt-5.5' });
  assert.deepEqual(parseCommand('/指令帮助'), { name: '/help', args: [], rawArgs: '' });
  assert.equal(parseCommand('执行测试'), null);
});

test('help includes English commands and their meanings', () => {
  for (const command of ['/threads', '/new', '/model', '/status', '/stop', '/project', '/readonly', '/write', '/resume', '/send', '/diff', '/test-approval', '/help']) {
    assert.equal(HELP.includes(command), true, `missing ${command}`);
  }
  assert.equal(HELP.includes('英文指令及含义'), true);
});
