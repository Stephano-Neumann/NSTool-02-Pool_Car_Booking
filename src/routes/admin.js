import express, { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { getWebhookUrl, validateWebhookUrl } from '../alerts.js';
import { HttpError, nowIso, text, email } from '../util.js';
import { audit } from '../audit.js';

const POLICY_MAX_BYTES = 5 * 1024 * 1024;

export function adminRoutes(db) {
  const r = Router();

  // ---- admin alert recipients ----
  r.get('/admin-profiles', requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT id, name, email FROM admin_profiles ORDER BY name').all());
  });
  r.post('/admin-profiles', requireAdmin, (req, res) => {
    const name = text(req.body?.name, 'Name', { max: 120 });
    const mail = email(req.body?.email);
    const id = db.prepare('INSERT INTO admin_profiles (name, email) VALUES (?, ?)').run(name, mail).lastInsertRowid;
    audit(db, req, 'create', 'admin_profile', id, mail);
    res.status(201).json({ id, name, email: mail });
  });
  r.put('/admin-profiles/:id', requireAdmin, (req, res) => {
    const name = text(req.body?.name, 'Name', { max: 120 });
    const mail = email(req.body?.email);
    const info = db.prepare('UPDATE admin_profiles SET name = ?, email = ? WHERE id = ?').run(name, mail, req.params.id);
    if (!info.changes) throw new HttpError(404, 'Profile not found.');
    audit(db, req, 'update', 'admin_profile', req.params.id, mail);
    res.json({ id: Number(req.params.id), name, email: mail });
  });
  r.delete('/admin-profiles/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM admin_profiles WHERE id = ?').run(req.params.id);
    audit(db, req, 'delete', 'admin_profile', req.params.id);
    res.json({ ok: true });
  });

  // ---- alerts ----
  r.get('/alerts', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT * FROM alerts_log ORDER BY id DESC LIMIT 50').all();
    res.json({
      webhookUrl: getWebhookUrl(db),
      log: rows.map(a => ({
        id: a.id, kind: a.kind, subject: a.subject, recipients: JSON.parse(a.recipients),
        sentAt: a.sent_at, delivered: !!a.delivered,
      })),
    });
  });
  r.put('/alerts/webhook', requireAdmin, (req, res) => {
    const url = validateWebhookUrl(text(req.body?.url, 'Webhook URL', { optional: true, max: 2000 }));
    db.prepare("INSERT INTO settings (key, value) VALUES ('alert_webhook_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(url);
    audit(db, req, 'update', 'setting', 'alert_webhook_url', url ? 'set' : 'cleared');
    res.json({ webhookUrl: url });
  });

  // ---- policy document (PDF stored in the database) ----
  const policyMeta = () => {
    const p = db.prepare('SELECT filename, size, uploaded_at FROM policy_document WHERE id = 1').get();
    return p ? { filename: p.filename, size: p.size, uploadedAt: p.uploaded_at } : null;
  };

  r.get('/policy', requireAuth, (req, res) => res.json(policyMeta()));

  r.get('/policy/file', requireAuth, (req, res) => {
    const p = db.prepare('SELECT filename, data FROM policy_document WHERE id = 1').get();
    if (!p) throw new HttpError(404, 'No policy document has been uploaded.');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${p.filename.replace(/[^\w.\- ]/g, '_')}"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    });
    res.send(p.data);
  });

  r.put('/policy', requireAdmin,
    express.raw({ type: 'application/pdf', limit: POLICY_MAX_BYTES }),
    (req, res) => {
      const data = req.body;
      if (!Buffer.isBuffer(data) || data.length === 0) throw new HttpError(400, 'Please choose a PDF file.');
      if (data.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'That file is not a valid PDF.');
      let filename = 'policy.pdf';
      try { filename = decodeURIComponent(String(req.headers['x-filename'] || filename)); } catch { /* keep default */ }
      filename = filename.slice(0, 200);
      db.prepare(`INSERT INTO policy_document (id, filename, size, uploaded_at, uploaded_by, data) VALUES (1, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, size = excluded.size,
                    uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by, data = excluded.data`)
        .run(filename, data.length, nowIso(), req.user.id, data);
      audit(db, req, 'upload', 'policy_document', 1, filename);
      res.json(policyMeta());
    });

  r.delete('/policy', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM policy_document WHERE id = 1').run();
    audit(db, req, 'delete', 'policy_document', 1);
    res.json({ ok: true });
  });

  return r;
}
