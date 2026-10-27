import { nowIso } from './util.js';

// Append-only record of admin changes: who, what, when.
export function audit(db, req, action, entity, entityId, detail = '') {
  db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nowIso(), req.user?.email || 'system', action, entity, String(entityId ?? ''), String(detail).slice(0, 500));
}
