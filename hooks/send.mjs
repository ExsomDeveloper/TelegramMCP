#!/usr/bin/env node
// Claude Code hook bridge: forwards the hook JSON (stdin) to the TelegramMCP daemon
// and prints its response (stdout). Usage: node send.mjs notify|approve
// If the daemon is down or anything fails, it exits 0 with no output, so Claude Code
// carries on with its normal behaviour (e.g. shows the permission dialog in the terminal).
// node:http is used instead of fetch: fetch gives up waiting for headers after 300s.
import { request } from 'node:http';

const endpoint = process.argv[2];
if (endpoint !== 'notify' && endpoint !== 'approve') process.exit(0);

const port = Number(process.env.TELEGRAM_MCP_PORT || 8787);

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const payload = Buffer.from(input || '{}', 'utf8');

const req = request(
  {
    host: '127.0.0.1',
    port,
    path: `/hook/${endpoint}`,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': payload.length },
  },
  (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      if (res.statusCode === 200 && endpoint === 'approve' && body && body !== '{}') process.stdout.write(body);
      process.exit(0);
    });
  },
);
req.on('error', () => process.exit(0)); // daemon not running — stay silent
req.end(payload);
