import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter } from '../adapter.js';

async function fixture(invoke = async () => ({ ok: true, result: { sent: true, status: 'sent-unconfirmed' } })) {
  const root = await mkdtemp(join(tmpdir(), 'usechat-dsh-'));
  const configPath = join(root, 'usechat.json');
  const receiptDir = join(root, 'receipts');
  const uiLeaseDir = join(root, 'ui-lease');
  await writeFile(configPath, '{}');
  await mkdir(receiptDir, { mode: 0o700 });
  await mkdir(uiLeaseDir, { mode: 0o700 });
  await chmod(receiptDir, 0o700);
  await chmod(uiLeaseDir, 0o700);
  const env = { USECHAT_DSH_CONFIG: configPath, USECHAT_DSH_ALLOWED_CHATS: '["Allowed"]',
    USECHAT_DSH_RECEIPTS_DIR: receiptDir, USECHAT_DSH_UI_LEASE_DIR: uiLeaseDir };
  return { root, env, adapter: createAdapter({ env, invoke }), receiptDir, uiLeaseDir };
}

test('host config and exact target allowlist are required', async () => {
  const { env, adapter } = await fixture();
  assert.equal((await adapter.read({ chat: 'Other' })).reasonCode, 'chat_not_allowed');
  assert.equal((await createAdapter({ env: {} }).doctor()).reasonCode, 'host_config_required');
  env.USECHAT_DSH_ALLOWED_CHATS = 'bad-json';
  assert.equal((await adapter.read({ chat: 'Allowed' })).reasonCode, 'host_allowlist_invalid');
});

test('read fixes app, format and download; rejects unbounded limit', async () => {
  let argv;
  const { adapter } = await fixture(async args => { argv = args; return { ok: true, result: { ok: true, messages: [] } }; });
  assert.equal((await adapter.read({ chat: 'Allowed', limit: 51 })).reasonCode, 'limit_invalid');
  assert.equal((await adapter.read({ chat: 'Allowed', limit: 2 })).ok, true);
  assert.deepEqual(argv.slice(3), ['read', '--app', 'wechat', '--chat', 'Allowed', '--limit', '2', '--format', 'json', '--download', 'never', '--no-trace-jsonl']);
});

test('shared UI lease prevents a second process from entering and is not auto-reclaimed', async () => {
  const { adapter, uiLeaseDir } = await fixture();
  await mkdir(join(uiLeaseDir, '.active'));
  assert.equal((await adapter.read({ chat: 'Allowed' })).reasonCode, 'ui_lease_unavailable');
});

test('Cordis host config selects paths and chat list without model arguments', async () => {
  const { env, uiLeaseDir } = await fixture();
  const selected = createAdapter({ env: {}, host: {
    configPath: env.USECHAT_DSH_CONFIG, allowedChats: ['Allowed'], uiLeaseDir,
  }, invoke: async () => ({ ok: true, result: { ok: true } }) });
  assert.equal((await selected.read({ chat: 'Allowed' })).ok, true);
  assert.equal((await selected.read({ chat: 'Other' })).reasonCode, 'chat_not_allowed');
  const invalid = createAdapter({ env, host: { arbitrary: true } });
  assert.equal((await invalid.doctor()).reasonCode, 'host_plugin_config_invalid');
});

test('doctor strips upstream paths and detail fields from its report', async () => {
  const { adapter } = await fixture(async () => ({ ok: false, reasonCode: 'cli_failed', result: {
    ok: false, helper: { path: '/private/secret' }, checks: [
      { id: 'helper', ok: false, reasonCode: 'helper_missing', message: '/private/secret', details: { token: 'secret' } },
    ],
  } }));
  const result = await adapter.doctor();
  assert.deepEqual(result, { ok: false, reasonCode: 'cli_failed', checks: [{ id: 'helper', ok: false, reasonCode: 'helper_missing' }] });
});

test('writes are off by default, private receipts and valid identifiers required', async () => {
  const { env, adapter, receiptDir } = await fixture();
  const input = { chat: 'Allowed', text: 'hello', requestId: 'request_001' };
  assert.equal((await adapter.send(input)).reasonCode, 'write_disabled');
  env.USECHAT_DSH_WRITE_ENABLED = '1';
  assert.equal((await adapter.send({ ...input, chat: 'Other' })).reasonCode, 'chat_not_allowed');
  assert.equal((await adapter.send({ ...input, requestId: '../x' })).reasonCode, 'request_id_invalid');
  await chmod(receiptDir, 0o755);
  assert.equal((await adapter.send(input)).reasonCode, 'receipt_dir_invalid');
});

test('successful submission is unconfirmed and duplicate id never resends', async () => {
  let calls = 0;
  const { env, adapter, receiptDir } = await fixture(async () => { calls++; return { ok: true, result: { sent: true, status: 'sent-unconfirmed' } }; });
  env.USECHAT_DSH_WRITE_ENABLED = '1';
  const input = { chat: 'Allowed', text: 'hello', requestId: 'request_002' };
  const result = await adapter.send(input);
  assert.equal(result.status, 'submitted_unconfirmed');
  assert.equal((await adapter.send(input)).reasonCode, 'request_already_recorded');
  assert.equal(calls, 1);
  const receipt = JSON.parse(await readFile(join(receiptDir, result.receipt), 'utf8'));
  assert.equal(receipt.status, 'submitted_unconfirmed');
  assert.equal(receipt.textSha256.length, 64);
  assert.equal((await readdir(receiptDir)).includes('.active'), false);
});

test('uncertain send blocks retry and every later send until host inspects', async () => {
  let calls = 0;
  const { env, adapter, receiptDir } = await fixture(async () => { calls++; return { ok: false, reasonCode: 'timeout' }; });
  env.USECHAT_DSH_WRITE_ENABLED = '1';
  const input = { chat: 'Allowed', text: 'hello', requestId: 'request_003' };
  assert.equal((await adapter.send(input)).reasonCode, 'send_uncertain');
  assert.equal((await adapter.send(input)).reasonCode, 'request_already_recorded');
  assert.equal((await adapter.send({ ...input, requestId: 'request_004' })).reasonCode, 'ui_lease_unavailable');
  assert.equal(calls, 1);
  assert.equal((await readdir(receiptDir)).includes('.active'), true);
});
