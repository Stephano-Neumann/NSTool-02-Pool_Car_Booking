import { Router } from 'express';
import { requireAuth } from './auth.js';
import { HttpError, nowIso, log } from './util.js';

/*
 * App usage analytics: who used the app, as which account type, for how long, and what they did.
 * Exported to Fabric as the usage_sessions and usage_events datasets (src/routes/export.js).
 *
 * - The browser sends POST /api/usage/ping when a screen opens, every minute while the page is visible,
 *   and when the page is hidden or closed. That gives the visit (usage_sessions), the screens opened and
 *   the time spent (only gaps between pings of up to MAX_GAP_SECONDS count, so an idle background tab
 *   or a sleeping laptop adds nothing).
 * - Every write through the API (POST/PUT/PATCH/DELETE) is recorded server-side as an 'action' event,
 *   so "what they did" does not depend on the browser.
 * Recording must never break a request: failures are logged and swallowed.
 */

export const USAGE_VIEWS = ['menu', 'pool-booking', 'company-car', 'incidents', 'admin'];
export const USAGE_HEADER = 'x-usage-session';
const MAX_GAP_SECONDS = 150; // the browser pings every 60 s; allow one missed ping
const KEY_RE = /^[A-Za-z0-9-]{16,64}$/;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const validKey = (v) => (typeof v === 'string' && KEY_RE.test(v) ? v : null);

// Coarse device class only; the raw user agent is not stored.
export function deviceFromUserAgent(ua = '') {
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|Android/i.test(ua)) return 'mobile';
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return 'desktop';
  return 'other';
}

// "PUT /api/bookings/12/trip" -> "PUT /api/bookings/:id/trip"
export const actionName = (method, path) => `${method} /api${path}`.replace(/\/\d+(?=\/|$)/g, '/:id').slice(0, 200);

// Middleware on /api: records each write as an action event once the response is sent.
export function usageActions(db) {
  const findSession = db.prepare('SELECT id FROM usage_sessions WHERE session_key = ? AND user_id = ?');
  const bumpSession = db.prepare('UPDATE usage_sessions SET actions = actions + 1, updated_at = ? WHERE id = ?');
  const insertEvent = db.prepare(`INSERT INTO usage_events (at, user_id, user_name, user_email, usage_session_id, role, kind, name, status, duration_ms)
                                  VALUES (?, ?, ?, ?, ?, ?, 'action', ?, ?, ?)`);
  return (req, res, next) => {
    if (!WRITE_METHODS.has(req.method) || req.path === '/usage/ping') return next();
    const name = actionName(req.method, req.path);
    const key = validKey(req.headers[USAGE_HEADER]);
    const started = Date.now();
    res.on('finish', () => {
      const user = req.user || res.locals.usageUser; // login sets usageUser: req.user is not set yet then
      if (!user) return;
      try {
        const at = nowIso();
        const session = key ? findSession.get(key, user.id) : null;
        insertEvent.run(at, user.id, user.name, user.email, session?.id ?? null, user.role, name, res.statusCode, Date.now() - started);
        if (session) bumpSession.run(at, session.id);
      } catch (e) {
        log('warn', 'usage action not recorded', { error: e.message });
      }
    });
    next();
  };
}

export function usageRoutes(db) {
  const r = Router();

  r.post('/usage/ping', requireAuth, (req, res) => {
    const key = validKey(req.body?.sessionKey);
    if (!key) throw new HttpError(400, 'sessionKey is required.');
    const view = req.body?.view ?? null;
    if (view !== null && !USAGE_VIEWS.includes(view)) throw new HttpError(400, 'Unknown view.');
    const page = req.body?.page ?? 'user';
    if (!['user', 'admin'].includes(page)) throw new HttpError(400, 'page must be user or admin.');
    const end = req.body?.end === true;
    const now = nowIso();
    const user = req.user;

    db.transaction(() => {
      let s = db.prepare('SELECT * FROM usage_sessions WHERE session_key = ?').get(key);
      if (s && s.user_id !== user.id) throw new HttpError(409, 'Usage session belongs to another user.');
      if (!s) {
        const id = db.prepare(`INSERT INTO usage_sessions (session_key, user_id, user_name, user_email, role, page, device, started_at, last_seen_at, ended_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(key, user.id, user.name, user.email, user.role, page, deviceFromUserAgent(req.headers['user-agent']), now, now, end ? now : null, now).lastInsertRowid;
        s = { id, current_view: null };
      } else {
        const gap = (Date.parse(now) - Date.parse(s.last_seen_at)) / 1000;
        const add = gap > 0 && gap <= MAX_GAP_SECONDS ? Math.round(gap) : 0;
        db.prepare('UPDATE usage_sessions SET last_seen_at = ?, active_seconds = active_seconds + ?, ended_at = ?, updated_at = ? WHERE id = ?')
          .run(now, add, end ? now : null, now, s.id);
      }
      if (view && view !== s.current_view) {
        db.prepare(`INSERT INTO usage_events (at, user_id, user_name, user_email, usage_session_id, role, kind, name) VALUES (?, ?, ?, ?, ?, ?, 'view', ?)`)
          .run(now, user.id, user.name, user.email, s.id, user.role, view);
        db.prepare('UPDATE usage_sessions SET views = views + 1, current_view = ?, updated_at = ? WHERE id = ?').run(view, now, s.id);
      }
    })();
    res.status(204).end();
  });

  return r;
}

// Retention: usage older than `days` is removed from the app database. Not tombstoned on purpose:
// the lake keeps the history it has already loaded.
export function purgeUsage(db, days) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM usage_events WHERE at < ?').run(cutoff);
    db.prepare('DELETE FROM usage_sessions WHERE last_seen_at < ?').run(cutoff);
  })();
}
