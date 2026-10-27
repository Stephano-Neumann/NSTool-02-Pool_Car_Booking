import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { HttpError, nowIso, log } from '../util.js';
import { throttleCheck, throttleFail, throttleClear } from '../auth.js';

/*
 * Data Export API — the same contract on every Neumann Steel platform, so one
 * Fabric pipeline can ingest them all. Read-only, authenticated by an API key
 * (not a user session). See docs/PLATFORM-STANDARD.md section 14.
 *
 * Each dataset: table, columns to expose (an allow-list — secrets and blobs are
 * never listed), the watermark column for incremental loads, and a PII flag.
 */
const DATASETS = {
  users:               { cols: 'id,email,name,role,licence,active,policy_ack_at,created_at,last_login_at,updated_at', wm: 'updated_at', pii: true },
  vehicles:            { cols: 'id,rego,model,archived,archived_at,updated_at', wm: 'updated_at' },
  bookings:            { cols: 'id,vehicle_id,user_id,driver_name,licence,email,department,cost_centre,use_type,pickup,ret,status,created_at,reviewed_at,reviewed_by,actual_pickup,actual_return,start_km,finish_km,start_notes,finish_notes,fuel_ok,updated_at', wm: 'updated_at', pii: true },
  admin_profiles:      { cols: 'id,name,email,updated_at', wm: 'updated_at', pii: true },
  alerts_log:          { cols: 'id,kind,booking_id,recipients,subject,body,sent_at,delivered', wm: 'sent_at', pii: true },
  company_vehicles:    { cols: 'id,rego,model,due_service_km,updated_at', wm: 'updated_at' },
  company_allocations: { cols: 'id,driver_name,driver_email,vehicle_id,updated_at', wm: 'updated_at', pii: true },
  prestarts:           { cols: 'id,user_id,month_key,items,notes,mex_number,fault_completed,submitted_at,updated_at', wm: 'updated_at' },
  km_log:              { cols: 'id,user_id,month_key,odometer,submitted_at', wm: 'submitted_at' },
  incidents:           { cols: 'id,user_id,name,licence,email,submitted_at,description,weather,weather_other,road_surface,speed_limit,visibility,third_party', wm: 'submitted_at', pii: true },
  policy_document:     { cols: 'id,filename,size,uploaded_at,uploaded_by', wm: 'uploaded_at' }, // metadata only, never the PDF
  audit_log:           { cols: 'id,at,actor,action,entity,entity_id,detail', wm: 'at' },
  deleted_records:     { cols: 'id,entity,entity_id,deleted_at', wm: 'deleted_at' },
};

const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 1000;

const keys = () => [config.dataApiKey, config.dataApiKeyNext].filter(Boolean);

function keyMatches(presented) {
  const a = crypto.createHash('sha256').update(presented).digest();
  return keys().some(k => crypto.timingSafeEqual(a, crypto.createHash('sha256').update(k).digest()));
}

function requireDataKey(req, res, next) {
  if (keys().length === 0) return next(new HttpError(404, 'Data export is not enabled.'));
  const header = String(req.headers.authorization || '');
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-api-key'] || '');
  const throttleKey = `export|${req.ip}`;
  throttleCheck(throttleKey);
  if (!presented || !keyMatches(presented)) {
    throttleFail(throttleKey);
    log('warn', 'export auth failed', { ip: req.ip });
    return next(new HttpError(401, 'Invalid or missing API key.'));
  }
  throttleClear(throttleKey);
  next();
}

export function exportRoutes(db) {
  const r = Router();
  r.use('/export/v1', requireDataKey);

  const schemaVersion = () => db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;

  // Everything a pipeline needs to discover the platform: datasets, columns, keys, watermarks, counts.
  r.get('/export/v1/manifest', (req, res) => {
    const datasets = Object.entries(DATASETS).map(([name, d]) => ({
      name,
      primaryKey: 'id',
      watermarkColumn: d.wm,
      containsPersonalData: !!d.pii,
      columns: d.cols.split(','),
      rowCount: db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n,
    }));
    res.json({
      platform: config.platformName,
      version: config.version,
      env: config.appEnv,
      schemaVersion: schemaVersion(),
      serverTime: nowIso(),
      datasets,
    });
  });

  // GET /export/v1/<dataset>?updatedSince=<ISO>&cursor=<id>&limit=<n>
  r.get('/export/v1/:dataset', (req, res) => {
    const def = DATASETS[req.params.dataset];
    if (!def) throw new HttpError(404, 'Unknown dataset.');

    const since = req.query.updatedSince ? new Date(String(req.query.updatedSince)) : null;
    if (since && Number.isNaN(since.getTime())) throw new HttpError(400, 'updatedSince must be an ISO date-time.');
    const cursor = req.query.cursor === undefined || req.query.cursor === '' ? 0 : Number(req.query.cursor);
    if (!Number.isInteger(cursor) || cursor < 0) throw new HttpError(400, 'cursor must come from a previous nextCursor.');
    const limit = req.query.limit === undefined ? DEFAULT_LIMIT : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new HttpError(400, `limit must be 1–${MAX_LIMIT}.`);

    const extractedAt = nowIso();
    const rows = db.prepare(
      `SELECT ${def.cols} FROM ${req.params.dataset}
       WHERE id > @cursor AND (@since IS NULL OR ${def.wm} > @since)
       ORDER BY id LIMIT @limit`
    ).all({ cursor, since: since ? since.toISOString() : null, limit: limit + 1 });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    log('info', 'export', { dataset: req.params.dataset, rows: data.length, incremental: !!since, ip: req.ip });
    res.json({
      platform: config.platformName,
      dataset: req.params.dataset,
      extractedAt,
      count: data.length,
      hasMore,
      nextCursor: hasMore ? data[data.length - 1].id : null,
      data,
    });
  });

  return r;
}
