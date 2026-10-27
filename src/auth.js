import crypto from 'node:crypto';
import { config } from './config.js';
import { HttpError, nowIso, verifyPassword, EMAIL_RE } from './util.js';

const COOKIE = 'nst_sid';

// ---- sessions (local auth mode) ----------------------------------------

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(db, res, req, userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.sessionHours * 3600_000);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expires.toISOString());
  res.cookie(COOKIE, id, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', expires,
  });
}

export function destroySession(db, req, res) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  res.clearCookie(COOKIE, { path: '/' });
}

// ---- gateway mode (Azure Easy Auth / Entra ID) -------------------------

const EMAIL_CLAIMS = [
  'preferred_username', 'upn', 'emails',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
];

// Decodes the X-MS-CLIENT-PRINCIPAL header the gateway sets after Entra sign-in.
// Only trustworthy when the platform forces authentication in front of the app.
export function readGatewayPrincipal(req) {
  const raw = req.headers['x-ms-client-principal'];
  if (!raw) return null;
  let principal;
  try {
    principal = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const claims = principal.claims || [];
  const claim = (typ) => claims.find(c => c.typ === typ)?.val;
  let mail = null;
  for (const typ of EMAIL_CLAIMS) {
    const v = claim(typ);
    if (v && EMAIL_RE.test(v)) { mail = v; break; }
  }
  if (!mail) return null;
  const name = claim('name') || claim('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name') || mail.split('@')[0];
  const roles = claims
    .filter(c => c.typ === 'roles' || c.typ === principal.role_typ || c.typ === 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role')
    .map(c => c.val);
  return { email: mail.toLowerCase(), name, roles };
}

function provisionGatewayUser(db, principal) {
  const isAdmin = principal.roles.includes(config.adminRole) || config.adminEmails.includes(principal.email);
  const role = isAdmin ? 'admin' : 'driver';
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(principal.email);
  if (!existing) {
    const id = db.prepare('INSERT INTO users (email, name, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)')
      .run(principal.email, principal.name, role, nowIso(), nowIso()).lastInsertRowid;
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  // Entra is the source of truth for role; the app keeps the profile fields.
  db.prepare('UPDATE users SET role = ?, last_login_at = ? WHERE id = ?').run(role, nowIso(), existing.id);
  return { ...existing, role };
}

// ---- middleware ----------------------------------------------------------

export function attachUser(db) {
  return (req, res, next) => {
    req.user = null;
    if (config.authMode === 'gateway') {
      const principal = readGatewayPrincipal(req);
      if (principal) {
        const user = provisionGatewayUser(db, principal);
        if (user.active) req.user = user;
      }
      return next();
    }
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (sid) {
      const row = db.prepare(`
        SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ? AND u.active = 1`).get(sid, nowIso());
      if (row) req.user = row;
    }
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in required.'));
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in required.'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Admin access required.'));
  next();
}

// Mutating API calls must carry a custom header. Browsers will not add it
// cross-site without a CORS preflight, which this server never approves.
export function requireCsrfHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-by'] !== 'nst-app') return next(new HttpError(403, 'Missing request header.'));
  next();
}

// ---- login throttling ----------------------------------------------------

const attempts = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;

export function throttleCheck(key) {
  const entry = attempts.get(key);
  if (entry && Date.now() - entry.first < WINDOW_MS && entry.count >= MAX_FAILURES) {
    throw new HttpError(429, 'Too many failed sign-in attempts. Try again in a few minutes.');
  }
}
export function throttleFail(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first >= WINDOW_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else entry.count += 1;
}
export function throttleClear(key) { attempts.delete(key); }

export async function checkLocalLogin(db, emailInput, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(emailInput || '').trim());
  // Always run a hash comparison so response time doesn't reveal whether the email exists.
  const ok = await verifyPassword(String(password || ''), user?.password_hash || 'scrypt$00$00');
  if (!user || !ok) throw new HttpError(401, 'Incorrect email or password.');
  if (!user.active) throw new HttpError(403, 'This account has been disabled. Contact your administrator.');
  return user;
}
