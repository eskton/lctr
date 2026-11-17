import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,   -- Telegram user id
  first_name  TEXT NOT NULL,
  last_name   TEXT,
  username    TEXT,
  photo_url   TEXT,
  invite_code TEXT NOT NULL UNIQUE,
  paused      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- A friendship is stored once, with user_a < user_b.
CREATE TABLE IF NOT EXISTS friendships (
  user_a     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS friendships_b ON friendships(user_b);

-- from_id opened to_id's invite link and agreed; to_id still has to confirm.
CREATE TABLE IF NOT EXISTS requests (
  from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);

-- Only the latest point per user is kept; there is no location history.
CREATE TABLE IF NOT EXISTS locations (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat           REAL NOT NULL,
  lon           REAL NOT NULL,
  accuracy      REAL,              -- metres
  heading       REAL,              -- degrees, 0 = north
  speed         REAL,              -- m/s
  altitude      REAL,              -- metres
  source        TEXT NOT NULL,     -- 'live' (Telegram live location) | 'app' (map GPS) | 'once'
  updated_at    INTEGER NOT NULL,  -- ms since epoch
  live_until    INTEGER,           -- ms since epoch; NULL when no Telegram live location was started
  live_msg_id   INTEGER,           -- message id of the current Telegram live location
  live_notified INTEGER NOT NULL DEFAULT 0
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}
