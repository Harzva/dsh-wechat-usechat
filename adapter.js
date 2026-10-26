import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(import.meta.resolve('@shennian/usechat'));
const MAX_OUTPUT = 1024 * 1024;
let foreground = Promise.resolve();

function serial(job) {
  const current = foreground.then(job, job);
  foreground = current.catch(() => {});
  return current;
}

function fail(code, message) { return { ok: false, reasonCode: code, message }; }
function validChat(chat, allowed) {
  return typeof chat === 'string' && chat.length > 0 && chat.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(chat) && allowed.includes(chat);
}
function settings(env, host) {
  if (!host || typeof host !== 'object' || Array.isArray(host) || Object.keys(host).some(key =>
    !['configPath', 'allowedChats', 'writeEnabled', 'receiptDir', 'uiLeaseDir'].includes(key))) {
    return { error: fail('host_plugin_config_invalid', 'Unsupported host plugin configuration.') };
  }
  const configPath = host.configPath ?? env.USECHAT_DSH_CONFIG;
  if (!configPath || !isAbsolute(configPath)) return { error: fail('host_config_required', 'Host must select an absolute UseChat config path.') };
  let allowed;
  try { allowed = host.allowedChats ?? JSON.parse(env.USECHAT_DSH_ALLOWED_CHATS || '[]'); } catch { allowed = null; }
  if (!Array.isArray(allowed) || allowed.some(item => typeof item !== 'string' || !item || item.length > 160) || new Set(allowed).size !== allowed.length) {
    return { error: fail('host_allowlist_invalid', 'Host chat allowlist must be a JSON array of unique names.') };
  }
  if (host.writeEnabled !== undefined && typeof host.writeEnabled !== 'boolean') return { error: fail('host_plugin_config_invalid', 'writeEnabled must be boolean.') };
  return { configPath, allowed, writeEnabled: host.writeEnabled ?? env.USECHAT_DSH_WRITE_ENABLED === '1',
    receiptDir: host.receiptDir ?? env.USECHAT_DSH_RECEIPTS_DIR, uiLeaseDir: host.uiLeaseDir ?? env.USECHAT_DSH_UI_LEASE_DIR };
}

async function runCli(argv, signal, timeoutMs = 90000) {
  if (signal?.aborted) return { ok: false, reasonCode: 'aborted' };
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...argv], { shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '', stderrBytes = 0, settled = false, timedOut = false, aborted = false, oversized = false, startFailed = false;
    let escalation;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', onAbort); resolve(value); } };
    const signalGroup = sig => {
      try { if (process.platform === 'win32' || !child.pid) child.kill(sig); else process.kill(-child.pid, sig); } catch { /* already exited */ }
    };
    const terminate = () => { signalGroup('SIGTERM'); if (!escalation) escalation = setTimeout(() => signalGroup('SIGKILL'), 1500); };
    const onAbort = () => { aborted = true; terminate(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); if (Buffer.byteLength(stdout) > MAX_OUTPUT) { oversized = true; terminate(); } });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > MAX_OUTPUT) { oversized = true; terminate(); } });
    child.on('error', () => { startFailed = true; });
    child.on('close', code => {
      if (startFailed) return finish({ ok: false, reasonCode: 'cli_start_failed' });
      if (aborted) return finish({ ok: false, reasonCode: 'aborted' });
      if (timedOut) return finish({ ok: false, reasonCode: 'timeout' });
      if (oversized) return finish({ ok: false, reasonCode: 'output_too_large' });
      let value;
      try { value = JSON.parse(stdout); } catch { return finish({ ok: false, reasonCode: 'invalid_cli_json', exitCode: code }); }
      if (code !== 0 || value?.ok === false) return finish({ ok: false, reasonCode: value?.reasonCode || 'cli_failed', exitCode: code, result: value });
      finish({ ok: true, result: value });
    });
  });
}

async function ensureConfig(configPath) {
  try { const info = await stat(configPath); return info.isFile() ? null : fail('host_config_invalid', 'Selected UseChat config is not a file.'); }
  catch { return fail('host_config_missing', 'Selected UseChat config is unavailable.'); }
}

async function privateRoot(path) {
  if (!path || !isAbsolute(path)) throw new Error('private_dir_required');
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('private_dir_unprivate');
  return realpath(path);
}

async function acquireUiLease(path) {
  const root = await privateRoot(path);
  const active = join(root, '.active');
  await mkdir(active);
  return async () => rmdir(active);
}

async function saveReceipt(dir, id, value, first = false) {
  const target = join(dir, `${id}.json`);
  if (first) {
    const handle = await open(target, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  } else {
    const temporary = join(dir, `${id}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
  }
  const directory = await open(dir, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function pendingReceipt(dir, chat) {
  for (const name of await readdir(dir)) {
    if (!/^[a-zA-Z0-9_-]{8,128}\.json$/.test(name)) continue;
    const receipt = JSON.parse(await readFile(join(dir, name), 'utf8'));
    if (receipt.chat === chat && ['attempting', 'uncertain'].includes(receipt.status)) return receipt.requestId;
  }
  return null;
}

export function createAdapter({ env = process.env, host = {}, invoke = runCli } = {}) {
  async function base(chat) {
    const config = settings(env, host);
    if (config.error) return config;
    const error = await ensureConfig(config.configPath);
    if (error) return { error };
    if (chat !== undefined && !validChat(chat, config.allowed)) return { error: fail('chat_not_allowed', 'Chat is not on the host allowlist.') };
    return config;
  }
  return {
    doctor: signal => serial(async () => {
      const config = await base();
      if (config.error) return config.error;
      let release;
      try { release = await acquireUiLease(config.uiLeaseDir); }
      catch { return fail('ui_lease_unavailable', 'Private shared UI lease is missing or busy. Inspect stale lease manually.'); }
      const result = await invoke(['--config', config.configPath, '--json', 'doctor'], signal, 30000);
      if (result.reasonCode !== 'timeout' && result.reasonCode !== 'aborted') await release().catch(() => {});
      return { ok: result.ok && result.result?.ok === true, reasonCode: result.ok ? undefined : result.reasonCode,
        checks: Array.isArray(result.result?.checks) ? result.result.checks.map(check => ({ id: check.id, ok: check.ok, reasonCode: check.reasonCode })) : [] };
    }),
    read: ({ chat, limit = 20 }, signal) => serial(async () => {
      const config = await base(chat);
      if (config.error) return config.error;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail('limit_invalid', 'limit must be between 1 and 50.');
      let release;
      try { release = await acquireUiLease(config.uiLeaseDir); }
      catch { return fail('ui_lease_unavailable', 'Private shared UI lease is missing or busy. Inspect stale lease manually.'); }
      const result = await invoke(['--config', config.configPath, '--json', 'read', '--app', 'wechat', '--chat', chat,
        '--limit', String(limit), '--format', 'json', '--download', 'never', '--no-trace-jsonl'], signal, 90000);
      if (result.reasonCode !== 'timeout' && result.reasonCode !== 'aborted') await release().catch(() => {});
      return result;
    }),
    send: ({ chat, text, requestId }, signal) => serial(async () => {
      const config = await base(chat);
      if (config.error) return config.error;
      if (!config.writeEnabled) return fail('write_disabled', 'Host must enable writes and require approval in DSH tool policy.');
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) return fail('text_invalid', 'Text must be 1–4000 characters.');
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) return fail('request_id_invalid', 'requestId must be 8–128 ASCII letters, digits, _ or -.');
      let dir;
      try { dir = await privateRoot(config.receiptDir); }
      catch { return fail('receipt_dir_invalid', 'Host must pre-create a private 0700 receipt directory.'); }
      const id = createHash('sha256').update(requestId).digest('hex');
      const target = join(dir, `${id}.json`);
      try { await stat(target); return fail('request_already_recorded', `Inspect receipt ${id}.json before any new send.`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let uiRelease;
      try { uiRelease = await acquireUiLease(config.uiLeaseDir); }
      catch { return fail('ui_lease_unavailable', 'Private shared UI lease is missing or busy. Inspect stale lease manually.'); }
      let lock = false;
      try {
        await mkdir(join(dir, '.active')); lock = true;
      } catch { await uiRelease().catch(() => {}); return fail('send_locked', 'Another send or an unresolved interrupted send holds the receipt lock.'); }
      let completed = false;
      try {
        const pending = await pendingReceipt(dir, chat);
        if (pending) { completed = true; return fail('send_uncertain', `Inspect unresolved request ${pending} before sending to this chat.`); }
        const receipt = { requestId, chat, textSha256: createHash('sha256').update(text).digest('hex'), status: 'attempting', createdAt: new Date().toISOString() };
        await saveReceipt(dir, id, receipt, true);
        const outcome = await invoke(['--config', config.configPath, '--json', 'write', '--app', 'wechat', '--chat', chat,
          '--text', text, '--yes', '--no-trace-jsonl'], signal, 90000);
        receipt.status = outcome.ok && outcome.result?.sent === true ? 'submitted_unconfirmed' : 'uncertain';
        receipt.updatedAt = new Date().toISOString();
        receipt.reasonCode = outcome.ok ? undefined : outcome.reasonCode;
        await saveReceipt(dir, id, receipt);
        completed = receipt.status === 'submitted_unconfirmed';
        return { ok: completed, status: receipt.status, reasonCode: completed ? undefined : 'send_uncertain', requestId, receipt: `${id}.json`, result: completed ? outcome.result : undefined };
      } catch { return fail('send_uncertain', `Send state unknown. Inspect receipt ${id}.json and .active before any new send.`); }
      finally {
        if (lock && completed) await rmdir(join(dir, '.active')).catch(() => {});
        if (completed) await uiRelease().catch(() => {});
      }
    }),
  };
}
