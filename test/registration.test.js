import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

test('DSH plugin registers exactly three tools and asks for each send', async () => {
  const names = [];
  const listeners = new Map();
  const ctx = {
    tools: { register(definition) { names.push(definition.name); return () => {}; } },
    effect(install) { install(); },
    on(event, callback) { listeners.set(event, callback); return () => {}; },
  };
  apply(ctx);
  assert.deepEqual(names, ['usechat_doctor', 'usechat_read', 'usechat_send_text']);
  const pre = listeners.get('tools/pre-execute');
  assert.equal((await pre({ name: 'usechat_send_text' }, async () => ({ kind: 'allow' }))).kind, 'ask');
  assert.equal((await pre({ name: 'usechat_read' }, async () => ({ kind: 'allow' }))).kind, 'allow');
  assert.equal((await pre({ name: 'usechat_send_text' }, async () => ({ kind: 'deny', reason: 'host denied' }))).kind, 'deny');
});
