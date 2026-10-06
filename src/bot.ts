import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import {
  addRequest,
  findByMessageId,
  getRequest,
  latestOpenAsk,
  newRequestId,
  pushInbox,
  resolveRequest,
  type PendingRequest,
  type RequestKind,
} from './requests.js';

const MAX_TEXT = 4000;

export const bot = new Bot(config.botToken, { client: { apiRoot: config.apiRoot } });

function chatId(): number {
  if (config.allowedChatId === undefined) {
    throw new Error('ALLOWED_CHAT_ID is not set: send /start to the bot, put the id into .env and restart the daemon');
  }
  return config.allowedChatId;
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function withLabel(text: string, label?: string): string {
  return label ? `🤖 [${label}]\n${text}` : text;
}

function keyboard(requestId: string, options: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  const stacked = options.some((o) => o.length > 20) || options.length > 3;
  options.forEach((option, i) => {
    kb.text(option, `${requestId}:${i}`);
    if (stacked) kb.row();
  });
  return kb;
}

export async function sendNotice(text: string): Promise<void> {
  await bot.api.sendMessage(chatId(), clip(text));
}

export async function sendQuestion(kind: RequestKind, text: string, options: string[]): Promise<PendingRequest> {
  const id = newRequestId();
  const body = clip(text);
  const msg = await bot.api.sendMessage(chatId(), body, {
    reply_markup: options.length ? keyboard(id, options) : undefined,
  });
  return addRequest({ id, kind, messageId: msg.message_id, text: body, options });
}

/** Rewrites the question message with a status line and drops its keyboard. */
export async function closeQuestion(req: PendingRequest, status: string): Promise<void> {
  try {
    await bot.api.editMessageText(chatId(), req.messageId, clip(`${req.text}\n\n${status}`));
  } catch (err) {
    console.warn(`[bot] failed to update message ${req.messageId}:`, (err as Error).message);
  }
}

// /start is answered for anyone: it only reveals the sender's own chat id, which is needed for setup.
bot.command('start', (ctx) =>
  ctx.reply(
    `Chat id: ${ctx.chat.id}\n` +
      (config.allowedChatId === ctx.chat.id
        ? 'Этот чат подключён — агенты будут писать сюда.'
        : 'Укажите его в .env как ALLOWED_CHAT_ID и перезапустите демон.'),
  ),
);

// Everything else is accepted only from the configured chat.
bot.use(async (ctx, next) => {
  if (config.allowedChatId !== undefined && ctx.chat?.id === config.allowedChatId) return next();
  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
});

bot.on('callback_query:data', async (ctx) => {
  const [id, index] = ctx.callbackQuery.data.split(':');
  const req = getRequest(id);
  const option = req?.options[Number(index)];
  if (!req || option === undefined || !resolveRequest(id, { answer: option, by: 'button' })) {
    await ctx.answerCallbackQuery({ text: 'Запрос уже закрыт' });
    if (req) await closeQuestion(req, req.answer ? `➡️ ${req.answer.answer}` : '⌛ Истекло');
    return;
  }
  await ctx.answerCallbackQuery({ text: `Отправлено: ${option}` });
  await closeQuestion(req, `➡️ ${option}`);
});

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  const repliedTo = ctx.message.reply_to_message?.message_id;

  // Reply to a question → answer to that question; plain text → the latest open ask, else the inbox.
  let target = repliedTo !== undefined ? findByMessageId(repliedTo) : latestOpenAsk();
  // Approvals are buttons-only: a stray "ok" must never grant a permission.
  if (target?.kind === 'approve') target = repliedTo !== undefined ? undefined : latestOpenAsk();

  if (target && resolveRequest(target.id, { answer: text, by: 'text' })) {
    await closeQuestion(target, `➡️ ${text}`);
    await ctx.react('👍').catch(() => {});
    return;
  }

  pushInbox(text);
  await ctx.react('👀').catch(() => {});
});

bot.catch((err) => console.error('[bot] update failed:', err.error));
