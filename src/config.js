import { existsSync } from 'node:fs';

export function loadConfig(env = process.env) {
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env');

  const botToken = (env.BOT_TOKEN || '').trim();
  if (!/^\d+:[\w-]{20,}$/.test(botToken)) {
    throw new Error('BOT_TOKEN не задан или выглядит неправильно. Получите токен у @BotFather и укажите его в .env');
  }

  let publicUrl = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (publicUrl && !/^https:\/\//.test(publicUrl)) {
    throw new Error('PUBLIC_URL должен начинаться с https:// — Telegram открывает Mini App только по HTTPS');
  }

  return {
    botToken,
    publicUrl: publicUrl || null,
    port: Number(env.PORT || 3000),
    dbPath: env.DB_PATH || './data/lctr.db',
    telegramApi: (env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, ''),
  };
}
