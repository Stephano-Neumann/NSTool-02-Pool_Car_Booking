import express, { Router } from 'express';
import { requireAuth } from '../auth.js';
import { HttpError, nowIso } from '../util.js';
import { audit } from '../audit.js';

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_MAX_PER_OWNER = 8;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// What the file actually is, from its first bytes. The Content-Type header alone is never trusted.
function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const photoOut = (p) => ({ id: p.id, filename: p.filename, size: p.size, createdAt: p.created_at });

// Photo metadata (never the bytes) for a set of owners of one type: Map(ownerId -> [photo]).
export function photosByOwner(db, ownerType, ownerIds) {
  const map = new Map(ownerIds.map(id => [id, []]));
  if (ownerIds.length === 0) return map;
  const marks = ownerIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, owner_id, filename, size, created_at FROM photos
                           WHERE owner_type = ? AND owner_id IN (${marks}) ORDER BY id`).all(ownerType, ...ownerIds);
  for (const p of rows) map.get(p.owner_id).push(photoOut(p));
  return map;
}

export function photoRoutes(db) {
  const r = Router();
  const upload = express.raw({ type: PHOTO_TYPES, limit: PHOTO_MAX_BYTES });

  // Only the person who made the report / prestart can attach to it. Anyone else gets a 404.
  function attach(ownerType, loadOwner) {
    return (req, res) => {
      const owner = loadOwner(req.params.id);
      if (!owner || owner.user_id !== req.user.id) throw new HttpError(404, 'Not found.');
      const data = req.body;
      if (!Buffer.isBuffer(data) || data.length === 0) throw new HttpError(400, 'Choose a JPEG, PNG or WebP photo.');
      const mime = sniffImage(data);
      if (!mime) throw new HttpError(400, 'That file is not a valid JPEG, PNG or WebP photo.');
      const count = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE owner_type = ? AND owner_id = ?').get(ownerType, owner.id).n;
      if (count >= PHOTO_MAX_PER_OWNER) throw new HttpError(409, `A maximum of ${PHOTO_MAX_PER_OWNER} photos can be attached.`);
      let filename = 'photo';
      try { filename = decodeURIComponent(String(req.headers['x-filename'] || filename)); } catch { /* keep default */ }
      filename = filename.replace(/[\r\n]/g, ' ').slice(0, 200) || 'photo';
      const id = db.prepare(`INSERT INTO photos (owner_type, owner_id, user_id, filename, mime, size, data, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ownerType, owner.id, req.user.id, filename, mime, data.length, data, nowIso()).lastInsertRowid;
      audit(db, req, 'upload', `${ownerType}_photo`, id, filename);
      res.status(201).json(photoOut(db.prepare('SELECT * FROM photos WHERE id = ?').get(id)));
    };
  }

  r.post('/incidents/:id/photos', requireAuth, upload,
    attach('incident', (id) => db.prepare('SELECT id, user_id FROM incidents WHERE id = ?').get(id)));
  r.post('/prestarts/:id/photos', requireAuth, upload,
    attach('prestart', (id) => db.prepare('SELECT id, user_id FROM prestarts WHERE id = ?').get(id)));

  // Admins see every photo; everyone else only the photos they uploaded.
  r.get('/photos/:id', requireAuth, (req, res) => {
    const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
    if (!p || (req.user.role !== 'admin' && p.user_id !== req.user.id)) throw new HttpError(404, 'Photo not found.');
    res.set({
      'Content-Type': p.mime,
      'Content-Disposition': `inline; filename="${p.filename.replace(/[^\w.\- ]/g, '_')}"`,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(p.data);
  });

  return r;
}
