import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { HttpError, nowIso, text, email, wholeNumber, currentMonthKey } from '../util.js';
import { audit } from '../audit.js';

export const PRESTART_ITEM_IDS = ['tyres', 'lights', 'brakes', 'fluids', 'mirrors', 'presentable', 'dents'];

const vehicleOut = (v) => ({
  id: v.id, rego: v.rego, model: v.model, dueServiceKm: v.due_service_km,
});
const prestartOut = (p) => p ? {
  id: p.id, monthKey: p.month_key, items: JSON.parse(p.items), notes: p.notes,
  mexNumber: p.mex_number, faultCompleted: !!p.fault_completed, submittedAt: p.submitted_at,
} : null;

export function companyCarRoutes(db) {
  const r = Router();

  // ---- company vehicle register (admin) ----
  r.get('/company-vehicles', requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT * FROM company_vehicles ORDER BY rego').all().map(vehicleOut));
  });

  function vehicleFields(body, id) {
    const rego = text(body?.rego, 'Registration', { max: 20 });
    const model = text(body?.model, 'Vehicle description', { max: 200 });
    const dueServiceKm = wholeNumber(body?.dueServiceKm, 'Due service (km)', { optional: true });
    if (db.prepare('SELECT 1 FROM company_vehicles WHERE rego = ? AND id != ?').get(rego, id || 0)) {
      throw new HttpError(409, 'That registration is already registered.');
    }
    return { rego, model, dueServiceKm };
  }
  r.post('/company-vehicles', requireAdmin, (req, res) => {
    const f = vehicleFields(req.body);
    const id = db.prepare('INSERT INTO company_vehicles (rego, model, due_service_km) VALUES (?, ?, ?)')
      .run(f.rego, f.model, f.dueServiceKm).lastInsertRowid;
    audit(db, req, 'create', 'company_vehicle', id, f.rego);
    res.status(201).json(vehicleOut(db.prepare('SELECT * FROM company_vehicles WHERE id = ?').get(id)));
  });
  r.put('/company-vehicles/:id', requireAdmin, (req, res) => {
    const f = vehicleFields(req.body, Number(req.params.id));
    const info = db.prepare('UPDATE company_vehicles SET rego = ?, model = ?, due_service_km = ? WHERE id = ?')
      .run(f.rego, f.model, f.dueServiceKm, req.params.id);
    if (!info.changes) throw new HttpError(404, 'Vehicle not found.');
    audit(db, req, 'update', 'company_vehicle', req.params.id, f.rego);
    res.json(vehicleOut(db.prepare('SELECT * FROM company_vehicles WHERE id = ?').get(req.params.id)));
  });
  r.delete('/company-vehicles/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM company_vehicles WHERE id = ?').run(req.params.id);
    audit(db, req, 'delete', 'company_vehicle', req.params.id);
    res.json({ ok: true });
  });

  // ---- allocations (admin) — matched to a driver by email ----
  const allocationOut = (a) => ({ id: a.id, name: a.driver_name, email: a.driver_email, vehicleId: a.vehicle_id });
  r.get('/company-allocations', requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT * FROM company_allocations ORDER BY driver_name').all().map(allocationOut));
  });
  function allocationFields(body, id) {
    const name = text(body?.name, 'Driver name', { max: 120 });
    const mail = email(body?.email, 'Driver email');
    const vehicleId = Number(body?.vehicleId);
    if (!db.prepare('SELECT 1 FROM company_vehicles WHERE id = ?').get(vehicleId)) {
      throw new HttpError(400, 'Add a company vehicle first, then allocate it to a driver.');
    }
    if (db.prepare('SELECT 1 FROM company_allocations WHERE driver_email = ? AND id != ?').get(mail, id || 0)) {
      throw new HttpError(409, 'That driver already has a company car allocated.');
    }
    return { name, mail, vehicleId };
  }
  r.post('/company-allocations', requireAdmin, (req, res) => {
    const f = allocationFields(req.body);
    const id = db.prepare('INSERT INTO company_allocations (driver_name, driver_email, vehicle_id) VALUES (?, ?, ?)')
      .run(f.name, f.mail, f.vehicleId).lastInsertRowid;
    audit(db, req, 'create', 'allocation', id, f.mail);
    res.status(201).json(allocationOut(db.prepare('SELECT * FROM company_allocations WHERE id = ?').get(id)));
  });
  r.put('/company-allocations/:id', requireAdmin, (req, res) => {
    const f = allocationFields(req.body, Number(req.params.id));
    const info = db.prepare('UPDATE company_allocations SET driver_name = ?, driver_email = ?, vehicle_id = ? WHERE id = ?')
      .run(f.name, f.mail, f.vehicleId, req.params.id);
    if (!info.changes) throw new HttpError(404, 'Allocation not found.');
    audit(db, req, 'update', 'allocation', req.params.id, f.mail);
    res.json(allocationOut(db.prepare('SELECT * FROM company_allocations WHERE id = ?').get(req.params.id)));
  });
  r.delete('/company-allocations/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM company_allocations WHERE id = ?').run(req.params.id);
    audit(db, req, 'delete', 'allocation', req.params.id);
    res.json({ ok: true });
  });

  // ---- the signed-in driver's own company car ----
  r.get('/company-car/me', requireAuth, (req, res) => {
    const monthKey = currentMonthKey();
    const alloc = db.prepare('SELECT * FROM company_allocations WHERE driver_email = ?').get(req.user.email);
    const vehicle = alloc && db.prepare('SELECT * FROM company_vehicles WHERE id = ?').get(alloc.vehicle_id);
    const prestart = db.prepare('SELECT * FROM prestarts WHERE user_id = ? AND month_key = ?').get(req.user.id, monthKey);
    const km = db.prepare('SELECT month_key, odometer, submitted_at FROM km_log WHERE user_id = ? ORDER BY month_key DESC').all(req.user.id);
    res.json({
      monthKey,
      vehicle: vehicle ? vehicleOut(vehicle) : null,
      prestart: prestartOut(prestart),
      km: km.map(k => ({ monthKey: k.month_key, odometer: k.odometer, submittedAt: k.submitted_at })),
    });
  });

  r.post('/company-car/prestart', requireAuth, (req, res) => {
    const monthKey = currentMonthKey();
    if (!db.prepare('SELECT 1 FROM company_allocations WHERE driver_email = ?').get(req.user.email)) {
      throw new HttpError(409, 'No company car is allocated to you.');
    }
    if (db.prepare('SELECT 1 FROM prestarts WHERE user_id = ? AND month_key = ?').get(req.user.id, monthKey)) {
      throw new HttpError(409, 'This month’s prestart check has already been submitted.');
    }
    const items = {};
    for (const id of PRESTART_ITEM_IDS) items[id] = req.body?.items?.[id] === true;
    const hasFault = Object.values(items).some(v => !v);
    const notes = text(req.body?.notes, 'Notes', { optional: true, max: 2000 });
    const mex = hasFault ? text(req.body?.mexNumber, 'Mex #', { optional: true, max: 50 }) : '';
    const faultCompleted = hasFault && req.body?.faultCompleted === true;
    db.prepare(`INSERT INTO prestarts (user_id, month_key, items, notes, mex_number, fault_completed, submitted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, monthKey, JSON.stringify(items), notes, mex, faultCompleted ? 1 : 0, nowIso());
    res.status(201).json(prestartOut(db.prepare('SELECT * FROM prestarts WHERE user_id = ? AND month_key = ?').get(req.user.id, monthKey)));
  });

  r.post('/company-car/km', requireAuth, (req, res) => {
    const monthKey = currentMonthKey();
    if (!db.prepare('SELECT 1 FROM company_allocations WHERE driver_email = ?').get(req.user.email)) {
      throw new HttpError(409, 'No company car is allocated to you.');
    }
    if (db.prepare('SELECT 1 FROM km_log WHERE user_id = ? AND month_key = ?').get(req.user.id, monthKey)) {
      throw new HttpError(409, 'This month’s reading has already been recorded.');
    }
    const odometer = wholeNumber(req.body?.odometer, 'Odometer reading');
    const last = db.prepare('SELECT odometer FROM km_log WHERE user_id = ? ORDER BY month_key DESC LIMIT 1').get(req.user.id);
    if (last && odometer < last.odometer) {
      throw new HttpError(400, `That reading is lower than last month’s recorded figure (${last.odometer} km) — check the number.`);
    }
    db.prepare('INSERT INTO km_log (user_id, month_key, odometer, submitted_at) VALUES (?, ?, ?, ?)')
      .run(req.user.id, monthKey, odometer, nowIso());
    res.status(201).json({ monthKey, odometer });
  });

  // ---- this month's activity across all allocations (admin) ----
  r.get('/company-car/activity', requireAdmin, (req, res) => {
    const monthKey = currentMonthKey();
    const rows = db.prepare(`
      SELECT a.id AS allocation_id, a.driver_name, a.driver_email, cv.rego, u.id AS user_id
      FROM company_allocations a
      JOIN company_vehicles cv ON cv.id = a.vehicle_id
      LEFT JOIN users u ON u.email = a.driver_email
      ORDER BY a.driver_name`).all();
    res.json(rows.map(a => {
      const prestart = a.user_id && db.prepare('SELECT * FROM prestarts WHERE user_id = ? AND month_key = ?').get(a.user_id, monthKey);
      const km = a.user_id && db.prepare('SELECT odometer FROM km_log WHERE user_id = ? AND month_key = ?').get(a.user_id, monthKey);
      return {
        allocationId: a.allocation_id, name: a.driver_name, rego: a.rego,
        prestart: prestartOut(prestart) || null, odometer: km ? km.odometer : null,
      };
    }));
  });

  r.patch('/prestarts/:id', requireAdmin, (req, res) => {
    const p = db.prepare('SELECT * FROM prestarts WHERE id = ?').get(req.params.id);
    if (!p) throw new HttpError(404, 'Prestart not found.');
    const mex = req.body?.mexNumber !== undefined ? text(req.body.mexNumber, 'Mex #', { optional: true, max: 50 }) : p.mex_number;
    const done = req.body?.faultCompleted !== undefined ? (req.body.faultCompleted === true ? 1 : 0) : p.fault_completed;
    db.prepare('UPDATE prestarts SET mex_number = ?, fault_completed = ? WHERE id = ?').run(mex, done, p.id);
    audit(db, req, 'update', 'prestart', p.id, `mex=${mex} completed=${done}`);
    res.json(prestartOut(db.prepare('SELECT * FROM prestarts WHERE id = ?').get(p.id)));
  });

  return r;
}
