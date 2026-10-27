import net from 'node:net';
import { config } from './config.js';
import { HttpError, nowIso, log } from './util.js';

export function getWebhookUrl(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'alert_webhook_url'").get();
  return (row && row.value) || config.alertWebhookUrl;
}

// The webhook is fetched server-side, so only accept public https URLs.
export function validateWebhookUrl(value) {
  if (!value) return '';
  let u;
  try { u = new URL(value); } catch { throw new HttpError(400, 'Enter a valid webhook URL.'); }
  const host = u.hostname.toLowerCase();
  const privateHost = host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
    (net.isIP(host) && /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1|fc|fd|fe80)/i.test(host));
  if (u.protocol !== 'https:' || privateHost) {
    throw new HttpError(400, 'The webhook must be a public https:// URL.');
  }
  return u.toString();
}

const fmt = (iso) => new Date(iso).toLocaleString('en-AU', {
  timeZone: config.timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

// Logs every alert and, when a webhook (e.g. a Power Automate HTTP trigger) is
// configured, posts it there. Without a webhook the alert is logged only.
export async function triggerBookingAlert(db, kind, booking) {
  const v = db.prepare('SELECT rego, model FROM vehicles WHERE id = ?').get(booking.vehicle_id);
  const vehicleLabel = v ? `${v.rego} — ${v.model}` : 'vehicle';
  const when = `${fmt(booking.pickup)} – ${fmt(booking.ret)}`;
  const subject = kind === 'created' ? `Booking requested: ${vehicleLabel}` : `Booking approved: ${vehicleLabel}`;
  const body = kind === 'created'
    ? `${booking.driver_name} requested ${vehicleLabel} for ${when} (${booking.use_type} use, ${booking.department}). Awaiting admin approval.`
    : `${booking.driver_name}’s booking for ${vehicleLabel} (${when}) has been approved and is ready to go.`;

  const admins = db.prepare('SELECT email FROM admin_profiles').all().map(r => r.email);
  const recipients = [...new Set([booking.email, ...admins].filter(Boolean))];

  let delivered = false;
  const url = getWebhookUrl(db);
  if (url) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients, subject, body }),
        signal: AbortSignal.timeout(8000),
      });
      delivered = res.ok;
    } catch (e) {
      log('warn', 'alert webhook failed', { error: e.message });
    }
  }

  db.prepare(`INSERT INTO alerts_log (kind, booking_id, recipients, subject, body, sent_at, delivered)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(kind, booking.id, JSON.stringify(recipients), subject, body, nowIso(), delivered ? 1 : 0);
  db.prepare('DELETE FROM alerts_log WHERE id NOT IN (SELECT id FROM alerts_log ORDER BY id DESC LIMIT 200)').run();
}
