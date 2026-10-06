import { basename } from 'node:path';
import { Router } from 'express';
import { closeQuestion, sendNotice, sendQuestion, withLabel } from './bot.js';
import { config } from './config.js';
import { expireRequest, waitForAnswer } from './requests.js';

/** Fields of Claude Code hook input that we use (see https://code.claude.com/docs/en/hooks). */
interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  last_assistant_message?: string;
  message?: string;
  notification_type?: string;
}

const ALLOW = '✅ Разрешить';
const DENY = '❌ Запретить';

function project(input: HookInput): string | undefined {
  return input.cwd ? basename(input.cwd) : undefined;
}

function describeTool(input: HookInput): string {
  const toolInput = input.tool_input ?? {};
  const main = toolInput.command ?? toolInput.file_path ?? toolInput.url ?? toolInput.pattern;
  const details = typeof main === 'string' ? main : JSON.stringify(toolInput, null, 1);
  const description = typeof toolInput.description === 'string' ? `\n${toolInput.description}` : '';
  return `${input.tool_name ?? 'tool'}${description}\n\n${details.slice(0, 2500)}`;
}

function permissionDecision(behavior: 'allow' | 'deny', message?: string) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior, message } } };
}

export const hooksRouter = Router();

/** Stop / Notification hooks: one-way message. */
hooksRouter.post('/notify', async (req, res) => {
  const input = req.body as HookInput;
  let text: string;
  if (input.hook_event_name === 'Stop') {
    const summary = input.last_assistant_message?.trim();
    text = `✅ Агент завершил ответ${summary ? `\n\n${summary.slice(0, 1500)}` : ''}`;
  } else {
    text = `🔔 ${input.message ?? input.notification_type ?? input.hook_event_name ?? 'Уведомление'}`;
  }
  try {
    await sendNotice(withLabel(text, project(input)));
    res.json({});
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * PermissionRequest hook: asks in Telegram and holds the HTTP request until a button is pressed.
 * On timeout or if the hook process goes away (e.g. the user answered in the terminal) it returns {}
 * so Claude Code falls back to its normal permission dialog.
 */
hooksRouter.post('/approve', async (req, res) => {
  const input = req.body as HookInput;
  let pending;
  try {
    pending = await sendQuestion('approve', withLabel(`🔐 Запрос разрешения: ${describeTool(input)}`, project(input)), [ALLOW, DENY]);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
    return;
  }

  const abort = new AbortController();
  res.on('close', () => abort.abort());

  const answer = await waitForAnswer(pending.id, config.approveTimeoutSec * 1000, abort.signal);
  if (!answer) {
    expireRequest(pending.id);
    await closeQuestion(pending, abort.signal.aborted ? '↩️ Решено в терминале' : '⌛ Время вышло — решение в терминале');
    if (!res.headersSent) res.json({});
    return;
  }

  res.json(
    answer.answer === ALLOW
      ? permissionDecision('allow')
      : permissionDecision('deny', 'Пользователь отклонил действие через Telegram'),
  );
});
