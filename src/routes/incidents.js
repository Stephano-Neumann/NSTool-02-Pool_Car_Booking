import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { HttpError, nowIso, text } from '../util.js';
import { photosByOwner } from './photos.js';

const WEATHER = ['Dry / Sunny', 'Wet / Raining', 'Foggy', 'Overcast', 'Other'];
const ROAD = ['Sealed / Asphalt', 'Gravel', 'Dirt', 'Uneven', 'Muddy / Boggy'];
const VISIBILITY = ['Clear', 'Drastically Reduced', 'Night (Streetlights ON)', 'Night (Streetlights OFF)'];
const TP_FIELDS = ['name', 'phone', 'email', 'licence', 'rego', 'vehicle', 'insurer', 'policy'];

const incidentOut = (i, photos = [], viewer = null) => ({
  id: i.id, name: i.name, license: i.licence, email: i.email, submittedAt: i.submitted_at,
  address: i.address, photos, mine: viewer ? i.user_id === viewer.id : false,
  description: i.description, weather: i.weather, weatherOther: i.weather_other,
  roadSurface: i.road_surface, speedLimit: i.speed_limit, visibility: i.visibility,
  thirdParty: JSON.parse(i.third_party),
});

// A blank value is allowed; anything chosen must be one of the form's options.
function oneOf(value, options, label) {
  const v = typeof value === 'string' ? value : '';
  if (v && !options.includes(v)) throw new HttpError(400, `${label} is not a valid option.`);
  return v;
}

export function incidentRoutes(db) {
  const r = Router();

  r.get('/incidents', requireAuth, (req, res) => {
    // ?mine=1 gives admins the same own-reports-only list a regular user gets (the user view).
    const rows = req.user.role === 'admin' && req.query.mine !== '1'
      ? db.prepare('SELECT * FROM incidents ORDER BY submitted_at DESC').all()
      : db.prepare('SELECT * FROM incidents WHERE user_id = ? ORDER BY submitted_at DESC').all(req.user.id);
    const photos = photosByOwner(db, 'incident', rows.map(i => i.id));
    res.json(rows.map(i => incidentOut(i, photos.get(i.id), req.user)));
  });

  r.post('/incidents', requireAuth, (req, res) => {
    const b = req.body || {};
    const address = text(b.address, 'Address of the incident', { max: 300 });
    const description = text(b.description, 'Description of the incident', { max: 4000 });
    const weather = oneOf(b.weather, WEATHER, 'Weather');
    const weatherOther = weather === 'Other' ? text(b.weatherOther, 'Weather description', { optional: true, max: 200 }) : '';
    const speedLimit = text(String(b.speedLimit ?? ''), 'Speed limit', { optional: true, max: 10 });
    if (speedLimit && !/^\d{1,3}$/.test(speedLimit)) throw new HttpError(400, 'Speed limit must be a number.');
    const thirdParty = {};
    for (const f of TP_FIELDS) thirdParty[f] = text(b.thirdParty?.[f], f, { optional: true, max: 200 });

    const id = db.prepare(`INSERT INTO incidents (user_id, name, licence, email, submitted_at, address, description, weather,
                             weather_other, road_surface, speed_limit, visibility, third_party)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, req.user.name, req.user.licence, req.user.email, nowIso(), address, description, weather, weatherOther,
        oneOf(b.roadSurface, ROAD, 'Road surface'), speedLimit, oneOf(b.visibility, VISIBILITY, 'Visibility'),
        JSON.stringify(thirdParty)).lastInsertRowid;
    res.status(201).json(incidentOut(db.prepare('SELECT * FROM incidents WHERE id = ?').get(id), [], req.user));
  });

  return r;
}
