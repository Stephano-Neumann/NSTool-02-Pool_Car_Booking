import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEED_TEST_DATA = 'true';
process.env.APP_ENV = 'local';
process.env.DATA_API_KEY = 'test-export-key';

const { config, assertSafeConfig, TEST_PASSWORD } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { seedDefaultFleet, seedTestData, TEST_ACCOUNTS } = await import('../src/seed.js');

let db, server, base;

before(async () => {
  db = openDb(':memory:');
  seedDefaultFleet(db);
  await seedTestData(db);
  server = createApp(db).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

// Minimal client with a cookie jar.
function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
        'X-Requested-By': 'nst-app', ...(cookie ? { Cookie: cookie } : {}), ...headers,
      },
      body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  return {
    get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p), patch: (p, b) => call('PATCH', p, b), raw: call,
    login: async (email, password = TEST_PASSWORD) => call('POST', '/api/auth/login', { email, password }),
  };
}
const loggedIn = async (email) => { const c = client(); const r = await c.login(email); assert.equal(r.status, 200, `login ${email}`); return c; };
const E = (name) => `${name}@neumannsteel.test`;

test('health check is public', async () => {
  const r = await client().get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

test('every seeded test account signs in with the shared password, except the disabled one', async () => {
  for (const a of TEST_ACCOUNTS) {
    const r = await client().login(a.email);
    if (a.active === 0) assert.equal(r.status, 403, a.email);
    else {
      assert.equal(r.status, 200, a.email);
      assert.equal(r.body.role, a.role);
    }
  }
});

test('wrong password and unknown email are both 401', async () => {
  assert.equal((await client().login(E('admin'), 'nope')).status, 401);
  assert.equal((await client().login('ghost@neumannsteel.test')).status, 401);
});

test('API requires sign-in and the CSRF header', async () => {
  assert.equal((await client().get('/api/bookings')).status, 401);
  const noHeader = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: E('admin'), password: TEST_PASSWORD }),
  });
  assert.equal(noHeader.status, 403);
});

test('logout ends the session', async () => {
  const c = await loggedIn(E('driver.pool'));
  assert.equal((await c.get('/api/me')).status, 200);
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/me')).status, 401);
});

test('drivers cannot reach admin endpoints', async () => {
  const c = await loggedIn(E('driver.pool'));
  for (const p of ['/api/drivers', '/api/admin-profiles', '/api/alerts', '/api/company-vehicles', '/api/company-car/activity']) {
    assert.equal((await c.get(p)).status, 403, p);
  }
  assert.equal((await c.post('/api/vehicles', { rego: 'X-1', model: 'Y' })).status, 403);
  assert.equal((await c.post('/api/bookings/1/review', { decision: 'approved' })).status, 403);
});

test('the board shows other drivers’ bookings without names; admin sees everything', async () => {
  const pool = await loggedIn(E('driver.pool'));
  const { body } = await pool.get('/api/bookings');
  const mine = body.filter(b => b.mine);
  const others = body.filter(b => !b.mine);
  assert.ok(mine.length >= 5 && others.length >= 2);
  for (const o of others) {
    assert.equal(o.driverName, undefined);
    assert.equal(o.department, undefined);
    assert.equal(o.email, undefined);
  }
  assert.ok(mine.some(b => b.status === 'declined'), 'own declined booking is visible to its owner');
  assert.ok(!others.some(b => b.status === 'declined'));

  const admin = await loggedIn(E('admin'));
  const all = (await admin.get('/api/bookings')).body;
  assert.ok(all.every(b => b.driverName));
  assert.ok(all.length > body.length - 1);
});

test('booking flow: create, overlap rejected, admin approves, driver logs trip', async () => {
  const pool = await loggedIn(E('driver.pool'));
  const vehicles = (await pool.get('/api/vehicles')).body;
  const v = vehicles[4]; // NST-05, only has a declined booking
  const pickup = new Date(Date.now() + 20 * 86400_000).toISOString();
  const ret = new Date(Date.now() + 20 * 86400_000 + 4 * 3600_000).toISOString();
  const payload = { vehicleId: v.id, department: 'Sales', costCentre: 'CC-1', use: 'Business', pickup, ret };

  const created = await pool.post('/api/bookings', payload);
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'pending');
  assert.equal(created.body.driverName, 'Paul Pool');

  const clash = await pool.post('/api/bookings', payload);
  assert.equal(clash.status, 409);

  assert.equal((await pool.post('/api/bookings', { ...payload, ret: pickup })).status, 400);

  const tripEarly = await pool.put(`/api/bookings/${created.body.id}/trip`, { actualPickup: pickup, startKm: 100 });
  assert.equal(tripEarly.status, 409, 'cannot log a trip before approval');

  const admin = await loggedIn(E('admin'));
  const reviewed = await admin.post(`/api/bookings/${created.body.id}/review`, { decision: 'approved' });
  assert.equal(reviewed.status, 200);
  assert.equal((await admin.post(`/api/bookings/${created.body.id}/review`, { decision: 'declined' })).status, 409);

  const start = await pool.put(`/api/bookings/${created.body.id}/trip`, { actualPickup: pickup, startKm: 1000, startNotes: 'ok' });
  assert.equal(start.status, 200);
  const badFinish = await pool.put(`/api/bookings/${created.body.id}/trip`, { actualReturn: ret, finishKm: 900, fuelOk: true });
  assert.equal(badFinish.status, 400);
  const noFuel = await pool.put(`/api/bookings/${created.body.id}/trip`, { actualReturn: ret, finishKm: 1100 });
  assert.equal(noFuel.status, 400);
  const finish = await pool.put(`/api/bookings/${created.body.id}/trip`, { actualReturn: ret, finishKm: 1100, fuelOk: false, finishNotes: 'chip' });
  assert.equal(finish.status, 200);
  assert.equal(finish.body.fuelOk, false);

  const other = await loggedIn(E('driver.pool2'));
  assert.equal((await other.put(`/api/bookings/${created.body.id}/trip`, { actualPickup: pickup, startKm: 1 })).status, 404);

  assert.equal((await admin.del(`/api/bookings/${created.body.id}`)).status, 200);
});

test('new driver must add a licence before booking, and acknowledges the policy', async () => {
  const c = await loggedIn(E('driver.new'));
  const me = (await c.get('/api/me')).body;
  assert.equal(me.profileComplete, false);
  assert.equal(me.policyAcked, false);
  const vehicles = (await c.get('/api/vehicles')).body;
  const pickup = new Date(Date.now() + 40 * 86400_000).toISOString();
  const ret = new Date(Date.now() + 40 * 86400_000 + 3600_000).toISOString();
  const body = { vehicleId: vehicles[0].id, department: 'IT', costCentre: 'CC', use: 'Business', pickup, ret };
  assert.equal((await c.post('/api/bookings', body)).status, 400);
  assert.equal((await c.put('/api/me', { name: 'Nina New', licence: '' })).status, 400);
  assert.equal((await c.put('/api/me', { name: 'Nina New', licence: 'QLD7777777' })).body.profileComplete, true);
  assert.equal((await c.post('/api/me/policy-ack')).body.policyAcked, true);
  const ok = await c.post('/api/bookings', body);
  assert.equal(ok.status, 201);
  await (await loggedIn(E('admin'))).del(`/api/bookings/${ok.body.id}`);
});

test('policy PDF: any user reads it, only admin changes it, non-PDF rejected', async () => {
  const driver = await loggedIn(E('driver.pool'));
  const meta = await driver.get('/api/policy');
  assert.equal(meta.status, 200);
  assert.equal((await fetch(`${base}/api/policy/file`)).status, 401, 'not signed in');

  const admin = await loggedIn(E('admin'));
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const asDriver = await driver.raw('PUT', '/api/policy', pdf, { 'Content-Type': 'application/pdf', 'X-Filename': 'x.pdf' });
  assert.equal(asDriver.status, 403);
  const bad = await admin.raw('PUT', '/api/policy', Buffer.from('not a pdf'), { 'Content-Type': 'application/pdf', 'X-Filename': 'x.pdf' });
  assert.equal(bad.status, 400);
  const good = await admin.raw('PUT', '/api/policy', pdf, { 'Content-Type': 'application/pdf', 'X-Filename': 'New%20Policy.pdf' });
  assert.equal(good.status, 200);
  assert.equal(good.body.filename, 'New Policy.pdf');
  const download = await driver.raw('GET', '/api/policy/file');
  assert.equal(download.status, 200);
});

test('company car: allocated driver sees the vehicle, submits prestart and km once', async () => {
  const none = await loggedIn(E('driver.nocar'));
  assert.equal((await none.get('/api/company-car/me')).body.vehicle, null);
  assert.equal((await none.post('/api/company-car/km', { odometer: 5 })).status, 409);

  const c = await loggedIn(E('driver.companycar'));
  const me = (await c.get('/api/company-car/me')).body;
  assert.equal(me.vehicle.rego, 'NST-C01');
  assert.equal(me.prestart, null);
  assert.equal((await c.post('/api/company-car/km', { odometer: 60000 })).status, 400, 'lower than last month');
  assert.equal((await c.post('/api/company-car/km', { odometer: 64500 })).status, 201);
  assert.equal((await c.post('/api/company-car/km', { odometer: 64600 })).status, 409);
  const items = { tyres: true, lights: true, brakes: false, fluids: true, mirrors: true, presentable: true, dents: true };
  const ps = await c.post('/api/company-car/prestart', { items, notes: 'brake squeal', mexNumber: 'MEX-1' });
  assert.equal(ps.status, 201);
  assert.equal(ps.body.items.brakes, false);
  assert.equal((await c.post('/api/company-car/prestart', { items })).status, 409);

  const admin = await loggedIn(E('admin'));
  const activity = (await admin.get('/api/company-car/activity')).body;
  const row = activity.find(a => a.name === 'Chris Company');
  assert.equal(row.odometer, 64500);
  const patched = await admin.patch(`/api/prestarts/${ps.body.id}`, { faultCompleted: true, mexNumber: 'MEX-2' });
  assert.equal(patched.body.faultCompleted, true);
  assert.equal(patched.body.mexNumber, 'MEX-2');
});

test('incidents: drivers see only their own, admin sees all', async () => {
  const ivy = await loggedIn(E('driver.incident'));
  assert.equal((await ivy.get('/api/incidents')).body.length, 2);
  assert.equal((await (await loggedIn(E('driver.pool'))).get('/api/incidents')).body.length, 0);
  const created = await ivy.post('/api/incidents', {
    description: 'Test', weather: 'Other', weatherOther: 'Hail', roadSurface: 'Gravel', speedLimit: '80',
    visibility: 'Clear', thirdParty: { name: 'Tess' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.thirdParty.name, 'Tess');
  assert.equal((await ivy.post('/api/incidents', { description: '' })).status, 400);
  assert.equal((await ivy.post('/api/incidents', { description: 'x', weather: 'Sandstorm' })).status, 400);
  assert.equal((await (await loggedIn(E('admin'))).get('/api/incidents')).body.length, 3);
});

test('fleet admin: add, duplicate rego, archive, restore', async () => {
  const admin = await loggedIn(E('admin'));
  const v = await admin.post('/api/vehicles', { rego: 'TEST-99', model: 'Test car' });
  assert.equal(v.status, 201);
  assert.equal((await admin.post('/api/vehicles', { rego: 'test-99', model: 'Dupe' })).status, 409);
  await admin.post(`/api/vehicles/${v.body.id}/archive`);
  const driverList = (await (await loggedIn(E('driver.pool'))).get('/api/vehicles')).body;
  assert.ok(!driverList.some(x => x.rego === 'TEST-99'));
  const restored = await admin.post(`/api/vehicles/${v.body.id}/restore`);
  assert.equal(restored.body.archived, false);
});

test('alert webhook only accepts public https URLs', async () => {
  const admin = await loggedIn(E('admin'));
  for (const url of ['http://example.com/x', 'https://localhost/x', 'https://10.0.0.5/x', 'not a url']) {
    assert.equal((await admin.put('/api/alerts/webhook', { url })).status, 400, url);
  }
  assert.equal((await admin.put('/api/alerts/webhook', { url: '' })).status, 200);
});

test('password change requires the current password', async () => {
  const c = await loggedIn(E('driver.nocar'));
  assert.equal((await c.post('/api/me/password', { currentPassword: 'wrong', newPassword: 'longenough1' })).status, 400);
  assert.equal((await c.post('/api/me/password', { currentPassword: TEST_PASSWORD, newPassword: 'short' })).status, 400);
  assert.equal((await c.post('/api/me/password', { currentPassword: TEST_PASSWORD, newPassword: 'longenough1' })).status, 200);
  assert.equal((await client().login(E('driver.nocar'))).status, 401);
  assert.equal((await client().login(E('driver.nocar'), 'longenough1')).status, 200);
  await c.post('/api/me/password', { currentPassword: 'longenough1', newPassword: TEST_PASSWORD });
});

test('gateway mode trusts the Easy Auth principal and maps the Entra role', async () => {
  config.authMode = 'gateway';
  try {
    const principal = (roles) => Buffer.from(JSON.stringify({
      auth_typ: 'aad', name_typ: 'name', role_typ: 'roles',
      claims: [{ typ: 'preferred_username', val: 'Gate.Way@neumann.com.au' }, { typ: 'name', val: 'Gate Way' },
        ...roles.map(r => ({ typ: 'roles', val: r }))],
    })).toString('base64');
    const c = client();
    assert.equal((await c.get('/api/me')).status, 401, 'no header, no user');
    const driver = await c.raw('GET', '/api/me', undefined, { 'X-MS-CLIENT-PRINCIPAL': principal([]) });
    assert.equal(driver.body.role, 'driver');
    assert.equal(driver.body.email, 'gate.way@neumann.com.au');
    const admin = await c.raw('GET', '/api/me', undefined, { 'X-MS-CLIENT-PRINCIPAL': principal(['Admin']) });
    assert.equal(admin.body.role, 'admin');
    assert.equal((await c.raw('GET', '/api/drivers', undefined, { 'X-MS-CLIENT-PRINCIPAL': principal([]) })).status, 403);
    assert.equal((await c.raw('GET', '/api/me', undefined, { 'X-MS-CLIENT-PRINCIPAL': 'garbage' })).status, 401);
    assert.equal((await client().login(E('admin'))).status, 404, 'password login is off in gateway mode');
  } finally {
    config.authMode = 'local';
  }
});

test('unsafe configuration is refused at startup', () => {
  const saved = { ...config };
  try {
    Object.assign(config, { appEnv: 'production', seedTestData: true, authMode: 'gateway' });
    assert.throws(() => assertSafeConfig(), /SEED_TEST_DATA/);
    Object.assign(config, { seedTestData: false, authMode: 'local', allowLocalAuthInProd: false });
    assert.throws(() => assertSafeConfig(), /AUTH_MODE=local/);
    Object.assign(config, { authMode: 'gateway' });
    assert.doesNotThrow(() => assertSafeConfig());
  } finally {
    Object.assign(config, saved);
  }
});

test('migrations are recorded and re-running is a no-op', () => {
  const rows = db.prepare('SELECT name FROM schema_migrations').all();
  assert.ok(rows.some(r => r.name === '001_init.sql'));
});

// ---- Data Export API (Fabric) ----
const KEY = { Authorization: 'Bearer test-export-key' };
const exp = (path, headers = KEY) => client().raw('GET', '/api/export/v1' + path, undefined, headers);

test('export: needs the API key; a signed-in admin session is not enough', async () => {
  assert.equal((await exp('/manifest', {})).status, 401);
  assert.equal((await exp('/manifest', { Authorization: 'Bearer wrong' })).status, 401);
  const admin = await loggedIn(E('admin'));
  assert.equal((await admin.get('/api/export/v1/manifest')).status, 401);
  assert.equal((await exp('/manifest', { 'X-Api-Key': 'test-export-key' })).status, 200);
});

test('export: disabled entirely when no key is configured', async () => {
  const saved = config.dataApiKey;
  config.dataApiKey = '';
  try { assert.equal((await exp('/manifest')).status, 404); } finally { config.dataApiKey = saved; }
});

test('export: manifest describes every dataset and never exposes secrets', async () => {
  const { body } = await exp('/manifest');
  assert.equal(body.platform, 'car-booking');
  const names = body.datasets.map(d => d.name);
  for (const n of ['users', 'bookings', 'vehicles', 'incidents', 'prestarts', 'km_log', 'deleted_records', 'audit_log']) {
    assert.ok(names.includes(n), n);
  }
  const all = body.datasets.flatMap(d => d.columns);
  assert.ok(!all.includes('password_hash') && !all.includes('data'), 'no password hashes or PDF blobs');
  assert.ok(!names.includes('sessions') && !names.includes('settings'), 'no sessions or settings');
  assert.ok(body.datasets.find(d => d.name === 'bookings').rowCount >= 10);
  const users = (await exp('/users')).body.data;
  assert.ok(users.length >= 9 && users.every(u => !('password_hash' in u)));
});

test('export: pages through a dataset with a cursor', async () => {
  const first = (await exp('/bookings?limit=4')).body;
  assert.equal(first.count, 4);
  assert.equal(first.hasMore, true);
  const second = (await exp(`/bookings?limit=4&cursor=${first.nextCursor}`)).body;
  assert.ok(second.data[0].id > first.data[3].id);
  let cursor = '', seen = 0, pages = 0;
  do {
    const p = (await exp(`/bookings?limit=3&cursor=${cursor}`)).body;
    seen += p.count; cursor = p.nextCursor ?? ''; pages++;
    if (!p.hasMore) assert.equal(p.nextCursor, null);
  } while (cursor !== '');
  assert.equal(seen, (await exp('/bookings?limit=5000')).body.count);
  assert.ok(pages > 1);
  assert.equal((await exp('/bookings?limit=99999')).status, 400);
  assert.equal((await exp('/nope')).status, 404);
});

test('export: incremental loads return only changes, and deletions are tombstoned', async () => {
  const t0 = (await exp('/manifest')).body.serverTime;
  assert.equal((await exp(`/bookings?updatedSince=${t0}`)).body.count, 0);
  await new Promise(r => setTimeout(r, 10));

  const admin = await loggedIn(E('admin'));
  const pending = (await admin.get('/api/bookings')).body.find(b => b.status === 'pending');
  await admin.post(`/api/bookings/${pending.id}/review`, { decision: 'approved' });
  const changed = (await exp(`/bookings?updatedSince=${t0}`)).body.data;
  assert.deepEqual(changed.map(b => b.id), [pending.id]);
  assert.equal(changed[0].status, 'approved');

  await admin.del(`/api/bookings/${pending.id}`);
  const dead = (await exp(`/deleted_records?updatedSince=${t0}`)).body.data;
  assert.ok(dead.some(d => d.entity === 'bookings' && d.entity_id === String(pending.id)));
  assert.equal((await exp(`/bookings?updatedSince=${t0}`)).body.count, 0, 'deleted row no longer returned');
  assert.equal((await exp('/bookings?updatedSince=garbage')).status, 400);
});

test('export: logging in does not count as a change to a user', async () => {
  const t0 = (await exp('/manifest')).body.serverTime;
  await new Promise(r => setTimeout(r, 10));
  await loggedIn(E('driver.nocar'));
  assert.equal((await exp(`/users?updatedSince=${t0}`)).body.count, 0);
});
