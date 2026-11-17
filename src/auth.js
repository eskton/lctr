import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify Telegram Mini App `initData` (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * @returns {{user: object, authDate: number} | null}
 */
export function validateInitData(initData, botToken, { maxAgeSec = 86_400, now = Date.now() } = {}) {
  if (typeof initData !== 'string' || !initData || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSec) return null;

  try {
    const user = JSON.parse(params.get('user'));
    if (!Number.isSafeInteger(user?.id)) return null;
    return { user, authDate };
  } catch {
    return null;
  }
}

/** Stateless signed session tokens for the Mini App API. */
export function createSessions(botToken, ttlMs = 12 * 3600 * 1000) {
  const key = createHmac('sha256', botToken).update('lctr-session-v1').digest();
  const sign = (payload) => createHmac('sha256', key).update(payload).digest('base64url');

  return {
    issue(userId, now = Date.now()) {
      const payload = `${userId}.${now + ttlMs}`;
      return `${payload}.${sign(payload)}`;
    },
    /** @returns the user id, or null if the token is invalid or expired */
    verify(token, now = Date.now()) {
      if (typeof token !== 'string' || token.length > 200) return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [userId, exp, sig] = parts;
      const expected = Buffer.from(sign(`${userId}.${exp}`));
      const given = Buffer.from(sig);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      if (!(Number(exp) > now)) return null;
      const id = Number(userId);
      return Number.isSafeInteger(id) ? id : null;
    },
  };
}
