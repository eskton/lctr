(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;
  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const STALE_MS = 10 * 60 * 1000; // older points are drawn greyed out
  const POST_INTERVAL_MS = 2000; // how often the map sends its own GPS fix
  const FOLLOW_ZOOM = 16;
  const COLORS = ['#e17076', '#eda86c', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae'];
  const SHARE_TEXT = 'Давай видеть друг друга на карте в Локаторе';

  const els = {
    status: $('status'),
    statusText: $('status-text'),
    sheet: $('sheet'),
    count: $('count'),
    hint: $('hint'),
    empty: $('empty'),
    list: $('friends'),
    shareToggle: $('share-toggle'),
    shareNote: $('share-note'),
    btnMe: $('btn-me'),
    toast: $('toast'),
  };

  const state = {
    token: null,
    me: null,
    friends: new Map(),
    inviteLink: null,
    skew: 0, // server clock minus device clock
    fix: null, // latest GPS fix taken by this page
    gps: 'starting', // 'starting' | 'ok' | 'denied' | 'unavailable'
    selected: null, // friend id
    follow: null, // friend id | 'me' | null — whom the map keeps in view
    fitted: false,
  };

  let map;
  const markers = new Map(); // 'me' | friend id -> marker parts
  const rows = new Map(); // friend id -> list row parts

  const now = () => Date.now() + state.skew;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  // ---- formatting ----------------------------------------------------------

  function ago(ts) {
    const s = Math.max(0, Math.round((now() - ts) / 1000));
    if (s < 10) return 'только что';
    if (s < 60) return `${s} сек назад`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} мин назад`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ч назад`;
    return `${Math.round(h / 24)} дн назад`;
  }

  function formatDistance(m) {
    if (m < 1000) return `${Math.round(m)} м`;
    const km = m / 1000;
    return `${km < 100 ? km.toFixed(1).replace('.', ',') : Math.round(km)} км`;
  }

  function describe(friend) {
    if (friend.hidden) return 'скрывает геопозицию';
    const loc = friend.location;
    if (!loc) return 'пока не делится геопозицией';
    const parts = [ago(loc.updatedAt)];
    if (loc.accuracy != null) parts.push(`±${Math.max(1, Math.round(loc.accuracy))} м`);
    if (loc.speed != null && loc.speed > 0.5 && now() - loc.updatedAt < 60000) parts.push(`${Math.round(loc.speed * 3.6)} км/ч`);
    return parts.join(' · ');
  }

  const initials = (name) =>
    name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0].toUpperCase()).join('');

  function avatar(user, className) {
    const node = el('div', className, initials(user.name));
    node.style.background = COLORS[Math.abs(user.id) % COLORS.length];
    if (user.photoUrl && /^https:\/\//.test(user.photoUrl)) {
      const img = new Image();
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => node.replaceChildren(img);
      img.src = user.photoUrl;
    }
    return node;
  }

  let toastTimer;
  function toast(text) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), 3000);
  }

  function fatal(text) {
    $('overlay-text').textContent = text;
    $('overlay').hidden = false;
  }

  // ---- server --------------------------------------------------------------

  async function auth() {
    const res = await fetch('api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData }),
    });
    if (!res.ok) throw new Error(`auth ${res.status}`);
    state.token = (await res.json()).token;
  }

  async function api(path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        await auth(); // the session ran out; sign in again and retry once
        continue;
      }
      if (!res.ok) throw new Error(`${path} ${res.status}`);
      return res.json();
    }
  }

  function applyState(data) {
    state.skew = data.serverTime - Date.now();
    state.me = data.me;
    state.inviteLink = data.inviteLink;
    state.friends = new Map(data.friends.map((f) => [f.id, f]));
    if (state.selected != null && !state.friends.has(state.selected)) state.selected = null;
    if (typeof state.follow === 'number' && !(state.friends.get(state.follow) || {}).location) state.follow = null;
    render();
    if (!state.fitted) state.fitted = fitAll(false);
  }

  let refreshing = null;
  function refresh() {
    if (!refreshing) {
      refreshing = api('api/state')
        .then(applyState)
        .catch(() => {})
        .finally(() => (refreshing = null));
    }
    return refreshing;
  }

  /** Live updates: friends' movement arrives here without polling. */
  function connect() {
    const source = new EventSource(`api/stream?token=${encodeURIComponent(state.token)}`);
    let wasOpen = false;
    source.onopen = () => {
      if (wasOpen) refresh(); // reconnected: catch up on what was missed
      wasOpen = true;
    };
    source.addEventListener('loc', (event) => {
      const { id, location } = JSON.parse(event.data);
      if (state.me && id === state.me.id) {
        state.me.location = location;
      } else {
        const friend = state.friends.get(id);
        if (!friend) return void refresh();
        friend.location = location;
        friend.hidden = false;
      }
      scheduleRender();
      if (!state.fitted) state.fitted = fitAll(false);
      if (state.follow === id) focus(location);
      else if (state.follow === 'me' && id === state.me.id) focus(myLocation());
    });
    source.addEventListener('refresh', refresh);
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) return; // the browser retries by itself
      setTimeout(async () => {
        try {
          await auth();
        } catch {
          /* offline; connect() below fails again and we come back here */
        }
        connect();
        refresh();
      }, 3000);
    };
  }

  // ---- own position --------------------------------------------------------

  /** The best known own position: this page's GPS fix, or what the server has (Telegram live location). */
  function myLocation() {
    const server = state.me && state.me.location;
    const fix = state.fix;
    if (fix && (!server || fix.updatedAt >= server.updatedAt - 1000)) return { ...fix, live: !!(server && server.live) };
    return server;
  }

  let lastPost = 0;
  let postTimer = null;
  function queuePost() {
    if (postTimer || !state.me || state.me.paused) return;
    postTimer = setTimeout(async () => {
      postTimer = null;
      const fix = state.fix;
      if (!fix || state.me.paused) return;
      lastPost = Date.now();
      try {
        await api('api/location', {
          lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, heading: fix.heading, speed: fix.speed, altitude: fix.altitude,
        });
      } catch {
        /* a missed fix is replaced by the next one */
      }
    }, Math.max(0, POST_INTERVAL_MS - (Date.now() - lastPost)));
  }

  function onFix(fix) {
    state.gps = 'ok';
    state.fix = { ...fix, source: 'app', updatedAt: now() };
    scheduleRender();
    if (!state.fitted) state.fitted = fitAll(false);
    if (state.follow === 'me') focus(fix);
    queuePost();
  }

  function gpsFailed(reason) {
    if (state.gps !== 'ok') state.gps = reason;
    scheduleRender();
  }

  /** High-accuracy GPS while the map is open. */
  function startGps() {
    if (!navigator.geolocation) return startTelegramLocation('unavailable');
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        onFix({
          lat: c.latitude, lon: c.longitude,
          accuracy: num(c.accuracy), heading: num(c.heading), speed: num(c.speed), altitude: num(c.altitude),
        });
      },
      (err) => {
        if (state.gps === 'ok' && err.code !== err.PERMISSION_DENIED) return; // a temporary loss of signal
        navigator.geolocation.clearWatch(watchId);
        startTelegramLocation(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  /** Fallback for Telegram clients whose web view has no geolocation of its own. */
  function startTelegramLocation(reason) {
    const manager = tg.LocationManager;
    if (!manager || typeof manager.init !== 'function') return gpsFailed(reason);
    manager.init(() => {
      if (!manager.isLocationAvailable) return gpsFailed(reason);
      const poll = () =>
        manager.getLocation((data) => {
          if (data) {
            onFix({
              lat: data.latitude, lon: data.longitude,
              accuracy: num(data.horizontal_accuracy), heading: num(data.course), speed: num(data.speed), altitude: num(data.altitude),
            });
            setTimeout(poll, 3000);
          } else if (manager.isAccessRequested && !manager.isAccessGranted) {
            gpsFailed('denied');
          } else {
            setTimeout(poll, 10000);
          }
        });
      poll();
    });
  }

  // ---- map -----------------------------------------------------------------

  const sheetHeight = () => els.sheet.getBoundingClientRect().height;

  function initMap() {
    map = L.map('map', { zoomControl: false, attributionControl: false, worldCopyJump: true }).setView([55.75, 37.62], 4);
    L.control.attribution({ prefix: false, position: 'topright' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.on('dragstart', () => {
      state.follow = null;
      scheduleRender();
    });
    map.on('click', () => {
      state.selected = null;
      scheduleRender();
    });
  }

  /** Centre the map on a point, in the part of the screen the bottom sheet does not cover. */
  function focus(loc, zoom) {
    const z = zoom || map.getZoom();
    const point = map.project([loc.lat, loc.lon], z).add([0, sheetHeight() / 2]);
    map.setView(map.unproject(point, z), z, { animate: true });
  }

  function fitAll(animate) {
    const points = [];
    const me = myLocation();
    if (me) points.push([me.lat, me.lon]);
    for (const f of state.friends.values()) if (f.location) points.push([f.location.lat, f.location.lon]);
    if (!points.length) return false;
    state.follow = null;
    map.fitBounds(L.latLngBounds(points), {
      paddingTopLeft: [50, 70],
      paddingBottomRight: [50, sheetHeight() + 50],
      maxZoom: FOLLOW_ZOOM,
      animate,
    });
    return true;
  }

  /** Glide a marker to its new position instead of jumping. */
  function moveMarker(m, to) {
    const from = m.marker.getLatLng();
    cancelAnimationFrame(m.raf);
    if (from.equals(to)) return;
    if (document.hidden || from.distanceTo(to) > 2000) {
      m.marker.setLatLng(to);
      m.circle.setLatLng(to);
      return;
    }
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / 700);
      const pos = L.latLng(from.lat + (to.lat - from.lat) * k, from.lng + (to.lng - from.lng) * k);
      m.marker.setLatLng(pos);
      m.circle.setLatLng(pos);
      if (k < 1) m.raf = requestAnimationFrame(step);
    };
    m.raf = requestAnimationFrame(step);
  }

  function syncMarker(key, user, loc) {
    const isMe = key === 'me';
    const latlng = L.latLng(loc.lat, loc.lon);
    let m = markers.get(key);
    if (!m) {
      const root = el('div', isMe ? 'me' : 'pin');
      const arrow = el('div', 'arrow');
      const label = isMe ? null : el('div', 'pin-name');
      root.append(arrow, isMe ? el('div', 'me-core') : avatar(user, 'pin-avatar'));
      if (label) root.append(label);
      const size = isMe ? 22 : 44;
      const circle = L.circle(latlng, {
        radius: 0, weight: 1, opacity: 0.45, fillOpacity: 0.1, interactive: false,
        color: isMe ? '#2a8bf2' : '#6b7480',
      }).addTo(map);
      const marker = L.marker(latlng, {
        icon: L.divIcon({ className: '', html: root, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        zIndexOffset: isMe ? 0 : 500,
        keyboard: false,
        interactive: !isMe,
      }).addTo(map);
      if (!isMe) {
        marker.on('click', (event) => {
          L.DomEvent.stopPropagation(event);
          select(key);
        });
      }
      m = { marker, circle, root, arrow, label, raf: 0 };
      markers.set(key, m);
    } else {
      moveMarker(m, latlng);
    }

    const age = now() - loc.updatedAt;
    m.circle.setRadius(loc.accuracy || 0);
    m.arrow.hidden = loc.heading == null || age > 60000;
    if (loc.heading != null) m.arrow.style.transform = `rotate(${loc.heading}deg)`;
    if (isMe) {
      m.root.classList.toggle('off', state.me.paused);
    } else {
      m.label.textContent = user.name.split(/\s+/)[0];
      m.root.classList.toggle('live', loc.live && age < STALE_MS);
      m.root.classList.toggle('stale', age >= STALE_MS);
      m.root.classList.toggle('selected', state.selected === key);
    }
  }

  function renderMarkers() {
    const shown = new Set();
    const me = myLocation();
    if (me) {
      syncMarker('me', state.me, me);
      shown.add('me');
    }
    for (const friend of state.friends.values()) {
      if (!friend.location) continue;
      syncMarker(friend.id, friend, friend.location);
      shown.add(friend.id);
    }
    for (const [key, m] of markers) {
      if (shown.has(key)) continue;
      cancelAnimationFrame(m.raf);
      m.marker.remove();
      m.circle.remove();
      markers.delete(key);
    }
  }

  // ---- friends list --------------------------------------------------------

  function openInMaps(friendId, provider) {
    const loc = (state.friends.get(friendId) || {}).location;
    if (!loc) return;
    const url =
      provider === 'yandex'
        ? `https://yandex.ru/maps/?pt=${loc.lon},${loc.lat}&z=17&l=map`
        : `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lon}`;
    tg.openLink(url);
  }

  function rowFor(friend) {
    let row = rows.get(friend.id);
    if (row) return row;
    const li = el('li', 'friend');
    const top = el('div', 'friend-top');
    const main = el('div', 'friend-main');
    const name = el('b');
    const meta = el('small');
    const distance = el('span', 'friend-dist');
    const actions = el('div', 'friend-actions');
    const yandex = el('button', 'link', 'Яндекс Карты');
    const google = el('button', 'link', 'Google Карты');
    yandex.type = google.type = 'button';
    main.append(name, meta);
    top.append(avatar(friend, 'avatar'), main, distance);
    actions.append(yandex, google);
    li.append(top, actions);
    top.addEventListener('click', () => select(friend.id));
    yandex.addEventListener('click', () => openInMaps(friend.id, 'yandex'));
    google.addEventListener('click', () => openInMaps(friend.id, 'google'));
    row = { li, name, meta, distance };
    rows.set(friend.id, row);
    return row;
  }

  function renderList() {
    // Friends who can be seen on the map come first.
    const friends = [...state.friends.values()].sort((a, b) => !!b.location - !!a.location);
    const me = myLocation();
    els.count.textContent = friends.length || '';
    els.empty.hidden = friends.length > 0;
    for (const [id, row] of rows) {
      if (state.friends.has(id)) continue;
      row.li.remove();
      rows.delete(id);
    }
    friends.forEach((friend, i) => {
      const row = rowFor(friend);
      if (els.list.children[i] !== row.li) els.list.insertBefore(row.li, els.list.children[i] || null);
      const loc = friend.location;
      row.name.textContent = friend.name;
      row.meta.textContent = describe(friend);
      row.meta.classList.toggle('live', !!loc && loc.live);
      row.distance.textContent = me && loc ? formatDistance(L.latLng(me.lat, me.lon).distanceTo([loc.lat, loc.lon])) : '';
      row.li.classList.toggle('selected', state.selected === friend.id);
      row.li.classList.toggle('off', !loc);
    });
  }

  function select(id) {
    const friend = state.friends.get(id);
    if (!friend) return;
    state.selected = id;
    if (friend.location) {
      state.follow = id;
      focus(friend.location, Math.max(map.getZoom(), FOLLOW_ZOOM));
    } else {
      state.follow = null;
      toast(friend.hidden ? `${friend.name} скрывает геопозицию` : `От ${friend.name} пока нет данных`);
    }
    render();
    rows.get(id).li.scrollIntoView({ block: 'nearest' });
    if (tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
  }

  // ---- own status ----------------------------------------------------------

  function renderStatus() {
    const me = state.me;
    const loc = me.location;
    let kind;
    let text;
    if (me.paused) {
      kind = 'off';
      text = 'Вы скрыты от друзей';
    } else if (loc && loc.live) {
      kind = 'ok';
      text = 'Трансляция включена';
    } else if (state.gps === 'ok') {
      kind = 'warn';
      text = 'Вас видно, пока открыта карта';
    } else if (loc) {
      kind = 'warn';
      text = `Друзья видят точку: ${ago(loc.updatedAt)}`;
    } else {
      kind = 'bad';
      text = 'Друзья вас не видят';
    }
    els.status.className = `status ${kind}`;
    els.status.hidden = false;
    els.statusText.textContent = text;
    els.hint.hidden = me.paused || !!(loc && loc.live);
    els.shareToggle.checked = !me.paused;
    els.shareNote.textContent = me.paused ? 'Сейчас вас никто не видит' : 'Вас видят только ваши друзья';
    els.btnMe.classList.toggle('active', state.follow === 'me');
  }

  function render() {
    if (!state.me) return;
    renderMarkers();
    renderList();
    renderStatus();
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  // ---- controls ------------------------------------------------------------

  function bindControls() {
    els.btnMe.addEventListener('click', () => {
      const me = myLocation();
      if (!me) {
        return toast(
          state.gps === 'denied'
            ? 'Нет доступа к геопозиции. Разрешите его для Telegram в настройках телефона.'
            : 'Определяем, где вы…',
        );
      }
      state.follow = 'me';
      state.selected = null;
      focus(me, Math.max(map.getZoom(), FOLLOW_ZOOM));
      render();
    });

    $('btn-fit').addEventListener('click', () => {
      if (!fitAll(true)) toast('Пока некого показывать');
      render();
    });

    $('btn-invite').addEventListener('click', () => {
      const url = `https://t.me/share/url?url=${encodeURIComponent(state.inviteLink)}&text=${encodeURIComponent(SHARE_TEXT)}`;
      tg.openTelegramLink(url);
    });

    $('btn-chat').addEventListener('click', () => tg.close());
    $('sheet-toggle').addEventListener('click', () => els.sheet.classList.toggle('collapsed'));
    els.status.addEventListener('click', () => els.sheet.classList.remove('collapsed'));

    els.shareToggle.addEventListener('change', async () => {
      const paused = !els.shareToggle.checked;
      els.shareToggle.disabled = true;
      try {
        applyState(await api('api/pause', { paused }));
        if (!paused && state.fix) queuePost();
      } catch {
        els.shareToggle.checked = paused;
        toast('Не получилось изменить настройку. Попробуйте ещё раз.');
      } finally {
        els.shareToggle.disabled = false;
      }
    });

    // Links must open outside the Mini App, otherwise they replace the map.
    document.addEventListener('click', (event) => {
      const link = event.target.closest && event.target.closest('a[href^="http"]');
      if (!link) return;
      event.preventDefault();
      tg.openLink(link.href);
    });

    // Keep the round buttons just above the sheet, whatever its height.
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--sheet-h', `${sheetHeight()}px`);
    }).observe(els.sheet);
  }

  const applyTheme = () => document.body.classList.toggle('dark', tg.colorScheme === 'dark');

  async function boot() {
    if (!tg || !tg.initData) return fatal('Откройте карту через бота в Telegram.');
    tg.ready();
    tg.expand();
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); // so that dragging the map does not close the app
    applyTheme();
    tg.onEvent('themeChanged', applyTheme);

    initMap();
    bindControls();
    try {
      await auth();
      applyState(await api('api/state'));
    } catch {
      return fatal('Не получилось загрузить данные. Закройте карту и откройте её снова.');
    }
    connect();
    startGps();
    setInterval(render, 5000); // keeps "N сек назад" and greyed-out markers up to date
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
  }

  boot();
})();
