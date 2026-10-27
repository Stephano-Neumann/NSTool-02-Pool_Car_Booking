import { config, TEST_PASSWORD } from './config.js';
import { hashPassword, nowIso, currentMonthKey, log } from './util.js';

// One test login per role and per notable account state, so every screen and
// edge case can be reached without setting anything up by hand.
export const TEST_ACCOUNTS = [
  { email: 'admin@neumannsteel.test', name: 'Alex Admin', role: 'admin', licence: '', policy: true,
    label: 'Admin — full access to every panel' },
  { email: 'driver.new@neumannsteel.test', name: 'Nina New', role: 'driver', licence: '', policy: false,
    label: 'New driver — no licence on file, policy not yet acknowledged' },
  { email: 'driver.pool@neumannsteel.test', name: 'Paul Pool', role: 'driver', licence: 'QLD1000001', policy: true,
    label: 'Pool car driver — bookings in every status' },
  { email: 'driver.pool2@neumannsteel.test', name: 'Penny Pool', role: 'driver', licence: 'QLD1000002', policy: true,
    label: 'Second pool driver — checks the board hides other drivers’ details' },
  { email: 'driver.companycar@neumannsteel.test', name: 'Chris Company', role: 'driver', licence: 'QLD2000001', policy: true,
    label: 'Company car driver — prestart and km not done this month' },
  { email: 'driver.companycar.fault@neumannsteel.test', name: 'Faye Fault', role: 'driver', licence: 'QLD2000002', policy: true,
    label: 'Company car driver — prestart faults flagged, service overdue' },
  { email: 'driver.nocar@neumannsteel.test', name: 'Noah NoCar', role: 'driver', licence: 'QLD3000001', policy: true,
    label: 'Driver with no company car and no history (empty states)' },
  { email: 'driver.incident@neumannsteel.test', name: 'Ivy Incident', role: 'driver', licence: 'QLD4000001', policy: true,
    label: 'Driver with submitted incident reports' },
  { email: 'driver.disabled@neumannsteel.test', name: 'Dan Disabled', role: 'driver', licence: 'QLD5000001', policy: true, active: 0,
    label: 'Disabled account — sign-in must be refused' },
];

const DEFAULT_VEHICLES = [
  ['NST-01', 'Toyota HiLux SR5, ute, 5 seats'],
  ['NST-02', 'Toyota Camry Ascent, sedan, 5 seats'],
  ['NST-03', 'Ford Ranger XLT, ute, 5 seats'],
  ['NST-04', 'Toyota Kluger GX, SUV, 7 seats'],
  ['NST-05', 'Hyundai i30, hatch, 5 seats'],
];

// The starting fleet from the original tool. Added once, to an empty fleet, in every environment.
export function seedDefaultFleet(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM vehicles').get().n > 0) return;
  const ins = db.prepare('INSERT INTO vehicles (rego, model) VALUES (?, ?)');
  db.transaction(() => DEFAULT_VEHICLES.forEach(v => ins.run(...v)))();
}

// Brisbane-local wall-clock time (UTC+10, no daylight saving) as an ISO string.
function bne(dayOffset, hour, minute = 0) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' })
    .format(new Date()).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + dayOffset, hour - 10, minute)).toISOString();
}

function previousMonthKey() {
  const [y, m] = currentMonthKey().split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// A valid one-page PDF so the policy acknowledgement link works out of the box.
function samplePolicyPdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 20 Tf 60 760 Td (SAMPLE - Policy for Company Vehicle Use) Tj 0 -30 Td /F1 12 Tf (Test document seeded for non-production environments.) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach(o => { pdf += `${String(o).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export async function seedTestData(db) {
  if (!config.seedTestData || config.appEnv === 'production') return;

  // Accounts are refreshed on every start so the shared test password always works.
  const hash = await hashPassword(TEST_PASSWORD);
  const upsert = db.prepare(`
    INSERT INTO users (email, name, role, licence, password_hash, active, policy_ack_at, created_at)
    VALUES (@email, @name, @role, @licence, @hash, @active, @policyAck, @created)
    ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, password_hash = excluded.password_hash,
      active = excluded.active`);
  db.transaction(() => {
    for (const a of TEST_ACCOUNTS) {
      upsert.run({
        email: a.email, name: a.name, role: a.role, licence: a.licence, hash, active: a.active ?? 1,
        policyAck: a.policy ? nowIso() : null, created: nowIso(),
      });
    }
  })();

  // Sample records are inserted once. Delete the data volume to start again.
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'test_seed_v1'").get()) return;

  const uid = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const vid = (rego) => db.prepare('SELECT id FROM vehicles WHERE rego = ?').get(rego).id;
  const pool = uid('driver.pool@neumannsteel.test');
  const pool2 = uid('driver.pool2@neumannsteel.test');
  const admin = uid('admin@neumannsteel.test');

  db.transaction(() => {
    const addBooking = db.prepare(`INSERT INTO bookings (vehicle_id, user_id, driver_name, licence, email, department, cost_centre,
        use_type, pickup, ret, status, created_at, reviewed_at, reviewed_by, actual_pickup, actual_return, start_km, finish_km,
        start_notes, finish_notes, fuel_ok)
      VALUES (@vehicle, @user, @name, @licence, @email, @dept, @cc, @use, @pickup, @ret, @status, @created, @reviewed, @by,
        @ap, @ar, @sk, @fk, @sn, @fn, @fuel)`);
    const book = (u, rego, o) => addBooking.run({
      vehicle: vid(rego), user: u.id, name: u.name, licence: u.licence, email: u.email,
      dept: o.dept || 'Operations', cc: o.cc || 'CC-1001', use: o.use || 'Business',
      pickup: o.pickup, ret: o.ret, status: o.status, created: nowIso(),
      reviewed: o.status === 'pending' ? null : nowIso(), by: o.status === 'pending' ? null : admin.id,
      ap: o.ap ?? null, ar: o.ar ?? null, sk: o.sk ?? null, fk: o.fk ?? null,
      sn: o.sn ?? null, fn: o.fn ?? null, fuel: o.fuel ?? null,
    });

    book(pool, 'NST-01', { status: 'approved', pickup: bne(-7, 8), ret: bne(-7, 16), dept: 'Logistics & Transport',
      ap: bne(-7, 8, 5), ar: bne(-7, 16, 20), sk: 47800, fk: 47960, sn: 'Small scratch on rear bumper', fn: 'New scuff, front bumper', fuel: 0 });
    book(pool, 'NST-01', { status: 'approved', pickup: bne(-1, 8), ret: bne(-1, 16), dept: 'Logistics & Transport',
      ap: bne(-1, 8, 10), ar: bne(-1, 15, 45), sk: 48210, fk: 48340, fuel: 1 });
    book(pool, 'NST-02', { status: 'approved', pickup: bne(0, 9), ret: bne(0, 17), dept: 'Sales', cc: 'CC-2040',
      ap: bne(0, 9, 5), sk: 51000, sn: 'No existing damage' });
    book(pool, 'NST-03', { status: 'approved', pickup: bne(2, 9), ret: bne(2, 17), use: 'Private', dept: 'Yard & Warehouse' });
    book(pool, 'NST-04', { status: 'pending', pickup: bne(3, 7), ret: bne(3, 15), dept: 'Executive', cc: 'CC-9000' });
    book(pool, 'NST-05', { status: 'declined', pickup: bne(4, 9), ret: bne(4, 17) });
    book(pool2, 'NST-02', { status: 'approved', pickup: bne(1, 9), ret: bne(1, 17), dept: 'Finance', cc: 'CC-3010' });
    book(pool2, 'NST-04', { status: 'approved', pickup: bne(5, 8), ret: bne(5, 12), dept: 'HR', cc: 'CC-4020' });
    book(pool2, 'NST-03', { status: 'pending', pickup: bne(6, 9), ret: bne(6, 17), dept: 'IT', cc: 'CC-5030' });
    book(pool2, 'NST-01', { status: 'pending', pickup: bne(1, 10), ret: bne(1, 14), dept: 'IT', cc: 'CC-5030' });

    db.prepare('INSERT INTO admin_profiles (name, email) VALUES (?, ?)').run('Alex Admin', admin.email);

    // Company cars
    const addCv = db.prepare('INSERT INTO company_vehicles (rego, model, due_service_km) VALUES (?, ?, ?)');
    const c1 = addCv.run('NST-C01', 'Toyota Camry Ascent, sedan, 5 seats', 70000).lastInsertRowid;
    const c2 = addCv.run('NST-C02', 'Toyota HiLux SR5, ute, 5 seats', 62000).lastInsertRowid;
    addCv.run('NST-C03', 'Toyota Kluger GX, SUV, 7 seats (unallocated)', null);
    const cc = uid('driver.companycar@neumannsteel.test');
    const ccf = uid('driver.companycar.fault@neumannsteel.test');
    const addAlloc = db.prepare('INSERT INTO company_allocations (driver_name, driver_email, vehicle_id) VALUES (?, ?, ?)');
    addAlloc.run(cc.name, cc.email, c1);
    addAlloc.run(ccf.name, ccf.email, c2);

    const prev = previousMonthKey();
    const cur = currentMonthKey();
    const addKm = db.prepare('INSERT INTO km_log (user_id, month_key, odometer, submitted_at) VALUES (?, ?, ?, ?)');
    addKm.run(cc.id, prev, 64210, nowIso());
    addKm.run(ccf.id, prev, 61500, nowIso());
    addKm.run(ccf.id, cur, 62100, nowIso());
    const allOk = { tyres: true, lights: true, brakes: true, fluids: true, mirrors: true, presentable: true, dents: true };
    db.prepare(`INSERT INTO prestarts (user_id, month_key, items, notes, mex_number, fault_completed, submitted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(ccf.id, cur, JSON.stringify({ ...allOk, tyres: false, dents: false }),
        'Front left tyre close to the wear bar. Dent in rear passenger door.', 'MEX-48213', 0, nowIso());

    // Incidents
    const inc = uid('driver.incident@neumannsteel.test');
    const addInc = db.prepare(`INSERT INTO incidents (user_id, name, licence, email, submitted_at, description, weather,
        weather_other, road_surface, speed_limit, visibility, third_party) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    addInc.run(inc.id, inc.name, inc.licence, inc.email, bne(-3, 14), 'Reversing in the yard, clipped a bollard. Minor scrape to the rear quarter panel.',
      'Dry / Sunny', '', 'Sealed / Asphalt', '10', 'Clear', '{}');
    addInc.run(inc.id, inc.name, inc.licence, inc.email, bne(-10, 7, 30),
      'Rear-ended at the lights on Gympie Rd. Other driver admitted fault.', 'Wet / Raining', '', 'Sealed / Asphalt', '60', 'Drastically Reduced',
      JSON.stringify({ name: 'Sam Thirdparty', phone: '0400 000 000', email: 'sam@example.test', licence: 'QLD 9999999',
        rego: 'ABC123', vehicle: 'White Mazda 3', insurer: 'Example Insurance', policy: 'POL-0001' }));

    db.prepare('INSERT INTO policy_document (id, filename, size, uploaded_at, uploaded_by, data) VALUES (1, ?, ?, ?, ?, ?)')
      .run('Sample-Vehicle-Use-Policy.pdf', samplePolicyPdf().length, nowIso(), admin.id, samplePolicyPdf());

    db.prepare("INSERT INTO settings (key, value) VALUES ('test_seed_v1', ?)").run(nowIso());
  })();
  log('info', 'test data seeded', { accounts: TEST_ACCOUNTS.length });
}
