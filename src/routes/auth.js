import { Router } from 'express';
import { config, TEST_PASSWORD } from '../config.js';
import {
  requireAuth, createSession, destroySession, checkLocalLogin,
  throttleCheck, throttleFail, throttleClear,
} from '../auth.js';
import { HttpError, nowIso, hashPassword, verifyPassword, text, log } from '../util.js';
import { TEST_ACCOUNTS } from '../seed.js';

export function userOut(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, licence: u.licence,
    policyAcked: !!u.policy_ack_at,
    profileComplete: u.role === 'admin' || !!u.licence,
  };
}

export function authRoutes(db) {
  const r = Router();

  r.get('/auth/config', (req, res) => {
    res.json({
      mode: config.authMode,
      appEnv: config.appEnv,
      version: config.version,
      testLogins: config.seedTestData && config.authMode === 'local'
        ? { password: TEST_PASSWORD, accounts: TEST_ACCOUNTS.map(a => ({ email: a.email, label: a.label })) }
        : null,
    });
  });

  r.post('/auth/login', async (req, res) => {
    if (config.authMode !== 'local') throw new HttpError(404, 'Sign-in is handled by your organisation login.');
    const key = `${req.ip}|${String(req.body?.email || '').toLowerCase()}`;
    throttleCheck(key);
    let user;
    try {
      user = await checkLocalLogin(db, req.body?.email, req.body?.password);
    } catch (e) {
      if (e.status === 401) throttleFail(key);
      log('warn', 'login failed', { email: String(req.body?.email || '').slice(0, 100), ip: req.ip });
      throw e;
    }
    throttleClear(key);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
    createSession(db, res, req, user.id);
    log('info', 'login', { userId: user.id, role: user.role });
    res.json(userOut(user));
  });

  r.post('/auth/logout', (req, res) => {
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, (req, res) => res.json(userOut(req.user)));

  r.put('/me', requireAuth, (req, res) => {
    const name = text(req.body?.name, 'Name', { max: 120 });
    const licence = req.user.role === 'admin'
      ? text(req.body?.licence, 'Licence', { optional: true, max: 40 })
      : text(req.body?.licence, "Driver's licence #", { max: 40 });
    db.prepare('UPDATE users SET name = ?, licence = ? WHERE id = ?').run(name, licence, req.user.id);
    res.json(userOut(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  });

  r.post('/me/policy-ack', requireAuth, (req, res) => {
    if (!req.user.policy_ack_at) {
      db.prepare('UPDATE users SET policy_ack_at = ? WHERE id = ?').run(nowIso(), req.user.id);
    }
    res.json(userOut(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  });

  r.post('/me/password', requireAuth, async (req, res) => {
    if (config.authMode !== 'local') throw new HttpError(404, 'Passwords are managed by your organisation login.');
    const next = text(req.body?.newPassword, 'New password', { max: 200 });
    if (next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
    if (!(await verifyPassword(String(req.body?.currentPassword || ''), req.user.password_hash))) {
      throw new HttpError(400, 'Current password is incorrect.');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), req.user.id);
    // Sign out every other session for this user.
    const sid = (req.headers.cookie || '').match(/nst_sid=([a-f0-9]+)/)?.[1];
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, sid || '');
    res.json({ ok: true });
  });

  return r;
}
