import 'dotenv/config';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

const botToken = process.env.BOT_TOKEN?.trim();
if (!botToken) throw new Error('BOT_TOKEN is not set (see .env.example)');

const chatIdRaw = process.env.ALLOWED_CHAT_ID?.trim();

export const config = {
  botToken,
  /** undefined until the user configures it — the bot then only answers /start with the chat id. */
  allowedChatId: chatIdRaw ? Number(chatIdRaw) : undefined,
  port: num('PORT', 8787),
  /** Optional custom Bot API server (self-hosted or a test double). */
  apiRoot: process.env.TELEGRAM_API_ROOT?.trim() || undefined,
  askTimeoutSec: num('ASK_TIMEOUT_SEC', 240),
  approveTimeoutSec: num('APPROVE_TIMEOUT_SEC', 300),
};
