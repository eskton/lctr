import { openDb } from './db.js';
import { Service } from './service.js';
import { Telegram, pollUpdates } from './telegram.js';
import { createBot } from './bot.js';
import { createWeb } from './web.js';

const REMINDER_INTERVAL_MS = 30_000;

/** Wire the bot and the web server together. */
export async function createApp(config) {
  const db = openDb(config.dbPath);
  const service = new Service(db);
  const tg = new Telegram(config.botToken, config.telegramApi);
  const me = await tg.call('getMe');
  const bot = createBot({ tg, service, config, me });
  const web = createWeb({ service, config, me });
  const abort = new AbortController();
  let polling = null;
  let reminders = null;

  return {
    service,
    me,

    async start() {
      await tg.call('deleteWebhook'); // long polling does not work while a webhook is set
      await bot.setup();
      const port = await web.listen(config.port);
      polling = pollUpdates(tg, (update) => bot.handleUpdate(update), abort.signal);
      reminders = setInterval(() => {
        bot.remindExpired().catch((err) => console.error('[bot] reminder failed:', err.message));
      }, REMINDER_INTERVAL_MS);
      return port;
    },

    async stop() {
      clearInterval(reminders);
      abort.abort();
      await polling;
      await web.close();
      db.close();
    },

    /** Run the expiry check now instead of waiting for the timer. */
    remindExpired: () => bot.remindExpired(),
  };
}
