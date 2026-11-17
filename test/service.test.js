import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Service } from '../src/service.js';
import { validateInitData, createSessions } from '../src/auth.js';

const make = () => {
  const service = new Service(openDb(':memory:'));
  service.upsertUser({ id: 1, first_name: 'A' });
  service.upsertUser({ id: 2, first_name: 'B' });
  service.upsertUser({ id: 3, first_name: 'C' });
  return service;
};

test('a fresh accurate fix is not replaced by a much rougher one', () => {
  const s = make();
  const now = Date.now();
  assert.equal(s.updateLocation(1, { lat: 1, lon: 1, accuracy: 5, source: 'app', at: now - 3000 }), true);
  assert.equal(s.updateLocation(1, { lat: 2, lon: 2, accuracy: 800, source: 'live', at: now - 1000 }), false);
  assert.equal(s.locationOf(1).lat, 1);
  // A similar-quality fix does replace it…
  assert.equal(s.updateLocation(1, { lat: 3, lon: 3, accuracy: 9, source: 'live', at: now - 500 }), true);
  assert.equal(s.locationOf(1).lat, 3);
});

test('a rough fix is accepted once the accurate one is old', () => {
  const s = make();
  const now = Date.now();
  s.updateLocation(1, { lat: 1, lon: 1, accuracy: 5, source: 'app', at: now - 60_000 });
  assert.equal(s.updateLocation(1, { lat: 2, lon: 2, accuracy: 800, source: 'live', at: now }), true);
});

test('out-of-order points are dropped', () => {
  const s = make();
  const now = Date.now();
  s.updateLocation(1, { lat: 1, lon: 1, source: 'live', at: now - 1000 });
  assert.equal(s.updateLocation(1, { lat: 9, lon: 9, source: 'live', at: now - 5000 }), false);
  assert.equal(s.locationOf(1).lat, 1);
});

test('location is visible to friends only', () => {
  const s = make();
  s.updateLocation(1, { lat: 1, lon: 1, source: 'app' });
  assert.equal(s.visibleLocation(2, 1), null);
  assert.equal(s.requestFriendship(2, 1), 'requested');
  assert.equal(s.visibleLocation(2, 1), null);
  assert.equal(s.acceptRequest(1, 2), true);
  assert.equal(s.visibleLocation(2, 1).lat, 1);
  assert.equal(s.visibleLocation(3, 1), null);
  assert.deepEqual(s.audience(1), [1, 2]);
  s.setPaused(1, true);
  assert.equal(s.visibleLocation(2, 1), null);
  assert.equal(s.visibleLocation(1, 1).lat, 1);
  assert.deepEqual(s.audience(1), [1]);
});

test('two people who invite each other become friends without a third step', () => {
  const s = make();
  assert.equal(s.requestFriendship(1, 2), 'requested');
  assert.equal(s.requestFriendship(2, 1), 'friends');
  assert.equal(s.areFriends(1, 2), true);
  assert.equal(s.requestFriendship(1, 2), 'already');
  assert.equal(s.requestFriendship(1, 1), 'self');
});

test('an older live message cannot end or override the newest one', () => {
  const s = make();
  const now = Date.now();
  s.updateLocation(1, { lat: 1, lon: 1, source: 'live', at: now - 4000 }, { until: now + 60_000, msgId: 10 });
  s.updateLocation(1, { lat: 2, lon: 2, source: 'live', at: now - 3000 }, { until: now + 3_600_000, msgId: 20 });
  assert.equal(s.endLive(1, 10), false);
  assert.equal(s.locationOf(1).live, true);
  assert.equal(s.endLive(1, 20), true);
  assert.equal(s.locationOf(1).live, false);
});

test('session tokens are bound to their signature and expiry', () => {
  const sessions = createSessions('123456:secret-token-secret-token');
  const token = sessions.issue(42);
  assert.equal(sessions.verify(token), 42);
  assert.equal(sessions.verify(token.replace(/^42/, '43')), null);
  assert.equal(sessions.verify(token, Date.now() + 13 * 3600 * 1000), null);
  assert.equal(createSessions('123456:another-token-another-token').verify(token), null);
  assert.equal(sessions.verify(undefined), null);
});

test('init data signed with another bot token is rejected', () => {
  assert.equal(validateInitData('auth_date=1&user=%7B%22id%22%3A1%7D&hash=' + 'a'.repeat(64), '1:x'), null);
  assert.equal(validateInitData('garbage', '1:x'), null);
});
