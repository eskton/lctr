import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../src/app.js';
import { FakeTelegram, button } from './fake-telegram.js';

const alice = { id: 1001, is_bot: false, first_name: 'Алиса', username: 'alice' };
const bob = { id: 1002, is_bot: false, first_name: 'Борис', last_name: 'Б.' };
const carol = { id: 1003, is_bot: false, first_name: 'Карина' };

async function setup(t) {
  const fake = new FakeTelegram();
  await fake.start();
  const app = await createApp({
    botToken: fake.token,
    publicUrl: 'https://map.example.test',
    port: 0,
    dbPath: ':memory:',
    telegramApi: fake.url,
  });
  const port = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const streams = [];
  t.after(async () => {
    streams.forEach((s) => s.close());
    await app.stop();
    await fake.stop();
  });

  const login = async (user) => {
    const res = await fetch(`${base}/api/auth`, { method: 'POST', body: JSON.stringify({ initData: fake.initData(user) }) });
    assert.equal(res.status, 200);
    return (await res.json()).token;
  };
  const call = async (token, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}` },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const state = async (token) => (await call(token, '/api/state')).body;

  /** Listen to the live event stream the map uses. */
  const listen = async (token) => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream?token=${token}`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    const events = [];
    (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let i; (i = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(i + 2)) {
          const raw = buffer.slice(0, i);
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          if (event) events.push({ event, data: JSON.parse(/^data: (.+)$/m.exec(raw)[1]) });
        }
      }
    })().catch(() => {});
    const stream = {
      events,
      close: () => ctrl.abort(),
      async waitFor(predicate) {
        for (let i = 0; i < 100; i++) {
          const found = events.find(predicate);
          if (found) return found;
          await sleep(20);
        }
        assert.fail(`no matching event; got ${JSON.stringify(events)}`);
      },
    };
    streams.push(stream);
    return stream;
  };

  /** Alice invites, Bob agrees, Alice confirms. */
  const befriend = async (owner, guest) => {
    await fake.text(owner, '/invite');
    const link = /https:\/\/t\.me\/lctr_test_bot\?start=([\w-]+)/.exec(fake.lastSentTo(owner.id).params.text);
    await fake.text(guest, `/start ${link[1]}`);
    const offer = fake.lastSentTo(guest.id);
    await fake.press(guest, offer, button(offer, 'join:').callback_data);
    const request = fake.lastSentTo(owner.id);
    await fake.press(owner, request, button(request, 'acc:').callback_data);
    return { code: link[1], offer, request };
  };

  return { fake, app, base, login, call, state, listen, befriend };
}

test('welcome explains how to share and offers the map', async (t) => {
  const { fake } = await setup(t);
  await fake.text(alice, '/start');
  const welcome = fake.lastSentTo(alice.id);
  assert.match(welcome.params.text, /Локатор/);
  assert.match(welcome.params.text, /Транслировать мою геопозицию/);
  const [mapButton] = welcome.params.reply_markup.inline_keyboard[0];
  assert.equal(mapButton.web_app.url, 'https://map.example.test/');
  const menu = fake.calls.find((c) => c.method === 'setChatMenuButton');
  assert.equal(menu.params.menu_button.web_app.url, 'https://map.example.test/');
});

test('friendship needs both people to agree', async (t) => {
  const { fake, login, state } = await setup(t);
  await fake.text(alice, '/start');
  await fake.text(alice, '/invite');
  const code = /start=([\w-]+)/.exec(fake.lastSentTo(alice.id).params.text)[1];

  // Bob opens the link: nothing is shared until he agrees…
  await fake.text(bob, `/start ${code}`);
  const offer = fake.lastSentTo(bob.id);
  assert.match(offer.params.text, /Алиса/);
  const aliceToken = await login(alice);
  const bobToken = await login(bob);
  assert.equal((await state(aliceToken)).friends.length, 0);

  // …and after he agrees Alice still has to confirm.
  await fake.press(bob, offer, button(offer, 'join:').callback_data);
  assert.match(fake.textOf(offer), /Запрос отправлен/);
  const request = fake.lastSentTo(alice.id);
  assert.match(request.params.text, /Борис Б\./);
  assert.equal((await state(aliceToken)).friends.length, 0);
  assert.equal((await state(bobToken)).friends.length, 0);

  await fake.press(alice, request, button(request, 'acc:').callback_data);
  assert.match(fake.lastSentTo(alice.id).params.text, /Борис Б\./);
  assert.match(fake.lastSentTo(bob.id).params.text, /Алиса/);
  assert.deepEqual((await state(aliceToken)).friends.map((f) => f.name), ['Борис Б.']);
  assert.deepEqual((await state(bobToken)).friends.map((f) => f.name), ['Алиса']);
});

test('a declined request shares nothing, and a button for someone who never asked does nothing', async (t) => {
  const { fake, login, state } = await setup(t);
  await fake.text(alice, '/invite');
  const code = /start=([\w-]+)/.exec(fake.lastSentTo(alice.id).params.text)[1];
  await fake.text(bob, `/start ${code}`);
  const offer = fake.lastSentTo(bob.id);
  await fake.press(bob, offer, button(offer, 'join:').callback_data);
  const request = fake.lastSentTo(alice.id);
  await fake.press(alice, request, button(request, 'dec:').callback_data);
  assert.match(fake.textOf(request), /отклонён/);

  // Carol never opened a link; a forged "accept" for her must not create a friendship.
  await fake.text(carol, '/start');
  await fake.press(alice, request, `acc:${carol.id}`);
  await fake.press(alice, request, `acc:${bob.id}`);
  assert.equal((await state(await login(alice))).friends.length, 0);
});

test('live location reaches friends in real time and nobody else', async (t) => {
  const { fake, login, state, listen, befriend } = await setup(t);
  await befriend(alice, bob);
  await fake.text(carol, '/start');
  const aliceToken = await login(alice);
  const carolToken = await login(carol);
  const aliceStream = await listen(aliceToken);
  const carolStream = await listen(carolToken);

  const live = await fake.location(bob, {
    latitude: 55.7512,
    longitude: 37.6184,
    horizontal_accuracy: 12,
    live_period: 3600,
  });
  assert.match(fake.lastSentTo(bob.id).params.text, /Трансляция включена.*ещё 1 ч/s);

  let seen = (await state(aliceToken)).friends[0];
  assert.equal(seen.location.lat, 55.7512);
  assert.equal(seen.location.accuracy, 12);
  assert.equal(seen.location.live, true);
  assert.equal(seen.location.source, 'live');

  // Bob walks: Telegram edits the live message, the bot stays silent and the map gets an event.
  const messagesToBob = fake.sentTo(bob.id).length;
  await fake.moveLive(live, { latitude: 55.752, longitude: 37.619, horizontal_accuracy: 8, heading: 90, live_period: 3600 });
  assert.equal(fake.sentTo(bob.id).length, messagesToBob);
  const event = await aliceStream.waitFor((e) => e.event === 'loc' && e.data.location.lat === 55.752);
  assert.equal(event.data.id, bob.id);
  assert.equal(event.data.location.heading, 90);
  seen = (await state(aliceToken)).friends[0];
  assert.equal(seen.location.lon, 37.619);

  // Carol is not Bob's friend: no data, no events.
  assert.equal((await state(carolToken)).friends.length, 0);
  await sleep(50);
  assert.equal(carolStream.events.length, 0);

  // Bob turns the live location off.
  await fake.moveLive(live, { latitude: 55.753, longitude: 37.62 });
  assert.match(fake.lastSentTo(bob.id).params.text, /Трансляция остановлена/);
  seen = (await state(aliceToken)).friends[0];
  assert.equal(seen.location.lat, 55.753);
  assert.equal(seen.location.live, false);
});

test('indefinite live location is described as such', async (t) => {
  const { fake } = await setup(t);
  await fake.text(bob, '/start');
  await fake.location(bob, { latitude: 1, longitude: 2, live_period: 0x7fffffff });
  assert.match(fake.lastSentTo(bob.id).params.text, /пока вы её не отключите/);
});

test('pausing hides the location and stops recording it', async (t) => {
  const { fake, login, state, listen, befriend } = await setup(t);
  await befriend(alice, bob);
  const aliceToken = await login(alice);
  const live = await fake.location(bob, { latitude: 10, longitude: 20, live_period: 3600 });
  const stream = await listen(aliceToken);

  await fake.text(bob, '/pause');
  await stream.waitFor((e) => e.event === 'refresh');
  let seen = (await state(aliceToken)).friends[0];
  assert.equal(seen.hidden, true);
  assert.equal(seen.location, null);

  // Movement while hidden is not sent to friends and not stored.
  await fake.moveLive(live, { latitude: 11, longitude: 21, live_period: 3600 });
  assert.equal(stream.events.filter((e) => e.event === 'loc').length, 0);
  const alicesFriends = fake.sentTo(alice.id).length;
  await fake.text(alice, '/friends');
  assert.match(fake.sentTo(alice.id)[alicesFriends].params.text, /скрывает геопозицию/);

  // Starting a live location while hidden says so instead of claiming friends can see it.
  await fake.location(bob, { latitude: 50, longitude: 50, live_period: 3600 });
  assert.match(fake.lastSentTo(bob.id).params.text, /Вы сейчас скрыты/);

  await fake.text(bob, '/resume');
  seen = (await state(aliceToken)).friends[0];
  assert.equal(seen.hidden, false);
  assert.equal(seen.location.lat, 10);

  await fake.moveLive(live, { latitude: 12, longitude: 22, live_period: 3600 });
  assert.equal((await state(aliceToken)).friends[0].location.lat, 12);
});

test('the map can send its own precise GPS fixes', async (t) => {
  const { login, call, state, befriend } = await setup(t);
  await befriend(alice, bob);
  const aliceToken = await login(alice);
  const bobToken = await login(bob);

  const ok = await call(aliceToken, '/api/location', { lat: 59.9386, lon: 30.3141, accuracy: 4.2, heading: 181, speed: 1.4 });
  assert.deepEqual(ok, { status: 200, body: { stored: true } });
  const seen = (await state(bobToken)).friends[0].location;
  assert.deepEqual(
    { lat: seen.lat, lon: seen.lon, accuracy: seen.accuracy, heading: seen.heading, speed: seen.speed, source: seen.source },
    { lat: 59.9386, lon: 30.3141, accuracy: 4.2, heading: 181, speed: 1.4, source: 'app' },
  );

  assert.equal((await call(aliceToken, '/api/location', { lat: 91, lon: 0 })).status, 400);
  assert.equal((await call(aliceToken, '/api/location', { lat: '59', lon: 30 })).status, 400);

  // Hidden from the map as well: the fix is not stored.
  await call(aliceToken, '/api/pause', { paused: true });
  await sleep(550);
  assert.deepEqual((await call(aliceToken, '/api/location', { lat: 1, lon: 1 })).body, { stored: false });
  assert.equal((await state(bobToken)).friends[0].location, null);
});

test('the API rejects forged or missing credentials', async (t) => {
  const { fake, base } = await setup(t);
  const post = (initData) => fetch(`${base}/api/auth`, { method: 'POST', body: JSON.stringify({ initData }) });

  const good = fake.initData(alice);
  assert.equal((await post(good)).status, 200);
  assert.equal((await post(good.replace('%D0%90', '%D0%91'))).status, 401); // name changed after signing
  assert.equal((await post(fake.initData(alice, Math.floor(Date.now() / 1000) - 2 * 86400))).status, 401); // stale
  assert.equal((await post('')).status, 401);

  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { authorization: 'Bearer 1001.99999999999999.AAAA' } })).status, 401);
  assert.equal((await fetch(`${base}/api/stream?token=nope`)).status, 401);
});

test('removing a friend ends sharing both ways', async (t) => {
  const { fake, login, state, befriend } = await setup(t);
  await befriend(alice, bob);
  await fake.location(bob, { latitude: 10, longitude: 20, live_period: 3600 });
  const aliceToken = await login(alice);
  const bobToken = await login(bob);

  await fake.text(alice, '/friends');
  const list = fake.lastSentTo(alice.id);
  assert.match(list.params.text, /Борис Б\.<\/b> — 🟢 только что/);

  await fake.press(alice, list, button(list, 'loc:').callback_data);
  const venue = fake.sentTo(alice.id, 'sendVenue').at(-1);
  assert.equal(venue.params.latitude, 10);
  assert.equal(venue.params.title, 'Борис Б.');

  await fake.press(alice, list, button(list, 'del:').callback_data);
  await fake.press(alice, list, `delok:${bob.id}`);
  assert.equal((await state(aliceToken)).friends.length, 0);
  assert.equal((await state(bobToken)).friends.length, 0);

  // The old "show location" button no longer reveals anything.
  const venues = fake.sentTo(alice.id, 'sendVenue').length;
  await fake.press(alice, list, `loc:${bob.id}`);
  assert.equal(fake.sentTo(alice.id, 'sendVenue').length, venues);
});

test('resetting the invite link kills the old one', async (t) => {
  const { fake } = await setup(t);
  await fake.text(alice, '/invite');
  const invite = fake.lastSentTo(alice.id);
  const oldCode = /start=([\w-]+)/.exec(invite.params.text)[1];
  await fake.press(alice, invite, 'invreset');
  const newCode = /start=([\w-]+)/.exec(fake.lastSentTo(alice.id).params.text)[1];
  assert.notEqual(newCode, oldCode);

  await fake.text(bob, `/start ${oldCode}`);
  assert.match(fake.lastSentTo(bob.id).params.text, /недействительна/);
  await fake.text(bob, `/start ${newCode}`);
  assert.match(fake.lastSentTo(bob.id).params.text, /приглашает вас/);
});

test('places and forwarded locations are not taken as the sender\'s position', async (t) => {
  const { fake, login, state } = await setup(t);
  await fake.text(bob, '/start');
  await fake.location(bob, { latitude: 1, longitude: 1 }, { venue: { title: 'Кафе', address: 'ул. Ленина' } });
  await fake.location(bob, { latitude: 2, longitude: 2 }, { forward_origin: { type: 'user' } });
  assert.equal((await state(await login(bob))).me.location, null);

  await fake.location(bob, { latitude: 3, longitude: 3 });
  assert.match(fake.lastSentTo(bob.id).params.text, /Точка сохранена/);
  const mine = (await state(await login(bob))).me.location;
  assert.equal(mine.lat, 3);
  assert.equal(mine.source, 'once');
  assert.equal(mine.live, false);
});

test('an expired live location triggers one reminder', async (t) => {
  const { fake, app, login, state, befriend } = await setup(t);
  await befriend(alice, bob);
  await fake.location(bob, { latitude: 5, longitude: 6, live_period: 1 });
  const aliceToken = await login(alice);
  assert.equal((await state(aliceToken)).friends[0].location.live, true);

  await sleep(1100);
  await app.remindExpired();
  assert.match(fake.lastSentTo(bob.id).params.text, /Трансляция геопозиции закончилась/);
  assert.equal((await state(aliceToken)).friends[0].location.live, false);

  const count = fake.sentTo(bob.id).length;
  await app.remindExpired();
  assert.equal(fake.sentTo(bob.id).length, count);
});

test('/forget deletes everything and a still-running live location does not bring it back', async (t) => {
  const { fake, app, login, state, befriend } = await setup(t);
  await befriend(alice, bob);
  const live = await fake.location(bob, { latitude: 5, longitude: 6, live_period: 3600 });
  const aliceToken = await login(alice);

  await fake.text(bob, '/forget');
  const confirm = fake.lastSentTo(bob.id);
  await fake.press(bob, confirm, button(confirm, 'forgetok').callback_data);
  assert.match(fake.textOf(confirm), /данные удалены/);
  assert.equal(app.service.getUser(bob.id), null);
  assert.equal((await state(aliceToken)).friends.length, 0);

  await fake.moveLive(live, { latitude: 7, longitude: 8, live_period: 3600 });
  assert.equal(app.service.getUser(bob.id), null);
});

test('static files are served and paths cannot escape the public folder', async (t) => {
  const { base } = await setup(t);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${base}/vendor/leaflet/leaflet.js`)).status, 200);
  assert.equal((await fetch(`${base}/..%2Fsrc%2Fapp.js`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});
