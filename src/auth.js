import crypto from 'node:crypto';
import { config, ENTRA_ROLES } from './config.js';
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
  // The roles claim of the validated Entra token. Easy Auth lists one claim per role; some setups send
  // a single claim holding a JSON array, so accept both.
  const roles = claims
    .filter(c => c.typ === 'roles' || c.typ === principal.role_typ || c.typ === 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role')
    .flatMap(c => {
      const v = c.val;
      if (typeof v === 'string' && v.trim().startsWith('[')) {
        try { const arr = JSON.parse(v); if (Array.isArray(arr)) return arr.map(String); } catch { /* plain value */ }
      }
      return [String(v)];
    });
  return { email: mail.toLowerCase(), name, roles };
}

// Maps Entra app roles to the app's role. Exact, case-sensitive match on the two role values.
// CarPool.Admin wins when a user has both. Returns null when the user has neither (= no access).
export function roleFromEntraRoles(roles) {
  if (roles.includes(ENTRA_ROLES.admin)) return 'admin';
  if (roles.includes(ENTRA_ROLES.user)) return 'driver';
  return null;
}

function provisionGatewayUser(db, principal, role) {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(principal.email);
  if (!existing) {
    const id = db.prepare('INSERT INTO users (email, name, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)')
      .run(principal.email, principal.name, role, nowIso(), nowIso()).lastInsertRowid;
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  // Entra is the source of truth for role; the app keeps the profile fields. This runs on every request,
  // so a changed role shows up as soon as the platform hands us a token carrying the new roles.
  db.prepare('UPDATE users SET role = ?, last_login_at = ? WHERE id = ?').run(role, nowIso(), existing.id);
  return { ...existing, role };
}

// ---- middleware ----------------------------------------------------------

// Gateway mode defence in depth: with ALLOWED_EMAIL_DOMAINS set, anyone signed in
// through Entra with an address outside those domains is treated as not signed in
// and no user row is created for them. Empty list = no restriction.
export function emailDomainAllowed(email) {
  if (!config.allowedEmailDomains.length) return true;
  const domain = String(email || '').toLowerCase().split('@').pop();
  return config.allowedEmailDomains.includes(domain);
}

export function attachUser(db) {
  return (req, res, next) => {
    req.user = null;
    req.noRole = false;
    if (config.authMode === 'gateway') {
      const principal = readGatewayPrincipal(req);
      if (principal && emailDomainAllowed(principal.email)) {
        const role = roleFromEntraRoles(principal.roles);
        if (!role) {
          // Signed in with Entra but holds neither CarPool role: no user is created and nothing is served.
          req.noRole = true;
          return next();
        }
        const user = provisionGatewayUser(db, principal, role);
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

const noRoleError = () => new HttpError(403,
  `You are signed in but have no access to this app. Ask your administrator to assign you the ${ENTRA_ROLES.user} or ${ENTRA_ROLES.admin} role.`, 'no_role');

export function requireAuth(req, res, next) {
  if (!req.user) return next(req.noRole ? noRoleError() : new HttpError(401, 'Sign in required.'));
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return next(req.noRole ? noRoleError() : new HttpError(401, 'Sign in required.'));
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
