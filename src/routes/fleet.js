import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { triggerBookingAlert } from '../alerts.js';
import { HttpError, nowIso, text, email, wholeNumber, isoDate } from '../util.js';
import { audit } from '../audit.js';

const vehicleOut = (v) => ({ id: v.id, rego: v.rego, model: v.model, archived: !!v.archived });

// Drivers see their own bookings in full. Everyone else's bookings reach them
// as anonymous time blocks, so the availability board works without leaking who is driving.
function bookingOut(b, viewer) {
  const mine = b.user_id === viewer.id;
  const out = {
    id: b.id, vehicleId: b.vehicle_id, use: b.use_type, pickup: b.pickup, ret: b.ret,
    status: b.status, mine,
  };
  if (!mine && viewer.role !== 'admin') return out;
  return {
    ...out,
    driverName: b.driver_name, license: b.licence, email: b.email,
    department: b.department, costCentre: b.cost_centre,
    createdAt: b.created_at, reviewedAt: b.reviewed_at,
    actualPickup: b.actual_pickup, actualReturn: b.actual_return,
    startKm: b.start_km, finishKm: b.finish_km,
    startNotes: b.start_notes, finishNotes: b.finish_notes,
    fuelOk: b.fuel_ok === null ? null : !!b.fuel_ok,
  };
}

export function fleetRoutes(db) {
  const r = Router();

  // ---- vehicles ----
  r.get('/vehicles', requireAuth, (req, res) => {
    const rows = req.user.role === 'admin'
      ? db.prepare('SELECT * FROM vehicles ORDER BY rego').all()
      : db.prepare('SELECT * FROM vehicles WHERE archived = 0 ORDER BY rego').all();
    res.json(rows.map(vehicleOut));
  });

  function vehicleFields(body, id) {
    const rego = text(body?.rego, 'Registration', { max: 20 });
    const model = text(body?.model, 'Vehicle description', { max: 200 });
    const dupe = db.prepare('SELECT id FROM vehicles WHERE rego = ? AND id != ?').get(rego, id || 0);
    if (dupe) throw new HttpError(409, 'That registration is already in the fleet.');
    return { rego, model };
  }

  r.post('/vehicles', requireAdmin, (req, res) => {
    const { rego, model } = vehicleFields(req.body);
    const id = db.prepare('INSERT INTO vehicles (rego, model) VALUES (?, ?)').run(rego, model).lastInsertRowid;
    audit(db, req, 'create', 'vehicle', id, rego);
    res.status(201).json(vehicleOut(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id)));
  });

  r.put('/vehicles/:id', requireAdmin, (req, res) => {
    const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
    if (!v) throw new HttpError(404, 'Vehicle not found.');
    const { rego, model } = vehicleFields(req.body, v.id);
    db.prepare('UPDATE vehicles SET rego = ?, model = ? WHERE id = ?').run(rego, model, v.id);
    audit(db, req, 'update', 'vehicle', v.id, rego);
    res.json(vehicleOut(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(v.id)));
  });

  r.post('/vehicles/:id/archive', requireAdmin, (req, res) => setArchived(req, res, true));
  r.post('/vehicles/:id/restore', requireAdmin, (req, res) => setArchived(req, res, false));
  function setArchived(req, res, archived) {
    const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
    if (!v) throw new HttpError(404, 'Vehicle not found.');
    db.prepare('UPDATE vehicles SET archived = ?, archived_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, archived ? nowIso() : null, v.id);
    audit(db, req, archived ? 'archive' : 'restore', 'vehicle', v.id, v.rego);
    res.json(vehicleOut(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(v.id)));
  }

  // ---- bookings ----
  r.get('/bookings', requireAuth, (req, res) => {
    const rows = db.prepare("SELECT * FROM bookings WHERE status != 'declined' OR user_id = ? OR ? = 'admin' ORDER BY pickup")
      .all(req.user.id, req.user.role);
    res.json(rows.map(b => bookingOut(b, req.user)));
  });

  function findOverlap(vehicleId, pickup, ret, excludeId = 0) {
    return db.prepare(`SELECT * FROM bookings WHERE vehicle_id = ? AND id != ? AND status != 'declined'
                       AND pickup < ? AND ret > ?`).get(vehicleId, excludeId, ret, pickup);
  }

  r.post('/bookings', requireAuth, (req, res) => {
    const b = req.body || {};
    const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND archived = 0').get(Number(b.vehicleId));
    if (!vehicle) throw new HttpError(400, 'Choose an available vehicle.');
    const department = text(b.department, 'Department', { max: 100 });
    const costCentre = text(b.costCentre, 'Cost centre', { max: 50 });
    const use = b.use === 'Private' ? 'Private' : b.use === 'Business' ? 'Business' : null;
    if (!use) throw new HttpError(400, 'Choose business or private use.');
    const pickup = isoDate(b.pickup, 'Pick up time');
    const ret = isoDate(b.ret, 'Return time');
    if (new Date(ret) <= new Date(pickup)) throw new HttpError(400, 'Return time must be after pick up time.');

    let driverName, licence, mail, userId;
    if (req.user.role === 'admin') {
      // Admins can book on behalf of someone who isn't signed in.
      driverName = text(b.driverName, 'Driver name', { max: 120 });
      licence = text(b.license, "Driver's licence #", { max: 40 });
      mail = b.email ? email(b.email) : null;
      userId = null;
    } else {
      if (!req.user.licence) throw new HttpError(400, "Add your driver's licence number to your profile before booking.");
      ({ name: driverName, licence, email: mail } = req.user);
      userId = req.user.id;
    }

    const id = db.transaction(() => {
      const conflict = findOverlap(vehicle.id, pickup, ret);
      if (conflict) {
        throw new HttpError(409, `${vehicle.rego} is already booked for part of that time. Choose a different vehicle or time.`);
      }
      return db.prepare(`INSERT INTO bookings (vehicle_id, user_id, driver_name, licence, email, department, cost_centre,
                           use_type, pickup, ret, status, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(vehicle.id, userId, driverName, licence, mail, department, costCentre, use, pickup, ret, nowIso()).lastInsertRowid;
    })();
    const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    triggerBookingAlert(db, 'created', row).catch(() => {});
    res.status(201).json(bookingOut(row, req.user));
  });

  r.post('/bookings/:id/review', requireAdmin, (req, res) => {
    const decision = req.body?.decision;
    if (!['approved', 'declined'].includes(decision)) throw new HttpError(400, 'Decision must be approved or declined.');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!b) throw new HttpError(404, 'Booking not found.');
    if (b.status !== 'pending') throw new HttpError(409, 'That booking has already been reviewed.');
    db.prepare('UPDATE bookings SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?')
      .run(decision, nowIso(), req.user.id, b.id);
    audit(db, req, decision, 'booking', b.id, b.driver_name);
    const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
    if (decision === 'approved') triggerBookingAlert(db, 'approved', row).catch(() => {});
    res.json(bookingOut(row, req.user));
  });

  r.delete('/bookings/:id', requireAdmin, (req, res) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!b) throw new HttpError(404, 'Booking not found.');
    db.prepare('DELETE FROM bookings WHERE id = ?').run(b.id);
    audit(db, req, 'cancel', 'booking', b.id, `${b.driver_name} ${b.pickup}`);
    res.json({ ok: true });
  });

  // Trip log: only the driver who made the booking, and only once it is approved.
  r.put('/bookings/:id/trip', requireAuth, (req, res) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!b || b.user_id !== req.user.id) throw new HttpError(404, 'Booking not found.');
    if (b.status !== 'approved') throw new HttpError(409, 'The booking must be approved before logging a trip.');
    const t = req.body || {};
    const next = {
      actual_pickup: b.actual_pickup, actual_return: b.actual_return, start_km: b.start_km,
      finish_km: b.finish_km, start_notes: b.start_notes, finish_notes: b.finish_notes, fuel_ok: b.fuel_ok,
    };
    if (t.actualPickup !== undefined) {
      next.actual_pickup = isoDate(t.actualPickup, 'Start time');
      next.start_km = wholeNumber(t.startKm, 'Start odometer');
      next.start_notes = text(t.startNotes, 'Start notes', { optional: true, max: 1000 });
    }
    if (t.actualReturn !== undefined) {
      if (next.actual_pickup === null) throw new HttpError(409, 'Start the trip before finishing it.');
      next.actual_return = isoDate(t.actualReturn, 'Finish time');
      next.finish_km = wholeNumber(t.finishKm, 'Finish odometer');
      next.finish_notes = text(t.finishNotes, 'Finish notes', { optional: true, max: 1000 });
      if (typeof t.fuelOk !== 'boolean') throw new HttpError(400, 'Confirm whether the car has at least a quarter tank of fuel.');
      next.fuel_ok = t.fuelOk ? 1 : 0;
      if (new Date(next.actual_return) <= new Date(next.actual_pickup)) {
        throw new HttpError(400, 'Actual finish time must be after the actual start time.');
      }
      if (next.finish_km <= next.start_km) {
        throw new HttpError(400, `Finish odometer reading must be greater than the start reading (${next.start_km} km).`);
      }
    }
    db.prepare(`UPDATE bookings SET actual_pickup = ?, actual_return = ?, start_km = ?, finish_km = ?,
                  start_notes = ?, finish_notes = ?, fuel_ok = ? WHERE id = ?`)
      .run(next.actual_pickup, next.actual_return, next.start_km, next.finish_km,
        next.start_notes, next.finish_notes, next.fuel_ok, b.id);
    res.json(bookingOut(db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id), req.user));
  });

  // ---- drivers (admin) ----
  r.get('/drivers', requireAdmin, (req, res) => {
    const rows = db.prepare(`
      SELECT u.id, u.name, u.email, u.licence, u.policy_ack_at, u.active,
             COUNT(b.id) AS bookings,
             COALESCE(SUM(CASE WHEN b.start_km IS NOT NULL AND b.finish_km IS NOT NULL THEN b.finish_km - b.start_km END), 0) AS total_km
      FROM users u LEFT JOIN bookings b ON b.user_id = u.id
      WHERE u.role = 'driver' GROUP BY u.id ORDER BY u.name`).all();
    res.json(rows.map(d => ({
      id: d.id, name: d.name, email: d.email, license: d.licence, active: !!d.active,
      policyAckAt: d.policy_ack_at, bookings: d.bookings, totalKm: d.total_km,
    })));
  });

  return r;
}
