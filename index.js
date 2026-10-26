import { defineTool } from '@deepseek-ai/dsh-tools';
import { createAdapter } from './adapter.js';

export const name = 'harzva-wechat-usechat';
export const inject = ['tools'];

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

export function apply(ctx, config = {}) {
  // Environment belongs to the DSH host. No tool argument can select a config,
  // executable, Helper, receipt path, or destination beyond its allowlist.
  const adapter = createAdapter({ host: config });
  const definitions = [
    defineTool({
      name: 'usechat_doctor',
      description: 'Check the host-selected UseChat Helper, permissions and visible window. Does not install Helper or read messages.',
      parameters: {}, output,
      async execute(_args, exec) { return adapter.doctor(exec.signal); },
    }),
    defineTool({
      name: 'usechat_read',
      description: 'Read only current visible messages from a host-allowed WeChat chat. A configured vision provider may receive screenshots and OCR.',
      parameters: {
        chat: { type: 'string', required: true },
        limit: { type: 'integer' },
      }, output,
      async execute(args, exec) { return adapter.read(args, exec.signal); },
    }),
    defineTool({
      name: 'usechat_send_text',
      description: 'Send text to a host-allowed WeChat chat. Requires host opt-in and DSH approval policy. Supply a fresh requestId; inspect uncertain receipts before any new send.',
      parameters: {
        chat: { type: 'string', required: true },
        text: { type: 'string', required: true },
        requestId: { type: 'string', required: true },
      }, output,
      async execute(args, exec) { return adapter.send(args, exec.signal); },
    }),
  ];
  for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  // DSH resolves `ask` through its approval service and fails closed when
  // approval is absent or unavailable. Preserve an upstream denial/cancel.
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next();
    if (exec.name !== 'usechat_send_text' || downstream.kind !== 'allow') return downstream;
    return { kind: 'ask', reason: 'Sending a WeChat message requires one-shot approval.' };
  }, { prepend: true }));
}
