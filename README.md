# Telegram MCP

Двусторонняя связь Claude Code-агентов с вами через Telegram-бота.

- Агент пишет вам (`notify`), задаёт вопросы с кнопками и ждёт ответа (`ask`), читает ваши сообщения (`get_messages`).
- Hooks Claude Code: уведомление о завершении ответа (`Stop`) и подтверждение разрешений кнопками в Telegram (`PermissionRequest`).

Один локальный демон владеет ботом (Telegram разрешает только одного читателя `getUpdates` на токен), все сессии Claude Code подключаются к нему по HTTP — поэтому несколько агентов могут работать одновременно, и каждый получает свой ответ.

```
Claude Code #1 ─┐  MCP (Streamable HTTP)            ┌──────────────┐
Claude Code #2 ─┼──── http://127.0.0.1:8787/mcp ───►│              │  long polling
hooks/send.mjs ─┘     http://127.0.0.1:8787/hook/*  │    демон     │◄──────────► Telegram Bot API
                                                    └──────────────┘
```

## Установка

1. Создайте бота у [@BotFather](https://t.me/BotFather) и получите токен.
2. ```sh
   npm install
   npm run build
   cp .env.example .env    # впишите BOT_TOKEN
   npm start
   ```
3. Отправьте боту `/start` — он ответит вашим `chat id`. Впишите его в `.env` как `ALLOWED_CHAT_ID` и перезапустите демон. Сообщения из других чатов игнорируются.
4. Подключите MCP ко всем проектам:
   ```sh
   claude mcp add --transport http --scope user telegram http://127.0.0.1:8787/mcp
   ```

Проверка: `curl http://127.0.0.1:8787/health` → `{"ok":true,"chatConfigured":true}`.

### Автозапуск (Windows)

Через [pm2](https://pm2.keymetrics.io/):
```sh
npm i -g pm2 pm2-windows-startup
pm2 start dist/index.js --name telegram-mcp --cwd D:/Work/Web/TelegramMCP
pm2 save && pm2-startup install
```
Или задача планировщика при входе в систему:
```powershell
schtasks /Create /TN TelegramMCP /SC ONLOGON /TR "cmd /c cd /d D:\Work\Web\TelegramMCP && node dist\index.js"
```

## MCP-инструменты

| Инструмент | Что делает |
|---|---|
| `notify(text, label?)` | Сообщение без ожидания ответа |
| `ask(question, options?, label?, timeout_sec?)` | Вопрос с кнопками (по умолчанию «✅ Да / ❌ Нет», `[]` — только текст). Ждёт ответа → `{status:"answered", answer, by}` или `{status:"timeout", request_id}` |
| `check_reply(request_id, wait_sec?)` | Ответ на вопрос, у которого истекло ожидание |
| `cancel_ask(request_id, reason?)` | Закрыть ненужный уже вопрос |
| `get_messages(since_id?)` | Сообщения, которые вы написали боту сами (по умолчанию — непрочитанные) |

Как отвечать в Telegram:
- нажать кнопку;
- ответить текстом через «Ответить» (reply) на конкретный вопрос;
- просто написать текст — он уйдёт в последний открытый `ask`, а если открытых нет — во входящие (`get_messages`). Бот ставит 👍, если текст стал ответом, и 👀, если попал во входящие.

`label` — короткое имя проекта, показывается как `🤖 [label]`, чтобы различать агентов.

### Таймауты

Claude Code прерывает HTTP-вызов MCP-инструмента после 5 минут без активности (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`). Поэтому `ask` по умолчанию ждёт 240 с (`ASK_TIMEOUT_SEC`) и возвращает `timeout`; вопрос в Telegram остаётся открытым, ответ потом забирается через `check_reply`. Пока идёт ожидание, демон шлёт progress-уведомления. Если нужно ждать дольше одним вызовом — увеличьте `timeout_sec` и задайте `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (мс, `0` — без ограничения) в окружении Claude Code.

### Подсказка агентам

Добавьте в `~/.claude/CLAUDE.md`, чтобы агенты пользовались каналом сами:

```markdown
## Telegram
Есть MCP `telegram`. Когда закончил планирование или длинную задачу — `notify`.
Перед необратимыми действиями или когда нужен мой выбор — `ask` (label = имя проекта).
При status="timeout" продолжай то, что не зависит от ответа, и проверь `check_reply` позже.
```

## Hooks

`hooks/send.mjs` пересылает JSON hook-а в демон. Если демон не запущен, скрипт молча завершается — Claude Code ведёт себя как обычно.

Добавьте в `~/.claude/settings.json` (путь поправьте под себя):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node D:/Work/Web/TelegramMCP/hooks/send.mjs notify", "timeout": 15, "async": true }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          { "type": "command", "command": "node D:/Work/Web/TelegramMCP/hooks/send.mjs approve", "timeout": 330 }
        ]
      }
    ]
  }
}
```

- **Stop** — после каждого ответа агента приходит «✅ Агент завершил ответ» с началом его последнего сообщения. Это срабатывает на каждый ход; если шумно — уберите блок и полагайтесь на `notify` из CLAUDE.md.
- **PermissionRequest** — запрос разрешения приходит с кнопками «✅ Разрешить / ❌ Запретить». Принимаются только кнопки: текстовое «да» разрешение не выдаёт. Если не ответить за `APPROVE_TIMEOUT_SEC` (300 с), решение возвращается в обычный диалог терминала. `timeout` hook-а должен быть больше `APPROVE_TIMEOUT_SEC`.
- Дополнительно можно повесить `Notification` (например, `"matcher": "idle_prompt"`) на `send.mjs notify`.
- Порт по умолчанию 8787; если меняли `PORT`, задайте hook-ам переменную `TELEGRAM_MCP_PORT`.

## Настройки (.env)

| Переменная | По умолчанию | |
|---|---|---|
| `BOT_TOKEN` | — | токен бота |
| `ALLOWED_CHAT_ID` | — | ваш chat id (бот подскажет по `/start`) |
| `PORT` | 8787 | порт MCP и hooks, слушается только 127.0.0.1 |
| `ASK_TIMEOUT_SEC` | 240 | ожидание `ask` по умолчанию |
| `APPROVE_TIMEOUT_SEC` | 300 | ожидание кнопки для `PermissionRequest` |
| `TELEGRAM_API_ROOT` | — | свой Bot API сервер (необязательно) |

Состояние (открытые вопросы, входящие) хранится в памяти демона: после перезапуска старые кнопки отвечают «Запрос уже закрыт».

## Разработка

```sh
npm run dev        # tsx watch
npm run typecheck
npm test           # e2e: фейковый Bot API + демон + MCP-клиент + hook-скрипт
```
