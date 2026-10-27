import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const nowIso = () => new Date().toISOString();

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// "2026-10" for the current month in the configured time zone.
export function currentMonthKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit' })
    .formatToParts(date);
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}`;
}

export const EMAIL_RE = /^\S+@\S+\.\S+$/;

// Trimmed string, required unless opts.optional, capped at opts.max (default 500).
export function text(value, label, opts = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s && !opts.optional) throw new HttpError(400, `${label} is required.`);
  if (s.length > (opts.max || 500)) throw new HttpError(400, `${label} is too long.`);
  return s;
}

export function email(value, label = 'Email') {
  const s = text(value, label, { max: 254 });
  if (!EMAIL_RE.test(s)) throw new HttpError(400, `Enter a valid ${label.toLowerCase()} address.`);
  return s;
}

// Non-negative whole number, or null when blank and optional.
export function wholeNumber(value, label, opts = {}) {
  if (value === '' || value === null || value === undefined) {
    if (opts.optional) return null;
    throw new HttpError(400, `${label} is required.`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) throw new HttpError(400, `${label} must be a whole number.`);
  return n;
}

export function isoDate(value, label) {
  const d = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) throw new HttpError(400, `${label} is not a valid date.`);
  return d.toISOString();
}

export function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ level, msg, ts: nowIso(), ...extra }));
}
