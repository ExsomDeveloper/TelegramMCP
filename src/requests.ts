import { randomBytes } from 'node:crypto';

export type RequestKind = 'ask' | 'approve';

export interface Answer {
  answer: string;
  by: 'button' | 'text';
  at: string;
}

export interface PendingRequest {
  id: string;
  kind: RequestKind;
  /** Telegram message that carries the question and its keyboard. */
  messageId: number;
  text: string;
  options: string[];
  createdAt: number;
  answer?: Answer;
  /** Set when nobody waits for the answer anymore (approve timed out / hook disconnected). */
  expired?: boolean;
  waiters: Set<(answer: Answer) => void>;
}

export interface InboxMessage {
  id: number;
  text: string;
  at: string;
}

/** Answered or expired requests are kept this long so check_reply can still read them. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

const requests = new Map<string, PendingRequest>();
const inbox: InboxMessage[] = [];
let inboxSeq = 0;

export function newRequestId(): string {
  return randomBytes(4).toString('hex');
}

export function addRequest(req: Omit<PendingRequest, 'createdAt' | 'waiters'>): PendingRequest {
  const full: PendingRequest = { ...req, createdAt: Date.now(), waiters: new Set() };
  requests.set(full.id, full);
  return full;
}

export function getRequest(id: string): PendingRequest | undefined {
  return requests.get(id);
}

export function findByMessageId(messageId: number): PendingRequest | undefined {
  for (const req of requests.values()) if (req.messageId === messageId) return req;
  return undefined;
}

/** Most recent unanswered ask — target for free text sent without "reply". */
export function latestOpenAsk(): PendingRequest | undefined {
  let latest: PendingRequest | undefined;
  for (const req of requests.values()) {
    if (req.kind !== 'ask' || req.answer || req.expired) continue;
    if (!latest || req.createdAt > latest.createdAt) latest = req;
  }
  return latest;
}

/** First answer wins. Returns false if the request is unknown, already answered or expired. */
export function resolveRequest(id: string, answer: Omit<Answer, 'at'>): boolean {
  const req = requests.get(id);
  if (!req || req.answer || req.expired) return false;
  req.answer = { ...answer, at: new Date().toISOString() };
  for (const waiter of req.waiters) waiter(req.answer);
  req.waiters.clear();
  return true;
}

export function expireRequest(id: string): void {
  const req = requests.get(id);
  if (req && !req.answer) req.expired = true;
}

/** Resolves with the answer, or undefined on timeout / abort. */
export function waitForAnswer(id: string, timeoutMs: number, signal?: AbortSignal): Promise<Answer | undefined> {
  const req = requests.get(id);
  if (!req) return Promise.resolve(undefined);
  if (req.answer) return Promise.resolve(req.answer);

  return new Promise((resolve) => {
    const done = (answer: Answer | undefined) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      req.waiters.delete(waiter);
      resolve(answer);
    };
    const waiter = (answer: Answer) => done(answer);
    const onAbort = () => done(undefined);
    const timer = setTimeout(() => done(undefined), timeoutMs);
    req.waiters.add(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function pushInbox(text: string): InboxMessage {
  const msg = { id: ++inboxSeq, text, at: new Date().toISOString() };
  inbox.push(msg);
  return msg;
}

/** Returns messages with id > sinceId, or (without sinceId) all unread ones and marks them read. */
let readUpTo = 0;
export function readInbox(sinceId?: number): InboxMessage[] {
  const from = sinceId ?? readUpTo;
  const result = inbox.filter((m) => m.id > from);
  if (result.length) readUpTo = Math.max(readUpTo, result[result.length - 1].id);
  return result;
}

setInterval(() => {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, req] of requests) if (req.createdAt < cutoff && req.waiters.size === 0) requests.delete(id);
  while (inbox.length && Date.parse(inbox[0].at) < cutoff) inbox.shift();
}, 60 * 60 * 1000).unref();
