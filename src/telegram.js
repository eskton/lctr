import { setTimeout as sleep } from 'node:timers/promises';

export class TelegramError extends Error {
  constructor(method, code, description) {
    super(`Telegram ${method} failed: ${code} ${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.code = code;
    this.description = description;
  }
}

/** Minimal Bot API client. */
export class Telegram {
  #base;

  constructor(token, apiBase = 'https://api.telegram.org') {
    this.#base = `${apiBase}/bot${token}`;
  }

  async call(method, params = {}, { signal, timeoutMs = 20_000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (signal) signals.push(signal);
      const res = await fetch(`${this.#base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.any(signals),
      });
      const data = await res.json().catch(() => null);
      if (data?.ok) return data.result;

      const code = data?.error_code ?? res.status;
      const retryAfter = data?.parameters?.retry_after;
      if (code === 429 && retryAfter && attempt < 2) {
        await sleep((retryAfter + 0.5) * 1000, null, { signal });
        continue;
      }
      throw new TelegramError(method, code, data?.description ?? res.statusText);
    }
  }
}

/** Long-poll for updates until `signal` aborts. Updates are handled one at a time, in order. */
export async function pollUpdates(tg, onUpdate, signal) {
  let offset = 0;
  let backoff = 1000;
  while (!signal.aborted) {
    try {
      const updates = await tg.call(
        'getUpdates',
        { offset, timeout: 50, allowed_updates: ['message', 'edited_message', 'callback_query'] },
        { signal, timeoutMs: 65_000 },
      );
      backoff = 1000;
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await onUpdate(update);
        } catch (err) {
          console.error(`[bot] update ${update.update_id} failed:`, err.message);
        }
      }
    } catch (err) {
      if (signal.aborted) break;
      if (err instanceof TelegramError && err.code === 401) {
        console.error('[bot] Telegram отклонил токен (401). Проверьте BOT_TOKEN.');
      } else if (err instanceof TelegramError && err.code === 409) {
        console.error('[bot] Этот бот уже запущен где-то ещё (409). Остановите вторую копию.');
      } else {
        console.error('[bot] getUpdates failed:', err.message);
      }
      await sleep(backoff, null, { signal }).catch(() => {});
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
