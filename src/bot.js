import { TelegramError } from './telegram.js';
import { displayName } from './service.js';

const LIVE_FOREVER = 0x7fffffff; // Telegram's "until I turn it off"

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toId = (s) => (/^\d{1,16}$/.test(s) ? Number(s) : 0);
const short = (s, n = 24) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 15) return 'только что';
  if (s < 60) return `${s} сек назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

function duration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} ч ${m} мин`;
  return h ? `${h} ч` : `${m} мин`;
}

const describe = (loc) => `${ago(loc.updatedAt)}${loc.accuracy != null ? `, ±${Math.round(loc.accuracy)} м` : ''}`;

const HOW_TO_SHARE =
  '<b>Как включить трансляцию</b>\n' +
  '1. В этом чате нажмите 📎 → «Геопозиция».\n' +
  '2. Выберите «Транслировать мою геопозицию» → «Пока не отключу».\n\n' +
  'Чтобы точность была максимальной, разрешите Telegram в настройках телефона доступ к геопозиции ' +
  '«Всегда» и включите «Точную геопозицию».';

export function createBot({ tg, service, config, me }) {
  const mapUrl = config.publicUrl ? `${config.publicUrl}/` : null;
  const inviteLink = (user) => `https://t.me/${me.username}?start=${user.invite_code}`;

  const send = (chatId, text, extra = {}) =>
    tg.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });

  /** Send to someone who may have blocked the bot; returns null instead of throwing. */
  const trySend = async (chatId, text, extra) => {
    try {
      return await send(chatId, text, extra);
    } catch (err) {
      if (err instanceof TelegramError && (err.code === 403 || err.code === 400)) return null;
      throw err;
    }
  };

  const edit = async (chatId, messageId, text, keyboard) => {
    try {
      await tg.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard ?? [] },
      });
    } catch (err) {
      if (!(err instanceof TelegramError && err.code === 400)) throw err; // "message is not modified"
    }
  };

  const mainKeyboard = () => {
    const rows = [];
    if (mapUrl) rows.push([{ text: '🗺 Открыть карту', web_app: { url: mapUrl } }]);
    rows.push([
      { text: '👥 Пригласить друга', callback_data: 'invite' },
      { text: '📋 Друзья', callback_data: 'friends' },
    ]);
    return { inline_keyboard: rows };
  };

  // ---- views ---------------------------------------------------------------

  const sendWelcome = (user) =>
    send(
      user.id,
      `Привет, ${esc(user.first_name)}! Это <b>Локатор</b> — здесь друзья видят друг друга на карте.\n\n` +
        `${HOW_TO_SHARE}\n\n` +
        '<b>Дальше</b>\n' +
        '• /invite — пригласить друга\n' +
        `• ${mapUrl ? '/map — карта' : '/friends — где сейчас друзья'}\n` +
        '• /pause — скрыть свою геопозицию\n\n' +
        'Вас видят только те, кого вы сами добавили в друзья, и только пока вы этого хотите.',
      { reply_markup: mainKeyboard() },
    );

  const sendInvite = (user) => {
    const link = inviteLink(user);
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(
      'Давай видеть друг друга на карте в Локаторе',
    )}`;
    return send(
      user.id,
      `Отправьте другу эту ссылку:\n${link}\n\n` +
        'Друг откроет её и согласится, после этого вы подтвердите запрос — и начнёте видеть геопозицию друг друга.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📨 Отправить ссылку', url: shareUrl }],
            [{ text: '♻️ Сбросить ссылку', callback_data: 'invreset' }],
          ],
        },
      },
    );
  };

  const friendsView = (userId) => {
    const { friends } = service.stateFor(userId);
    if (!friends.length) {
      return {
        text: 'У вас пока нет друзей в Локаторе. Пригласите кого-нибудь — и вы увидите друг друга на карте.',
        keyboard: [[{ text: '👥 Пригласить друга', callback_data: 'invite' }]],
      };
    }
    const lines = friends.map((f) => {
      let status;
      if (f.hidden) status = 'скрывает геопозицию';
      else if (!f.location) status = 'ещё нет данных';
      else status = `${f.location.live ? '🟢 ' : ''}${describe(f.location)}`;
      return `• <b>${esc(f.name)}</b> — ${status}`;
    });
    const keyboard = friends.map((f) => [
      { text: `📍 ${short(f.name)}`, callback_data: `loc:${f.id}` },
      { text: '✖ Удалить', callback_data: `del:${f.id}` },
    ]);
    if (mapUrl) keyboard.push([{ text: '🗺 Открыть карту', web_app: { url: mapUrl } }]);
    return { text: `<b>Друзья</b>\n${lines.join('\n')}\n\n🟢 — трансляция идёт прямо сейчас.`, keyboard };
  };

  const sendFriends = (userId) => {
    const view = friendsView(userId);
    return send(userId, view.text, { reply_markup: { inline_keyboard: view.keyboard } });
  };

  // ---- invites -------------------------------------------------------------

  async function handleInviteLink(user, code) {
    const owner = service.getUserByInvite(code);
    if (!owner) return send(user.id, 'Эта ссылка-приглашение недействительна или устарела. Попросите друга прислать новую.');
    if (owner.id === user.id) return send(user.id, 'Это ваша собственная ссылка — отправьте её другу.');
    if (service.areFriends(user.id, owner.id)) {
      return send(user.id, `Вы уже видите друг друга с <b>${esc(displayName(owner))}</b>.`, { reply_markup: mainKeyboard() });
    }
    return send(
      user.id,
      `<b>${esc(displayName(owner))}</b> приглашает вас в Локатор.\n\n` +
        'Если согласитесь, вы будете видеть геопозицию друг друга на карте. ' +
        'Отключить это можно в любой момент — /pause или удалив друга.',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Согласиться', callback_data: `join:${code}` },
            { text: 'Отклонить', callback_data: 'nojoin' },
          ]],
        },
      },
    );
  }

  async function announceFriendship(a, b) {
    const text = (other) =>
      `✅ Готово: вы и <b>${esc(displayName(other))}</b> теперь видите геопозицию друг друга.\n\n` +
      'Не забудьте включить трансляцию — /share.';
    await trySend(a.id, text(b), { reply_markup: mainKeyboard() });
    await trySend(b.id, text(a), { reply_markup: mainKeyboard() });
  }

  // ---- locations -----------------------------------------------------------

  async function handleLocation(msg, edited, user) {
    // A venue is a place, and a forwarded location belongs to somebody else.
    if (msg.venue || msg.forward_origin || msg.forward_date) return;
    const loc = msg.location;
    const isLive = loc.live_period != null;
    const liveUntil = isLive ? (msg.date + loc.live_period) * 1000 : null;
    const ended = edited && (!isLive || liveUntil <= Date.now());

    const point = {
      lat: loc.latitude,
      lon: loc.longitude,
      accuracy: loc.horizontal_accuracy ?? null,
      heading: loc.heading ?? null,
      source: isLive || edited ? 'live' : 'once',
      at: (edited ? msg.edit_date ?? msg.date : msg.date) * 1000,
    };

    if (ended) {
      service.updateLocation(user.id, point);
      if (service.endLive(user.id, msg.message_id)) {
        await send(
          user.id,
          '⏹ Трансляция остановлена. Друзья видят вашу последнюю точку.\n\nСкрыть её совсем — /pause. Включить снова — /share.',
        );
      }
      return;
    }

    service.updateLocation(user.id, point, isLive ? { until: liveUntil, msgId: msg.message_id } : null);
    if (edited) return; // regular live update, nothing to say

    if (user.paused) {
      await send(
        user.id,
        '🙈 Вы сейчас скрыты, поэтому друзья вас не видят и геопозиция не сохраняется.\n\nЧтобы вас снова было видно — /resume.',
        { reply_markup: { remove_keyboard: true } },
      );
      return;
    }
    const tail = service.listFriends(user.id).length ? '' : '\n\nПока вас некому видеть — пригласите друзей: /invite.';

    if (isLive) {
      const howLong = loc.live_period >= LIVE_FOREVER ? 'пока вы её не отключите' : `ещё ${duration(loc.live_period)}`;
      await send(user.id, `✅ Трансляция включена — друзья видят вас в реальном времени, ${howLong}.${tail}`, {
        reply_markup: { remove_keyboard: true },
      });
    } else {
      await send(
        user.id,
        '📍 Точка сохранена — друзья увидят её как вашу последнюю геопозицию.\n\n' +
          'Чтобы они видели вас в реальном времени: 📎 → «Геопозиция» → «Транслировать мою геопозицию».' +
          tail,
        { reply_markup: { remove_keyboard: true } },
      );
    }
  }

  // ---- commands ------------------------------------------------------------

  async function handleCommand(user, command, arg) {
    switch (command) {
      case 'start':
        if (arg) return handleInviteLink(user, arg);
        return sendWelcome(user);
      case 'help':
        return sendWelcome(user);
      case 'invite':
        return sendInvite(user);
      case 'friends':
      case 'where':
        return sendFriends(user.id);
      case 'map':
        if (!mapUrl) return send(user.id, 'Карта пока не настроена. Посмотреть, где друзья, можно через /friends.');
        return send(user.id, 'Карта с друзьями:', {
          reply_markup: { inline_keyboard: [[{ text: '🗺 Открыть карту', web_app: { url: mapUrl } }]] },
        });
      case 'share':
        return send(user.id, `${HOW_TO_SHARE}\n\nИли отправьте только текущую точку кнопкой ниже.`, {
          reply_markup: {
            keyboard: [[{ text: '📍 Отправить мою точку сейчас', request_location: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        });
      case 'pause':
        service.setPaused(user.id, true);
        return send(
          user.id,
          '🙈 Вы скрыты: друзья не видят вашу геопозицию, и бот её не сохраняет.\n\nВернуться — /resume.',
        );
      case 'resume':
        service.setPaused(user.id, false);
        return send(
          user.id,
          '👀 Друзья снова видят вашу геопозицию. Точка обновится, как только Telegram пришлёт новую — или сразу, если открыть карту.',
        );
      case 'forget':
        return send(
          user.id,
          'Удалить все ваши данные из Локатора: профиль, список друзей и геопозицию? Это нельзя отменить.',
          {
            reply_markup: {
              inline_keyboard: [[
                { text: 'Да, удалить всё', callback_data: 'forgetok' },
                { text: 'Отмена', callback_data: 'cancel' },
              ]],
            },
          },
        );
      default:
        return send(user.id, 'Не знаю такой команды. Список команд — /help.');
    }
  }

  async function handleMessage(msg, edited) {
    if (msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return;
    // Only a message the person actually sends creates a profile: edits keep arriving
    // from a running live location even after /forget.
    const user = edited ? service.getUser(msg.from.id) : service.upsertUser(msg.from);
    if (!user) return;
    if (msg.location) return handleLocation(msg, edited, user);
    if (edited) return;

    const match = /^\/([a-z_]+)(?:@(\w+))?(?:\s+(\S+))?/i.exec(msg.text ?? '');
    if (match) {
      if (match[2] && match[2].toLowerCase() !== me.username.toLowerCase()) return;
      return handleCommand(user, match[1].toLowerCase(), match[3]);
    }
    return send(user.id, 'Чтобы друзья видели вас, отправьте сюда трансляцию геопозиции — как это сделать: /share. Все команды — /help.', {
      reply_markup: mainKeyboard(),
    });
  }

  // ---- buttons -------------------------------------------------------------

  async function handleCallback(cb) {
    const user = service.upsertUser(cb.from);
    const chatId = cb.message?.chat.id ?? user.id;
    const messageId = cb.message?.message_id;
    const sep = (cb.data ?? '').indexOf(':');
    const action = sep < 0 ? cb.data : cb.data.slice(0, sep);
    const arg = sep < 0 ? '' : cb.data.slice(sep + 1);
    const answer = { callback_query_id: cb.id };

    try {
      switch (action) {
        case 'invite':
          await sendInvite(user);
          break;

        case 'invreset': {
          service.resetInvite(user.id);
          await edit(chatId, messageId, 'Старая ссылка больше не работает.');
          await sendInvite(service.getUser(user.id));
          break;
        }

        case 'friends': {
          const view = friendsView(user.id);
          await edit(chatId, messageId, view.text, view.keyboard);
          break;
        }

        case 'join': {
          const owner = service.getUserByInvite(arg);
          if (!owner) {
            await edit(chatId, messageId, 'Эта ссылка-приглашение больше не действует. Попросите друга прислать новую.');
            break;
          }
          const result = service.requestFriendship(user.id, owner.id);
          const ownerName = esc(displayName(owner));
          if (result === 'friends') {
            await edit(chatId, messageId, `Вы приняли приглашение от <b>${ownerName}</b>.`);
            await announceFriendship(user, owner);
          } else if (result === 'requested') {
            const delivered = await trySend(
              owner.id,
              `<b>${esc(displayName(user))}</b>${user.username ? ` (@${esc(user.username)})` : ''} ` +
                'хочет обмениваться с вами геопозицией по вашей ссылке-приглашению.',
              {
                reply_markup: {
                  inline_keyboard: [[
                    { text: '✅ Принять', callback_data: `acc:${user.id}` },
                    { text: 'Отклонить', callback_data: `dec:${user.id}` },
                  ]],
                },
              },
            );
            await edit(
              chatId,
              messageId,
              delivered
                ? `Запрос отправлен. Как только <b>${ownerName}</b> его подтвердит, вы увидите друг друга на карте.\n\n` +
                  'А пока включите трансляцию геопозиции — /share.'
                : `Не получилось передать запрос — похоже, бот у <b>${ownerName}</b> остановлен.`,
            );
          } else if (result === 'already') {
            await edit(chatId, messageId, `Вы уже видите друг друга с <b>${ownerName}</b>.`);
          } else {
            await edit(chatId, messageId, 'Это ваша собственная ссылка — отправьте её другу.');
          }
          break;
        }

        case 'nojoin':
          await edit(chatId, messageId, 'Приглашение отклонено. Вашу геопозицию никто не видит.');
          break;

        case 'acc': {
          const other = service.getUser(toId(arg));
          if (other && service.acceptRequest(user.id, other.id)) {
            await edit(chatId, messageId, `Запрос от <b>${esc(displayName(other))}</b> принят.`);
            await announceFriendship(user, other);
          } else {
            await edit(chatId, messageId, 'Этот запрос уже неактуален.');
          }
          break;
        }

        case 'dec': {
          service.declineRequest(user.id, toId(arg));
          await edit(chatId, messageId, 'Запрос отклонён.');
          break;
        }

        case 'loc': {
          const friend = service.getUser(toId(arg));
          const loc = friend && service.visibleLocation(user.id, friend.id);
          if (!friend || !service.areFriends(user.id, friend.id)) {
            Object.assign(answer, { text: 'Вы больше не друзья.', show_alert: true });
          } else if (!loc) {
            const name = displayName(friend);
            const text = friend.paused ? `${name} скрывает геопозицию.` : `От ${name} пока нет данных о геопозиции.`;
            Object.assign(answer, { text, show_alert: true });
          } else {
            await tg.call('sendVenue', {
              chat_id: chatId,
              latitude: loc.lat,
              longitude: loc.lon,
              title: displayName(friend),
              address: `${loc.live ? '🟢 ' : ''}${describe(loc)}`,
            });
          }
          break;
        }

        case 'del': {
          const friend = service.getUser(toId(arg));
          if (!friend || !service.areFriends(user.id, friend.id)) {
            const view = friendsView(user.id);
            await edit(chatId, messageId, view.text, view.keyboard);
            break;
          }
          await edit(
            chatId,
            messageId,
            `Удалить <b>${esc(displayName(friend))}</b> из друзей? Вы перестанете видеть геопозицию друг друга.`,
            [[
              { text: 'Да, удалить', callback_data: `delok:${friend.id}` },
              { text: 'Отмена', callback_data: 'friends' },
            ]],
          );
          break;
        }

        case 'delok': {
          service.removeFriend(user.id, toId(arg));
          answer.text = 'Удалено';
          const view = friendsView(user.id);
          await edit(chatId, messageId, view.text, view.keyboard);
          break;
        }

        case 'forgetok':
          service.deleteUser(user.id);
          await edit(
            chatId,
            messageId,
            'Все ваши данные удалены. Если в Telegram ещё идёт трансляция геопозиции в этот чат — остановите её. ' +
              'Чтобы начать заново, отправьте /start.',
          );
          break;

        case 'cancel':
          await edit(chatId, messageId, 'Отменено.');
          break;
      }
    } finally {
      await tg.call('answerCallbackQuery', answer).catch(() => {});
    }
  }

  // ---- public --------------------------------------------------------------

  return {
    async handleUpdate(update) {
      if (update.message) return handleMessage(update.message, false);
      if (update.edited_message) return handleMessage(update.edited_message, true);
      if (update.callback_query) return handleCallback(update.callback_query);
    },

    /** Tell users whose live location ran out, so they can turn it back on. */
    async remindExpired() {
      for (const id of service.takeExpiredLives()) {
        await trySend(
          id,
          '⏱ Трансляция геопозиции закончилась — друзья видят только вашу последнюю точку.\n\n' +
            'Включить снова: 📎 → «Геопозиция» → «Транслировать мою геопозицию» → «Пока не отключу».',
        );
      }
    },

    /** One-time setup of the command list and the menu button. */
    async setup() {
      const commands = [
        ...(mapUrl ? [{ command: 'map', description: 'Карта с друзьями' }] : []),
        { command: 'friends', description: 'Где сейчас друзья' },
        { command: 'invite', description: 'Пригласить друга' },
        { command: 'share', description: 'Как включить трансляцию' },
        { command: 'pause', description: 'Скрыть мою геопозицию' },
        { command: 'resume', description: 'Снова показывать меня' },
        { command: 'forget', description: 'Удалить мои данные' },
        { command: 'help', description: 'Помощь' },
      ];
      await tg.call('setMyCommands', { commands });
      await tg.call('setChatMenuButton', {
        menu_button: mapUrl ? { type: 'web_app', text: 'Карта', web_app: { url: mapUrl } } : { type: 'commands' },
      });
    },
  };
}
