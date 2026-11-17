import { loadConfig } from './config.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const app = await createApp(config).catch((err) => {
  console.error(`Не удалось подключиться к Telegram: ${err.message}`);
  process.exit(1);
});

const port = await app.start();
console.log(`Бот @${app.me.username} запущен.`);
console.log(`Веб-сервер слушает порт ${port}.`);
console.log(
  config.publicUrl
    ? `Карта: ${config.publicUrl}/`
    : 'PUBLIC_URL не задан — бот работает без карты (только команды).',
);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    process.exit(0);
  });
}
