import http from 'node:http';
import { createHmac } from 'node:crypto';

/**
 * A stand-in for the Telegram Bot API, for tests: the bot under test polls it
 * for updates and every call the bot makes is recorded in `calls`.
 */
export class FakeTelegram {
  token = '123456:TEST-token_abcdefghijklmnopqrstuvwxyz';
  calls = [];
  #queue = [];
  #pollWaiters = [];
  #settleWaiters = [];
  #nextUpdateId = 1;
  #nextMessageId = 100;
  #server = null;

  async start() {
    this.#server = http.createServer((req, res) => this.#onRequest(req, res));
    await new Promise((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${this.#server.address().port}`;
  }

  async stop() {
    this.#pollWaiters.splice(0).forEach((wake) => wake());
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
  }

  async #onRequest(req, res) {
    const method = req.url.split('/').pop();
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = body ? JSON.parse(body) : {};
    const result = await this.#handle(method, params);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  }

  async #handle(method, params) {
    if (method === 'getUpdates') {
      // The bot acknowledges updates by asking for the next offset, i.e. after handling them.
      if (params.offset >= this.#nextUpdateId) this.#settleWaiters.splice(0).forEach((done) => done());
      if (!this.#queue.length) {
        await new Promise((resolve) => {
          this.#pollWaiters.push(resolve);
          setTimeout(resolve, 200);
        });
      }
      return this.#queue.splice(0);
    }
    this.calls.push({ method, params });
    if (method === 'getMe') return { id: 999, is_bot: true, first_name: 'Локатор', username: 'lctr_test_bot' };
    if (method === 'sendMessage' || method === 'sendVenue') {
      const message = { message_id: this.#nextMessageId++, chat: { id: params.chat_id, type: 'private' }, date: nowSec() };
      this.calls.at(-1).message = message;
      return message;
    }
    return true;
  }

  #push(update) {
    this.#queue.push({ update_id: this.#nextUpdateId++, ...update });
    this.#pollWaiters.splice(0).forEach((wake) => wake());
  }

  /** Resolves once the bot has handled everything pushed so far. */
  settle() {
    return new Promise((resolve) => this.#settleWaiters.push(resolve));
  }

  #message(user, fields) {
    return {
      message_id: this.#nextMessageId++,
      from: user,
      chat: { id: user.id, type: 'private' },
      date: nowSec(),
      ...fields,
    };
  }

  // ---- things a person does in the chat ------------------------------------

  async text(user, text) {
    this.#push({ message: this.#message(user, { text }) });
    await this.settle();
  }

  /** Send a location; pass `live_period` for a live one. Returns the message for later edits. */
  async location(user, location, extra = {}) {
    const message = this.#message(user, { location, ...extra });
    this.#push({ message });
    await this.settle();
    return message;
  }

  /** Telegram reports live location movement as edits of the original message. */
  async moveLive(message, location) {
    this.#push({ edited_message: { ...message, edit_date: nowSec(), location } });
    await this.settle();
  }

  /** Press an inline button of a message the bot sent. */
  async press(user, sent, data) {
    this.#push({ callback_query: { id: String(Date.now()), from: user, message: sent.message, data } });
    await this.settle();
  }

  // ---- what the bot did ------------------------------------------------------

  /** Messages the bot sent to a chat, oldest first. */
  sentTo(chatId, method = 'sendMessage') {
    return this.calls.filter((c) => c.method === method && c.params.chat_id === chatId);
  }

  lastSentTo(chatId) {
    return this.sentTo(chatId).at(-1);
  }

  /** The latest text of a message, taking edits into account. */
  textOf(sent) {
    const edits = this.calls.filter(
      (c) => c.method === 'editMessageText' && c.params.message_id === sent.message.message_id,
    );
    return (edits.at(-1) ?? sent).params.text;
  }

  /** Signed Mini App init data, as the Telegram client would pass it. */
  initData(user, authDate = nowSec()) {
    const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAtest', user: JSON.stringify(user) });
    const check = [...params.entries()].sort().map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(this.token).digest();
    params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
    return params.toString();
  }
}

export const buttons = (sent) => (sent.params.reply_markup?.inline_keyboard ?? []).flat();
export const button = (sent, prefix) => buttons(sent).find((b) => b.callback_data?.startsWith(prefix));

const nowSec = () => Math.floor(Date.now() / 1000);
