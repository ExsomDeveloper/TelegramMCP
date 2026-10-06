import express from 'express';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { bot } from './bot.js';
import { config } from './config.js';
import { hooksRouter } from './hooks.js';
import { createMcpServer } from './mcp.js';

const HOST = '127.0.0.1';

const app = express();
// DNS rebinding protection; the daemon only listens on localhost.
app.use(localhostHostValidation());
// Hook payloads include full tool input (e.g. Write content), so allow more than the 100kb default.
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, chatConfigured: config.allowedChatId !== undefined });
});

// Stateless Streamable HTTP: a fresh server + transport per request, shared state lives in requests.ts.
app.post('/mcp', async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.all('/mcp', (_req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});

app.use('/hook', hooksRouter);

const httpServer = app.listen(config.port, HOST, () => {
  console.log(`[http] MCP:   http://${HOST}:${config.port}/mcp`);
  console.log(`[http] Hooks: http://${HOST}:${config.port}/hook/{notify,approve}`);
});
// /hook/approve and ask hold requests open for minutes.
httpServer.requestTimeout = 0;
httpServer.headersTimeout = 0;

if (config.allowedChatId === undefined) {
  console.warn('[bot] ALLOWED_CHAT_ID is not set — send /start to the bot to learn your chat id.');
}

bot.start({
  drop_pending_updates: true,
  onStart: (me) => console.log(`[bot] polling as @${me.username}`),
}).catch((err) => {
  console.error('[bot] polling stopped:', err);
  process.exit(1);
});

function shutdown() {
  bot.stop().finally(() => httpServer.close(() => process.exit(0)));
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
