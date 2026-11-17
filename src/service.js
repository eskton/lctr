import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

const newInviteCode = () => randomBytes(9).toString('base64url');
const pair = (a, b) => (a < b ? [a, b] : [b, a]);

// A new point that is much less accurate than a fresh, accurate one is noise
// (e.g. a cell-tower fix arriving right after a GPS fix) and would make the marker jump.
const FRESH_MS = 15_000;
function isWorseThanFresh(prev, next, at) {
  if (!prev || prev.accuracy == null || next.accuracy == null) return false;
  if (at - prev.updated_at >= FRESH_MS) return false;
  return next.accuracy > Math.max(prev.accuracy * 3, 50);
}

/**
 * All business rules live here. Emits:
 *   'location' (userId)     – a user's stored point changed
 *   'changed'  (userIds[])  – these users should reload their state (friends, pause, live status)
 */
export class Service extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    const p = (sql) => db.prepare(sql);
    this.q = {
      getUser: p('SELECT * FROM users WHERE id = ?'),
      getUserByInvite: p('SELECT * FROM users WHERE invite_code = ?'),
      insertUser: p('INSERT INTO users (id, first_name, last_name, username, photo_url, invite_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      updateUser: p('UPDATE users SET first_name = ?, last_name = ?, username = ?, photo_url = COALESCE(?, photo_url) WHERE id = ?'),
      setInvite: p('UPDATE users SET invite_code = ? WHERE id = ?'),
      setPaused: p('UPDATE users SET paused = ? WHERE id = ?'),
      deleteUser: p('DELETE FROM users WHERE id = ?'),

      isFriend: p('SELECT 1 AS ok FROM friendships WHERE user_a = ? AND user_b = ?'),
      addFriend: p('INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)'),
      delFriend: p('DELETE FROM friendships WHERE user_a = ? AND user_b = ?'),
      friends: p(`SELECT u.* FROM friendships f
                  JOIN users u ON u.id = CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END
                  WHERE f.user_a = ?1 OR f.user_b = ?1
                  ORDER BY u.first_name COLLATE NOCASE, u.id`),

      getRequest: p('SELECT 1 AS ok FROM requests WHERE from_id = ? AND to_id = ?'),
      addRequest: p('INSERT OR IGNORE INTO requests (from_id, to_id, created_at) VALUES (?, ?, ?)'),
      delRequest: p('DELETE FROM requests WHERE from_id = ? AND to_id = ?'),

      getLoc: p('SELECT * FROM locations WHERE user_id = ?'),
      putLoc: p(`INSERT INTO locations (user_id, lat, lon, accuracy, heading, speed, altitude, source, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET
                   lat = excluded.lat, lon = excluded.lon, accuracy = excluded.accuracy,
                   heading = excluded.heading, speed = excluded.speed, altitude = excluded.altitude,
                   source = excluded.source, updated_at = excluded.updated_at`),
      setLive: p('UPDATE locations SET live_until = ?, live_msg_id = ?, live_notified = ? WHERE user_id = ?'),
      expiredLives: p('SELECT user_id FROM locations WHERE live_until IS NOT NULL AND live_until <= ? AND live_notified = 0'),
      markLiveNotified: p('UPDATE locations SET live_notified = 1 WHERE user_id = ?'),
    };
  }

  // ---- users ---------------------------------------------------------------

  /** Create or refresh a user from a Telegram `User` object. */
  upsertUser(tgUser, { photoUrl = null } = {}) {
    const existing = this.q.getUser.get(tgUser.id);
    const first = tgUser.first_name || tgUser.username || 'Без имени';
    if (!existing) {
      this.q.insertUser.run(tgUser.id, first, tgUser.last_name ?? null, tgUser.username ?? null, photoUrl, newInviteCode(), Date.now());
    } else {
      this.q.updateUser.run(first, tgUser.last_name ?? null, tgUser.username ?? null, photoUrl, tgUser.id);
    }
    return this.q.getUser.get(tgUser.id);
  }

  getUser(id) {
    return this.q.getUser.get(id) ?? null;
  }

  getUserByInvite(code) {
    return this.q.getUserByInvite.get(code) ?? null;
  }

  /** Invalidate the old invite link and return the new code. */
  resetInvite(id) {
    const code = newInviteCode();
    this.q.setInvite.run(code, id);
    return code;
  }

  setPaused(id, paused) {
    this.q.setPaused.run(paused ? 1 : 0, id);
    this.emit('changed', [id, ...this.friendIds(id)]);
  }

  /** Remove the user and everything stored about them. */
  deleteUser(id) {
    const friends = this.friendIds(id);
    this.q.deleteUser.run(id);
    this.emit('changed', [id, ...friends]);
  }

  // ---- friends -------------------------------------------------------------

  areFriends(a, b) {
    return a !== b && !!this.q.isFriend.get(...pair(a, b));
  }

  listFriends(id) {
    return this.q.friends.all(id);
  }

  friendIds(id) {
    return this.listFriends(id).map((u) => u.id);
  }

  /**
   * `fromId` agreed to share with `toId` (the owner of an invite link).
   * Friendship needs consent from both sides, so this only records a request
   * unless the other side has already asked.
   * @returns {'self' | 'already' | 'friends' | 'requested'}
   */
  requestFriendship(fromId, toId) {
    if (fromId === toId) return 'self';
    if (this.areFriends(fromId, toId)) return 'already';
    if (this.q.getRequest.get(toId, fromId)) {
      this.#makeFriends(fromId, toId);
      return 'friends';
    }
    this.q.addRequest.run(fromId, toId, Date.now());
    return 'requested';
  }

  /** The invite owner confirms a pending request. */
  acceptRequest(ownerId, fromId) {
    if (!this.q.getRequest.get(fromId, ownerId)) return false;
    this.#makeFriends(ownerId, fromId);
    return true;
  }

  declineRequest(ownerId, fromId) {
    return this.q.delRequest.run(fromId, ownerId).changes > 0;
  }

  removeFriend(a, b) {
    const removed = this.q.delFriend.run(...pair(a, b)).changes > 0;
    if (removed) this.emit('changed', [a, b]);
    return removed;
  }

  #makeFriends(a, b) {
    this.q.addFriend.run(...pair(a, b), Date.now());
    this.q.delRequest.run(a, b);
    this.q.delRequest.run(b, a);
    this.emit('changed', [a, b]);
  }

  // ---- locations -----------------------------------------------------------

  /**
   * Store a new point for a user.
   * @param point {lat, lon, accuracy?, heading?, speed?, altitude?, source, at?}  (`at` in ms)
   * @param live  {until, msgId} when the point comes from a Telegram live location
   * @returns true if the point replaced the stored one
   */
  updateLocation(id, point, live = null) {
    const user = this.q.getUser.get(id);
    if (!user) return false;
    const prev = this.q.getLoc.get(id);
    const now = Date.now();
    const at = Math.min(point.at ?? now, now);

    // While hidden, nothing new is recorded.
    const stored = !user.paused && !(prev && at < prev.updated_at) && !isWorseThanFresh(prev, point, at);
    if (stored) {
      this.q.putLoc.run(
        id, point.lat, point.lon,
        point.accuracy ?? null, point.heading ?? null, point.speed ?? null, point.altitude ?? null,
        point.source, at,
      );
    }

    let liveChanged = false;
    if (live && (prev || stored)) {
      // Updates of an older live message must not override the newest one.
      const current = prev?.live_msg_id ?? null;
      if (current == null || live.msgId >= current) {
        if (prev?.live_until !== live.until || current !== live.msgId) {
          this.q.setLive.run(live.until, live.msgId, live.until <= now ? 1 : 0, id);
          liveChanged = (prev?.live_until ?? 0) > now !== live.until > now;
        }
      }
    }

    if (stored) this.emit('location', id);
    if (liveChanged && !stored) this.emit('changed', this.audience(id));
    return stored;
  }

  /** The user stopped their Telegram live location (message `msgId`). */
  endLive(id, msgId) {
    const prev = this.q.getLoc.get(id);
    if (!prev || prev.live_until == null) return false;
    if (msgId != null && prev.live_msg_id != null && msgId !== prev.live_msg_id) return false;
    this.q.setLive.run(Date.now(), prev.live_msg_id, 1, id);
    this.emit('changed', this.audience(id));
    return true;
  }

  /** Users whose live location ran out and who have not been told yet. Marks them as told. */
  takeExpiredLives(now = Date.now()) {
    const ids = this.q.expiredLives.all(now).map((r) => r.user_id);
    for (const id of ids) {
      this.q.markLiveNotified.run(id);
      this.emit('changed', this.audience(id));
    }
    return ids;
  }

  /** Everyone allowed to see this user's location: the user and, unless hidden, their friends. */
  audience(id) {
    const user = this.q.getUser.get(id);
    if (!user) return [];
    return user.paused ? [id] : [id, ...this.friendIds(id)];
  }

  /** The user's stored location in API form, with no access check. */
  locationOf(id, now = Date.now()) {
    const row = this.q.getLoc.get(id);
    if (!row) return null;
    return {
      lat: row.lat,
      lon: row.lon,
      accuracy: row.accuracy,
      heading: row.heading,
      speed: row.speed,
      altitude: row.altitude,
      source: row.source,
      updatedAt: row.updated_at,
      live: row.live_until != null && row.live_until > now,
    };
  }

  /** What `viewerId` may see of `targetId`'s location, or null. */
  visibleLocation(viewerId, targetId) {
    if (viewerId !== targetId) {
      if (!this.areFriends(viewerId, targetId)) return null;
      if (this.q.getUser.get(targetId)?.paused) return null;
    }
    return this.locationOf(targetId);
  }

  /** Everything the user's own screen needs. */
  stateFor(id) {
    const me = this.q.getUser.get(id);
    if (!me) return null;
    return {
      me: { ...publicUser(me), paused: !!me.paused, location: this.locationOf(id) },
      friends: this.listFriends(id).map((f) => ({
        ...publicUser(f),
        hidden: !!f.paused,
        location: f.paused ? null : this.locationOf(f.id),
      })),
    };
  }
}

export function displayName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ');
}

function publicUser(user) {
  return { id: user.id, name: displayName(user), username: user.username, photoUrl: user.photo_url };
}
