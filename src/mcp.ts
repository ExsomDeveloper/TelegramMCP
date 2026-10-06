import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { closeQuestion, sendNotice, sendQuestion, withLabel } from './bot.js';
import { config } from './config.js';
import { getRequest, readInbox, waitForAnswer, type Answer } from './requests.js';

const PROGRESS_INTERVAL_MS = 25_000;
const DEFAULT_OPTIONS = ['✅ Да', '❌ Нет'];

const INSTRUCTIONS = `Связь с пользователем через Telegram.
- notify: короткое уведомление (план готов, задача завершена, нужна помощь).
- ask: вопрос, требующий ответа (подтверждение действия, выбор варианта). Блокирует до ответа или таймаута.
  При status="timeout" продолжайте работу, не требующую ответа, и позже вызовите check_reply с тем же request_id.
- get_messages: сообщения, которые пользователь написал сам, вне вопросов.
Всегда передавайте label — короткое имя проекта/задачи, чтобы пользователь различал агентов.`;

const label = z.string().max(40).optional().describe('Short project/agent name shown in the message, e.g. "smart-wardrobe"');

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function answered(requestId: string, answer: Answer) {
  return json({ status: 'answered', request_id: requestId, ...answer });
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'telegram', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'notify',
    {
      description: 'Send a one-way Telegram message to the user (no answer expected).',
      inputSchema: { text: z.string().min(1), label },
    },
    async ({ text, label }) => {
      await sendNotice(withLabel(text, label));
      return json({ status: 'sent' });
    },
  );

  server.registerTool(
    'ask',
    {
      description:
        'Ask the user a question in Telegram and wait for the answer. The user can press a button or reply with text. ' +
        'Returns {status:"answered", answer, by} or {status:"timeout", request_id}.',
      inputSchema: {
        question: z.string().min(1),
        options: z
          .array(z.string().min(1).max(60))
          .max(8)
          .optional()
          .describe(`Answer buttons. Default: ${JSON.stringify(DEFAULT_OPTIONS)}. Pass [] for a free-text answer only.`),
        label,
        timeout_sec: z
          .number()
          .int()
          .min(5)
          .max(3600)
          .optional()
          .describe(`How long to wait before returning "timeout" (default ${config.askTimeoutSec})`),
      },
    },
    async ({ question, options, label, timeout_sec }, extra) => {
      const req = await sendQuestion('ask', withLabel(`❓ ${question}`, label), options ?? DEFAULT_OPTIONS);
      const timeoutMs = (timeout_sec ?? config.askTimeoutSec) * 1000;

      // Progress notifications keep the HTTP call active while the user thinks.
      const progressToken = extra._meta?.progressToken;
      const startedAt = Date.now();
      const ticker = progressToken
        ? setInterval(() => {
            extra
              .sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress: Date.now() - startedAt, total: timeoutMs, message: 'Waiting for the user in Telegram' },
              })
              .catch(() => {});
          }, PROGRESS_INTERVAL_MS)
        : undefined;

      try {
        const answer = await waitForAnswer(req.id, timeoutMs, extra.signal);
        if (answer) return answered(req.id, answer);
        return json({
          status: 'timeout',
          request_id: req.id,
          hint: 'The question stays open in Telegram. Call check_reply later with this request_id.',
        });
      } finally {
        clearInterval(ticker);
      }
    },
  );

  server.registerTool(
    'check_reply',
    {
      description: 'Check whether the user has answered an earlier ask (optionally waiting a bit).',
      inputSchema: {
        request_id: z.string(),
        wait_sec: z.number().int().min(0).max(240).optional().describe('Wait up to N seconds for the answer (default 0)'),
      },
    },
    async ({ request_id, wait_sec }, extra) => {
      const req = getRequest(request_id);
      if (!req) return json({ status: 'unknown', request_id });
      const answer = req.answer ?? (wait_sec ? await waitForAnswer(request_id, wait_sec * 1000, extra.signal) : undefined);
      return answer ? answered(request_id, answer) : json({ status: 'pending', request_id });
    },
  );

  server.registerTool(
    'cancel_ask',
    {
      description: 'Close an open question in Telegram when the answer is no longer needed.',
      inputSchema: { request_id: z.string(), reason: z.string().optional() },
    },
    async ({ request_id, reason }) => {
      const req = getRequest(request_id);
      if (!req || req.answer || req.expired) return json({ status: 'not_open', request_id });
      req.expired = true;
      await closeQuestion(req, `🚫 Отменено${reason ? `: ${reason}` : ''}`);
      return json({ status: 'cancelled', request_id });
    },
  );

  server.registerTool(
    'get_messages',
    {
      description: 'Get messages the user sent to the bot on their own (not answers to questions). By default returns unread ones.',
      inputSchema: { since_id: z.number().int().min(0).optional().describe('Return messages with id greater than this') },
    },
    async ({ since_id }) => json({ messages: readInbox(since_id) }),
  );

  return server;
}
