'use strict';

/* ==========================================================================
   Neumann Steel company car booking — browser client.
   All data lives on the server (SQLite); this file renders it and calls /api.
   Authorisation is enforced by the server, never by anything in this file.
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');

// ---------- API ----------

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: { 'X-Requested-By': 'nst-app' } };
  if (body instanceof Blob) {
    opts.body = body;
    opts.headers['Content-Type'] = body.type;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/me') sessionExpired();
    const err = new Error((data && data.error) || 'Request failed (' + res.status + ')');
    err.status = res.status;
    throw err;
  }
  return data;
}

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.add('show');
}
function clearError(id) { $(id).classList.remove('show'); }

// Disable a button while its async action runs, so a double click can't submit twice.
async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}

// ---------- state ----------

let authConfig = { mode: 'local', appEnv: 'local', testLogins: null };
let session = null; // {type:'admin'|'driver', name, license, email}
let vehicles = [];
let bookings = [];
let policyMeta = null;
let drivers = [];
let adminProfiles = [];
let alertsState = { webhookUrl: '', log: [] };
let companyVehicles = [];
let companyCarAllocations = [];
let companyCarActivity = [];
let incidentReports = [];
let companyCarMe = null; // {monthKey, vehicle, prestart, km}
let weekStart = startOfWeek(new Date());
let fleetTab = 'active';
let editingVehicleId = null;
let loginIntent = 'pool'; // 'pool' | 'companyCar' | 'incident'

const isAdmin = () => !!session && session.type === 'admin';
const isDriver = () => !!session && session.type === 'driver';

function getVehicle(id) { return vehicles.find(v => v.id === id); }
function activeVehicles() { return vehicles.filter(v => !v.archived); }
function archivedVehicles() { return vehicles.filter(v => v.archived); }
function getCompanyVehicle(id) { return companyVehicles.find(v => v.id === id); }
const regoOf = (id) => { const v = getVehicle(id); return v ? v.rego : '—'; };

// ---------- date helpers ----------

function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  date.setHours(0, 0, 0, 0);
  return date;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function fmtDayHead(d) { return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }); }
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
}
function fmtTimeOnly(iso) { return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }); }
function fmtWeekLabel() {
  const end = addDays(weekStart, 6);
  return weekStart.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + ' – ' + end.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
// Value for <input type=date|time> in the user's local time zone.
function localDateInput(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function localTimeInput(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function monthKeyLabel(key) {
  const [y, m] = key.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function truncateText(s, len) {
  if (!s) return '';
  return s.length > len ? s.slice(0, len).trim() + '…' : s;
}
function plate(rego) {
  return '<span class="plate" style="font-size:11.5px;padding:2px 6px;">' + escapeHtml(rego) + '</span>';
}

// ---------- screens ----------

const SCREENS = { loadingScreen: 'flex', loginScreen: 'flex', landingScreen: 'flex', appContainer: 'block', companyCarContainer: 'block', incidentContainer: 'block' };
function showScreen(name) {
  for (const [id, display] of Object.entries(SCREENS)) $(id).style.display = id === name ? display : 'none';
  window.scrollTo(0, 0);
}
function showApp() { showScreen('appContainer'); }
function showLanding() {
  $('landingWelcome').innerHTML = 'Signed in as <b>' + escapeHtml(session.name) + '</b>';
  showScreen('landingScreen');
}

// ---------- sign in / sign out ----------

function showLogin(message) {
  session = null;
  $('l-password').value = '';
  if (message) showError('loginError', message); else clearError('loginError');
  showScreen('loginScreen');
}
function sessionExpired() {
  if (session) showLogin('Your session has ended. Please sign in again.');
}

function renderTestLogins() {
  const box = $('testLoginsBox');
  const t = authConfig.testLogins;
  if (!t) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = '<h3>Test logins</h3><p>Click one to sign in. Password for all: <b>' + escapeHtml(t.password) + '</b></p>' +
    t.accounts.map(a =>
      '<button type="button" class="tl-row" data-email="' + escapeHtml(a.email) + '"><span class="tl-email">' + escapeHtml(a.email) +
      '</span><span class="tl-label">' + escapeHtml(a.label) + '</span></button>').join('');
  box.querySelectorAll('.tl-row').forEach(btn => btn.addEventListener('click', () => {
    $('l-email').value = btn.dataset.email;
    $('l-password').value = t.password;
    $('loginForm').requestSubmit();
  }));
}

function renderEnvBadge() {
  const badge = $('envBadge');
  if (authConfig.appEnv === 'production') { badge.style.display = 'none'; return; }
  badge.style.display = 'block';
  badge.textContent = authConfig.appEnv + ' environment';
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError('loginError');
  await busy($('submitLogin'), async () => {
    try {
      const user = await api('POST', '/api/auth/login', { email: $('l-email').value.trim(), password: $('l-password').value });
      await afterSignIn(user);
    } catch (err) {
      showError('loginError', err.message);
    }
  });
});

async function signOut() {
  if (authConfig.mode === 'gateway') { window.location.href = '/.auth/logout?post_logout_redirect_uri=/'; return; }
  try { await api('POST', '/api/auth/logout'); } catch (e) { /* already signed out */ }
  vehicles = []; bookings = []; drivers = []; incidentReports = []; companyCarMe = null;
  $('l-email').value = '';
  showLogin();
}

function applyUser(user) {
  session = { type: user.role, name: user.name, license: user.licence, email: user.email, policyAcked: user.policyAcked };
}

async function afterSignIn(user) {
  applyUser(user);
  await Promise.all([loadVehicles(), loadBookings(), loadPolicyMeta()]);
  if (isDriver() && !user.profileComplete) {
    await requireProfile();
  }
  if (isDriver() && !user.policyAcked) {
    openPolicyModal();
    return;
  }
  enterHome();
}

function enterHome() {
  if (isAdmin()) {
    showApp();
    loadAdminData().then(renderAll);
    renderAll();
  } else {
    showLanding();
  }
}

// ---------- data loading ----------

async function loadVehicles() { vehicles = await api('GET', '/api/vehicles'); populateVehicleSelect(); }
async function loadBookings() { bookings = await api('GET', '/api/bookings'); }
async function loadPolicyMeta() { policyMeta = await api('GET', '/api/policy'); }
async function loadAdminData() {
  const [d, p, a, cv, al, act, inc] = await Promise.all([
    api('GET', '/api/drivers'), api('GET', '/api/admin-profiles'), api('GET', '/api/alerts'),
    api('GET', '/api/company-vehicles'), api('GET', '/api/company-allocations'),
    api('GET', '/api/company-car/activity'), api('GET', '/api/incidents'),
  ]);
  drivers = d; adminProfiles = p; alertsState = a;
  companyVehicles = cv; companyCarAllocations = al; companyCarActivity = act; incidentReports = inc;
}

// ---------- profile (name + licence) ----------

let profileRequired = false;
let profileResolve = null;

function openProfileModal(required) {
  profileRequired = !!required;
  clearError('profileError');
  $('profileTitle').textContent = required ? 'Complete your profile' : 'Your profile';
  $('pr-name').value = session.name || '';
  $('pr-license').value = session.license || '';
  $('pr-email').value = session.email;
  $('cancelProfile').style.display = required ? 'none' : '';
  $('closeProfile').style.display = required ? 'none' : '';
  $('profileNote').textContent = required
    ? 'Before you can book or report, add your driver’s licence number. Bookings and reports are linked to this profile.'
    : 'Your bookings, trip logs and incident reports are linked to this profile.';
  $('overlayProfile').classList.add('open');
}
function requireProfile() {
  openProfileModal(true);
  return new Promise(resolve => { profileResolve = resolve; });
}
function closeProfileModal() {
  if (profileRequired) return;
  $('overlayProfile').classList.remove('open');
}
$('closeProfile').addEventListener('click', closeProfileModal);
$('cancelProfile').addEventListener('click', closeProfileModal);
$('overlayProfile').addEventListener('click', (e) => { if (e.target === $('overlayProfile')) closeProfileModal(); });
$('submitProfile').addEventListener('click', () => busy($('submitProfile'), async () => {
  clearError('profileError');
  try {
    const user = await api('PUT', '/api/me', { name: $('pr-name').value, licence: $('pr-license').value });
    const acked = session.policyAcked;
    applyUser(user);
    session.policyAcked = acked;
    $('overlayProfile').classList.remove('open');
    profileRequired = false;
    if (profileResolve) { profileResolve(); profileResolve = null; }
  } catch (err) {
    showError('profileError', err.message);
  }
}));

// ---------- change password ----------

function openPasswordModal() {
  clearError('passwordError');
  $('passwordOk').style.display = 'none';
  ['pw-current', 'pw-new', 'pw-new2'].forEach(id => { $(id).value = ''; });
  $('overlayPassword').classList.add('open');
}
$('closePassword').addEventListener('click', () => $('overlayPassword').classList.remove('open'));
$('cancelPassword').addEventListener('click', () => $('overlayPassword').classList.remove('open'));
$('overlayPassword').addEventListener('click', (e) => { if (e.target === $('overlayPassword')) $('overlayPassword').classList.remove('open'); });
$('submitPassword').addEventListener('click', () => busy($('submitPassword'), async () => {
  clearError('passwordError');
  $('passwordOk').style.display = 'none';
  if ($('pw-new').value !== $('pw-new2').value) { showError('passwordError', 'New password and confirmation don’t match.'); return; }
  try {
    await api('POST', '/api/me/password', { currentPassword: $('pw-current').value, newPassword: $('pw-new').value });
    ['pw-current', 'pw-new', 'pw-new2'].forEach(id => { $(id).value = ''; });
    $('passwordOk').style.display = 'block';
  } catch (err) {
    showError('passwordError', err.message);
  }
}));

// ---------- landing menu ----------

$('driverLoginBtn').addEventListener('click', () => { loginIntent = 'pool'; showApp(); renderAll(); });
$('companyCarBtn').addEventListener('click', async () => {
  loginIntent = 'companyCar';
  showScreen('companyCarContainer');
  await loadCompanyCarMe();
  renderCompanyCarApp();
});
$('incidentMgmtBtn').addEventListener('click', async () => {
  loginIntent = 'incident';
  showScreen('incidentContainer');
  incidentReports = await api('GET', '/api/incidents');
  renderIncidentApp();
});
$('landingProfileBtn').addEventListener('click', () => openProfileModal(false));
$('landingPasswordBtn').addEventListener('click', openPasswordModal);
$('landingLogoutBtn').addEventListener('click', signOut);
$('logoutBtn').addEventListener('click', signOut);
$('companyCarLogoutBtn').addEventListener('click', signOut);
$('incidentLogoutBtn').addEventListener('click', signOut);
$('menuBtn').addEventListener('click', showLanding);
$('companyCarMenuBtn').addEventListener('click', showLanding);
$('incidentMenuBtn').addEventListener('click', showLanding);
$('passwordBtn').addEventListener('click', openPasswordModal);

// ---------- policy acknowledgement ----------

const overlayPolicy = $('overlayPolicy');

function updatePolicyLinkHref() {
  const link = $('policyLink');
  if (policyMeta) {
    link.href = '/api/policy/file';
    link.textContent = 'Read the Policy for Company Vehicle Use ↗';
  } else {
    link.removeAttribute('href');
    link.textContent = 'Policy document not yet uploaded — check with your admin';
  }
}
function openPolicyModal() {
  $('policy-ack-check').checked = false;
  $('confirmPolicy').disabled = true;
  updatePolicyLinkHref();
  overlayPolicy.classList.add('open');
}
$('policy-ack-check').addEventListener('change', (e) => { $('confirmPolicy').disabled = !e.target.checked; });
// The policy must be acknowledged to use the tool, so closing the dialog signs the user out.
function declinePolicy() { overlayPolicy.classList.remove('open'); signOut(); }
$('closePolicy').addEventListener('click', declinePolicy);
$('cancelPolicy').addEventListener('click', declinePolicy);
$('confirmPolicy').addEventListener('click', () => busy($('confirmPolicy'), async () => {
  try {
    const user = await api('POST', '/api/me/policy-ack');
    applyUser(user);
    overlayPolicy.classList.remove('open');
    enterHome();
  } catch (err) {
    alert(err.message);
  }
}));

// ---------- pool car: board ----------

function getStatus(b) { return b.status || 'pending'; }
function statusBadge(b) {
  const status = getStatus(b);
  return '<span class="status-tag ' + status + '">' + status.charAt(0).toUpperCase() + status.slice(1) + '</span>';
}

function bookingsForVehicleOnDay(vehicleId, day) {
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);
  return bookings.filter(b => b.vehicleId === vehicleId && getStatus(b) !== 'declined' &&
    new Date(b.pickup) <= dayEnd && new Date(b.ret) >= dayStart)
    .sort((a, b) => new Date(a.pickup) - new Date(b.pickup));
}

function renderBoard() {
  const head = $('boardHead');
  const body = $('boardBody');
  $('weekLabel').textContent = fmtWeekLabel();

  const today = new Date();
  head.innerHTML = '<th style="text-align:left;">Vehicle</th>' +
    Array.from({ length: 7 }, (_, i) => {
      const d = addDays(weekStart, i);
      return '<th class="' + (sameDay(d, today) ? 'today' : '') + '">' + fmtDayHead(d) + '</th>';
    }).join('');

  body.innerHTML = activeVehicles().map(v => {
    const cells = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(weekStart, i);
      const dayBookings = bookingsForVehicleOnDay(v.id, d);
      const chips = dayBookings.map(b => {
        const label = isDriver() && !b.mine ? 'Booked' : escapeHtml(b.driverName);
        return '<div class="booking-chip ' + (b.use === 'Private' ? 'private' : '') + '"><b>' + label + '</b>' +
          fmtTimeOnly(b.pickup) + '–' + fmtTimeOnly(b.ret) +
          (getStatus(b) !== 'approved' ? ' ' + statusBadge(b) : '') + '</div>';
      }).join('');
      const hint = dayBookings.length === 0 ? '<div class="add-hint">+</div>' : '';
      return '<td class="day-cell" data-vehicle="' + v.id + '" data-date="' + d.getTime() + '">' + chips + hint + '</td>';
    }).join('');
    return '<tr><td class="vehicle-cell" data-vehicle-id="' + v.id + '"><span class="plate"' +
      (isAdmin() ? ' title="Double-click to edit"' : '') + '>' + escapeHtml(v.rego) + '</span>' +
      '<div class="vehicle-model">' + escapeHtml(v.model) + '</div></td>' + cells + '</tr>';
  }).join('');

  body.querySelectorAll('.day-cell').forEach(td => {
    td.addEventListener('click', () => openModal(Number(td.dataset.vehicle), new Date(Number(td.dataset.date))));
  });
  if (isAdmin()) {
    body.querySelectorAll('.vehicle-cell').forEach(td => {
      td.style.cursor = 'pointer';
      td.addEventListener('dblclick', () => openVehicleModal(Number(td.dataset.vehicleId)));
    });
  }
}

function tripStatusHtml(b) {
  let flags = '';
  if (b.fuelOk === false) flags += '<span class="flag-badge" title="Returned below a quarter tank">Low fuel</span>';
  if ((b.startNotes && b.startNotes.length) || (b.finishNotes && b.finishNotes.length)) {
    const noteText = [b.startNotes, b.finishNotes].filter(Boolean).join(' / ');
    flags += '<span class="flag-badge" title="' + escapeHtml(noteText) + '">Damage noted</span>';
  }
  if (b.startKm != null && b.finishKm != null) {
    return '<span class="trip-status logged">' + (b.finishKm - b.startKm) + ' km logged</span>' + flags;
  }
  if (b.actualPickup != null) {
    return '<span class="trip-status logged">In progress — started ' + fmtDateTime(b.actualPickup) + '</span>' + flags;
  }
  return '<span class="trip-status">Not started</span>' + flags;
}

function tripAction(b) {
  const status = getStatus(b);
  if (status === 'declined') return { mode: 'blocked', label: 'Declined', disabled: true };
  if (status === 'pending') return { mode: 'blocked', label: 'Awaiting approval', disabled: true };
  if (b.startKm != null && b.finishKm != null) return { mode: 'edit', label: 'Edit log' };
  if (b.actualPickup != null) return { mode: 'finish', label: 'Finish trip' };
  return { mode: 'start', label: 'Start trip' };
}

function renderUpcoming() {
  const panel = $('upcomingPanel');
  if (!isAdmin()) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  const tbody = $('upcomingBody');
  const now = new Date();
  const upcoming = bookings.filter(b => new Date(b.ret) >= now && getStatus(b) !== 'declined')
    .sort((a, b) => new Date(a.pickup) - new Date(b.pickup));
  if (upcoming.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">No upcoming bookings. Use "New booking" to reserve a vehicle.</td></tr>';
    return;
  }
  tbody.innerHTML = upcoming.map(b =>
    '<tr>' +
      '<td>' + plate(regoOf(b.vehicleId)) + '</td>' +
      '<td>' + escapeHtml(b.driverName) + '</td>' +
      '<td>' + escapeHtml(b.department) + '</td>' +
      '<td><span class="use-tag ' + (b.use === 'Private' ? 'private' : 'business') + '">' + escapeHtml(b.use) + '</span></td>' +
      '<td>' + statusBadge(b) + '</td>' +
      '<td>' + fmtDateTime(b.pickup) + '</td>' +
      '<td>' + fmtDateTime(b.ret) + '</td>' +
      '<td>' + tripStatusHtml(b) + '</td>' +
      '<td><button class="btn-danger" data-cancel="' + b.id + '" style="padding:5px 10px;font-size:12px;">Cancel</button></td>' +
    '</tr>').join('');

  tbody.querySelectorAll('[data-cancel]').forEach(btn => {
    btn.addEventListener('click', () => busy(btn, async () => {
      if (!confirm('Cancel this booking? This removes it permanently.')) return;
      try { await api('DELETE', '/api/bookings/' + btn.dataset.cancel); } catch (err) { alert(err.message); }
      await refreshBookings();
    }));
  });
}

function renderMyBookings() {
  const panel = $('myBookingsPanel');
  if (!isDriver()) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  const mine = bookings.filter(b => b.mine).sort((a, b) => new Date(b.pickup) - new Date(a.pickup));
  const tbody = $('myBookingsBody');
  if (mine.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">You have no bookings yet. Click a free day on the board to book a vehicle.</td></tr>';
    return;
  }
  tbody.innerHTML = mine.map(b => {
    const action = tripAction(b);
    return '<tr>' +
      '<td>' + plate(regoOf(b.vehicleId)) + '</td>' +
      '<td>' + fmtDateTime(b.pickup) + ' – ' + fmtDateTime(b.ret) + '</td>' +
      '<td><span class="use-tag ' + (b.use === 'Private' ? 'private' : 'business') + '">' + escapeHtml(b.use) + '</span></td>' +
      '<td>' + statusBadge(b) + '</td>' +
      '<td>' + tripStatusHtml(b) + '</td>' +
      '<td><button class="btn-ghost" ' + (action.disabled ? 'disabled' : '') + ' data-log="' + b.id + '" data-mode="' + action.mode +
        '" style="padding:5px 10px;font-size:12px;">' + action.label + '</button></td>' +
      '</tr>';
  }).join('');

  tbody.querySelectorAll('[data-log]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode !== 'blocked') openTripModal(Number(btn.dataset.log), btn.dataset.mode);
    });
  });
}

function updateSessionBar() {
  const bar = $('sessionBar');
  if (!session) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  $('sessionName').textContent = isAdmin() ? session.name + ' (Admin)' : session.name + ' (Driver)';
  $('menuBtn').style.display = isDriver() ? '' : 'none';
  $('passwordBtn').style.display = authConfig.mode === 'local' ? '' : 'none';
}

// ---------- admin panels ----------

function renderAdminPanel() {
  const pendingPanel = $('adminPendingPanel');
  const driversPanel = $('adminDriversPanel');
  if (!isAdmin()) { pendingPanel.style.display = 'none'; driversPanel.style.display = 'none'; return; }
  pendingPanel.style.display = 'block';
  driversPanel.style.display = 'block';

  const pending = bookings.filter(b => getStatus(b) === 'pending').sort((a, b) => new Date(a.pickup) - new Date(b.pickup));
  const ptbody = $('adminPendingBody');
  if (pending.length === 0) {
    ptbody.innerHTML = '<tr class="empty-row"><td colspan="8">No bookings waiting on approval.</td></tr>';
  } else {
    ptbody.innerHTML = pending.map(b =>
      '<tr>' +
        '<td>' + plate(regoOf(b.vehicleId)) + '</td>' +
        '<td>' + escapeHtml(b.driverName) + '</td>' +
        '<td>' + escapeHtml(b.license) + '</td>' +
        '<td>' + escapeHtml(b.department) + '</td>' +
        '<td>' + escapeHtml(b.costCentre) + '</td>' +
        '<td><span class="use-tag ' + (b.use === 'Private' ? 'private' : 'business') + '">' + escapeHtml(b.use) + '</span></td>' +
        '<td>' + fmtDateTime(b.pickup) + ' – ' + fmtDateTime(b.ret) + '</td>' +
        '<td style="white-space:nowrap;"><button class="btn-primary" data-approve="' + b.id + '" style="padding:5px 10px;font-size:12px;">Approve</button> ' +
        '<button class="btn-danger" data-decline="' + b.id + '" style="padding:5px 10px;font-size:12px;">Decline</button></td>' +
      '</tr>').join('');
    for (const decision of ['approve', 'decline']) {
      ptbody.querySelectorAll('[data-' + decision + ']').forEach(btn => {
        btn.addEventListener('click', () => busy(btn, async () => {
          try {
            await api('POST', '/api/bookings/' + btn.dataset[decision] + '/review', { decision: decision === 'approve' ? 'approved' : 'declined' });
          } catch (err) { alert(err.message); }
          await refreshBookings();
        }));
      });
    }
  }

  const dtbody = $('adminDriversBody');
  if (drivers.length === 0) {
    dtbody.innerHTML = '<tr class="empty-row"><td colspan="7">No drivers have signed in yet.</td></tr>';
  } else {
    dtbody.innerHTML = drivers.map(d =>
      '<tr>' +
        '<td>' + escapeHtml(d.name) + (d.active ? '' : ' <span class="trip-status">Disabled</span>') + '</td>' +
        '<td>' + escapeHtml(d.email) + '</td>' +
        '<td>' + escapeHtml(d.license || '—') + '</td>' +
        '<td>' + (d.policyAckAt ? '<span class="trip-status logged">Confirmed ' + fmtDateTime(d.policyAckAt) + '</span>' : '<span class="trip-status">Not confirmed</span>') + '</td>' +
        '<td>' + d.bookings + '</td>' +
        '<td class="km-value">' + d.totalKm + ' km</td>' +
        '<td><button class="btn-ghost" data-history="' + d.id + '" style="padding:5px 10px;font-size:12px;">View history</button></td>' +
      '</tr>').join('');
    dtbody.querySelectorAll('[data-history]').forEach(btn => {
      btn.addEventListener('click', () => openDriverHistory(Number(btn.dataset.history)));
    });
  }
}

function openDriverHistory(driverId) {
  const d = drivers.find(x => x.id === driverId);
  if (!d) return;
  $('driverHistoryName').textContent = d.name + (d.license ? ' — Licence ' + d.license : '');
  const matched = bookings.filter(b => b.email && b.email.toLowerCase() === d.email.toLowerCase())
    .sort((a, b) => new Date(b.pickup) - new Date(a.pickup));
  $('driverHistoryBody').innerHTML = matched.length === 0
    ? '<tr class="empty-row"><td colspan="7">No bookings yet.</td></tr>'
    : matched.map(b => {
      const km = (b.startKm != null && b.finishKm != null) ? (b.finishKm - b.startKm) + ' km' : '—';
      const actual = b.actualPickup ? fmtDateTime(b.actualPickup) + ' – ' + (b.actualReturn ? fmtDateTime(b.actualReturn) : 'in progress') : '—';
      const fuel = b.fuelOk === false ? '<span class="flag-badge">Low fuel</span>' : (b.fuelOk === true ? 'OK' : '—');
      const notes = [b.startNotes, b.finishNotes].filter(Boolean).join(' / ') || '—';
      return '<tr>' +
        '<td>' + plate(regoOf(b.vehicleId)) + '</td>' +
        '<td>' + statusBadge(b) + '</td>' +
        '<td>' + fmtDateTime(b.pickup) + ' – ' + fmtDateTime(b.ret) + '</td>' +
        '<td>' + actual + '</td>' +
        '<td class="km-value">' + km + '</td>' +
        '<td>' + fuel + '</td>' +
        '<td style="max-width:220px;font-size:12px;color:var(--ink-soft);">' + escapeHtml(notes) + '</td>' +
      '</tr>';
    }).join('');
  $('overlayDriverHistory').classList.add('open');
}
for (const id of ['closeDriverHistory', 'closeDriverHistory2']) {
  $(id).addEventListener('click', () => $('overlayDriverHistory').classList.remove('open'));
}
$('overlayDriverHistory').addEventListener('click', (e) => { if (e.target === $('overlayDriverHistory')) $('overlayDriverHistory').classList.remove('open'); });

function renderFleetPanel() {
  const panel = $('adminFleetPanel');
  if (!isAdmin()) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  $('fleetTabActive').classList.toggle('active', fleetTab === 'active');
  $('fleetTabArchived').classList.toggle('active', fleetTab === 'archived');

  const list = fleetTab === 'active' ? activeVehicles() : archivedVehicles();
  const tbody = $('fleetBody');
  if (list.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="3">' + (fleetTab === 'active' ? 'No active vehicles.' : 'No archived vehicles.') + '</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(v => {
    const action = fleetTab === 'active'
      ? '<button class="btn-ghost" data-edit="' + v.id + '" style="padding:5px 10px;font-size:12px;">Edit</button>'
      : '<button class="btn-ghost" data-restore="' + v.id + '" style="padding:5px 10px;font-size:12px;">Restore</button>';
    return '<tr class="fleet-row" data-row-vehicle="' + v.id + '"><td>' + plate(v.rego) + '</td><td>' + escapeHtml(v.model) + '</td><td>' + action + '</td></tr>';
  }).join('');

  tbody.querySelectorAll('tr.fleet-row').forEach(tr => tr.addEventListener('dblclick', () => openVehicleModal(Number(tr.dataset.rowVehicle))));
  tbody.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); openVehicleModal(Number(btn.dataset.edit)); }));
  tbody.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    busy(btn, async () => {
      try { await api('POST', '/api/vehicles/' + btn.dataset.restore + '/restore'); } catch (err) { alert(err.message); }
      await loadVehicles();
      renderAll();
    });
  }));
}

function renderAdminProfilesPanel() {
  const panel = $('adminProfilesPanel');
  if (!isAdmin()) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const tbody = $('adminProfilesBody');
  if (adminProfiles.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="3">No admin profiles yet. Add one so booking alerts have somewhere to go.</td></tr>';
    return;
  }
  tbody.innerHTML = adminProfiles.map(p =>
    '<tr><td>' + escapeHtml(p.name) + '</td><td>' + escapeHtml(p.email) + '</td>' +
    '<td><button class="btn-ghost" data-edit-profile="' + p.id + '" style="padding:5px 10px;font-size:12px;">Edit</button></td></tr>').join('');
  tbody.querySelectorAll('[data-edit-profile]').forEach(btn => btn.addEventListener('click', () => openAdminProfileModal(Number(btn.dataset.editProfile))));
}

function renderAlertsPanel() {
  const panel = $('alertsPanel');
  if (!isAdmin()) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const webhookField = $('alert-webhook');
  if (document.activeElement !== webhookField) webhookField.value = alertsState.webhookUrl || '';

  const tbody = $('alertsLogBody');
  if (alertsState.log.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No alerts have fired yet.</td></tr>';
    return;
  }
  tbody.innerHTML = alertsState.log.map(a =>
    '<tr><td>' + fmtDateTime(a.sentAt) + '</td><td>' + escapeHtml(a.subject) + '</td>' +
    '<td style="font-size:12px;color:var(--ink-soft);">' + escapeHtml(a.recipients.join(', ') || '—') + '</td>' +
    '<td>' + (a.delivered ? '<span class="status-tag approved">Sent</span>' : '<span class="status-tag pending">Logged only</span>') + '</td></tr>').join('');
}

function renderPolicyDocPanel() {
  const panel = $('policyDocPanel');
  if (!isAdmin()) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  if (policyMeta) {
    $('policyDocStatus').textContent = 'Current policy: ' + policyMeta.filename + ' — uploaded ' + fmtDateTime(policyMeta.uploadedAt) + '.';
    $('policyDocActions').style.display = 'flex';
  } else {
    $('policyDocStatus').textContent = 'No policy document uploaded yet. Drivers see a placeholder link until one is added.';
    $('policyDocActions').style.display = 'none';
  }
}

function renderCompanyVehiclesPanel() {
  const panel = $('companyVehiclesPanel');
  if (!isAdmin()) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const tbody = $('companyVehiclesBody');
  if (companyVehicles.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No company vehicles added yet.</td></tr>';
    return;
  }
  tbody.innerHTML = companyVehicles.map(v =>
    '<tr><td>' + plate(v.rego) + '</td><td>' + escapeHtml(v.model) + '</td>' +
    '<td>' + (v.dueServiceKm ? '<span class="km-value">' + v.dueServiceKm + ' km</span>' : '—') + '</td>' +
    '<td><button class="btn-ghost" data-edit-vehicle="' + v.id + '" style="padding:5px 10px;font-size:12px;">Edit</button></td></tr>').join('');
  tbody.querySelectorAll('[data-edit-vehicle]').forEach(btn => btn.addEventListener('click', () => openCompanyVehicleModal(Number(btn.dataset.editVehicle))));
}

function renderCompanyCarAllocPanel() {
  const panel = $('companyCarAllocPanel');
  if (!isAdmin()) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const tbody = $('companyCarAllocBody');
  if (companyCarAllocations.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No company cars allocated yet.</td></tr>';
    return;
  }
  tbody.innerHTML = companyCarAllocations.map(a => {
    const v = getCompanyVehicle(a.vehicleId);
    return '<tr><td>' + escapeHtml(a.name) + '</td><td>' + escapeHtml(a.email) + '</td>' +
      '<td>' + plate(v ? v.rego : '—') + '</td><td>' + escapeHtml(v ? v.model : 'Vehicle not found') + '</td>' +
      '<td><button class="btn-ghost" data-edit-alloc="' + a.id + '" style="padding:5px 10px;font-size:12px;">Edit</button></td></tr>';
  }).join('');
  tbody.querySelectorAll('[data-edit-alloc]').forEach(btn => btn.addEventListener('click', () => openAllocationModal(Number(btn.dataset.editAlloc))));
}

function failedPrestartItems(prestart) {
  return PRESTART_ITEMS.filter(item => !prestart.items[item.id]);
}

function renderCompanyCarActivityPanel() {
  const panel = $('companyCarActivityPanel');
  if (!isAdmin()) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const tbody = $('companyCarActivityBody');
  if (companyCarActivity.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No company cars allocated yet.</td></tr>';
    return;
  }
  tbody.innerHTML = companyCarActivity.map(a => {
    let prestartHtml = '<span class="trip-status">Not done</span>';
    if (a.prestart) {
      const failed = failedPrestartItems(a.prestart);
      if (failed.length) {
        prestartHtml =
          '<div class="flag-badge" style="margin-bottom:6px;">Issues: ' + failed.map(f => escapeHtml(f.label)).join(', ') + '</div>' +
          '<input type="text" class="mex-input" data-mex-for="' + a.prestart.id + '" value="' + escapeHtml(a.prestart.mexNumber || '') + '" placeholder="Mex #" style="padding:5px 7px;margin-bottom:6px;width:120px;">' +
          '<button class="btn-ghost" data-toggle-fault="' + a.prestart.id + '" style="padding:4px 9px;font-size:11.5px;display:block;">' +
          (a.prestart.faultCompleted ? '✓ Fault completed — reopen' : 'Mark fault completed') + '</button>';
      } else {
        prestartHtml = '<span class="trip-status logged">Completed</span>';
      }
    }
    return '<tr><td>' + escapeHtml(a.name) + '</td><td>' + plate(a.rego) + '</td><td>' + prestartHtml + '</td>' +
      '<td>' + (a.odometer != null ? '<span class="km-value">' + a.odometer + ' km</span>' : '<span class="trip-status">Not recorded</span>') + '</td></tr>';
  }).join('');

  tbody.querySelectorAll('[data-toggle-fault]').forEach(btn => btn.addEventListener('click', () => busy(btn, async () => {
    const row = companyCarActivity.find(a => a.prestart && a.prestart.id === Number(btn.dataset.toggleFault));
    try {
      await api('PATCH', '/api/prestarts/' + btn.dataset.toggleFault, { faultCompleted: !row.prestart.faultCompleted });
      companyCarActivity = await api('GET', '/api/company-car/activity');
    } catch (err) { alert(err.message); }
    renderCompanyCarActivityPanel();
  })));
  tbody.querySelectorAll('[data-mex-for]').forEach(input => input.addEventListener('change', async () => {
    try { await api('PATCH', '/api/prestarts/' + input.dataset.mexFor, { mexNumber: input.value }); } catch (err) { alert(err.message); }
  }));
}

function renderIncidentAdminPanel() {
  const panel = $('incidentAdminPanel');
  if (!isAdmin()) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const tbody = $('incidentAdminBody');
  if (incidentReports.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No incident reports submitted yet.</td></tr>';
    return;
  }
  tbody.innerHTML = incidentReports.map(r =>
    '<tr><td>' + fmtDateTime(r.submittedAt) + '</td><td>' + escapeHtml(r.name) + '</td>' +
    '<td>' + escapeHtml(truncateText(r.description, 60)) + '</td>' +
    '<td>' + (r.thirdParty.name ? escapeHtml(r.thirdParty.name) : '—') + '</td>' +
    '<td><button class="btn-ghost" data-view-incident="' + r.id + '" style="padding:5px 10px;font-size:12px;">View</button></td></tr>').join('');
  tbody.querySelectorAll('[data-view-incident]').forEach(btn => btn.addEventListener('click', () => openIncidentDetail(Number(btn.dataset.viewIncident))));
}

function renderAll() {
  renderBoard();
  renderUpcoming();
  updateSessionBar();
  renderMyBookings();
  renderAdminPanel();
  renderFleetPanel();
  renderAdminProfilesPanel();
  renderAlertsPanel();
  renderPolicyDocPanel();
  renderCompanyCarAllocPanel();
  renderCompanyCarActivityPanel();
  renderCompanyVehiclesPanel();
  renderIncidentAdminPanel();
}

// Reload everything that a booking change can affect.
async function refreshBookings() {
  await loadBookings();
  if (isAdmin()) {
    [drivers, alertsState] = await Promise.all([api('GET', '/api/drivers'), api('GET', '/api/alerts')]);
  }
  renderAll();
}

// ---------- modal: new booking ----------

const overlay = $('overlay');

function populateVehicleSelect() {
  $('f-vehicle').innerHTML = activeVehicles().map(v => '<option value="' + v.id + '">' + escapeHtml(v.rego) + ' — ' + escapeHtml(v.model) + '</option>').join('');
}

function resetForm() {
  for (const id of ['f-name', 'f-license', 'f-email', 'f-dept', 'f-cc', 'f-pickup-date', 'f-pickup-time', 'f-return-date', 'f-return-time']) {
    $(id).value = '';
  }
  $('f-name').readOnly = false;
  $('f-license').readOnly = false;
  document.querySelector('input[name="use"][value="Business"]').checked = true;
  clearError('errorMsg');
}

function openModal(vehicleId, date) {
  resetForm();
  const identityNote = $('bookingIdentityNote');
  if (isDriver()) {
    $('f-name').value = session.name; $('f-name').readOnly = true;
    $('f-license').value = session.license; $('f-license').readOnly = true;
    $('f-email-wrap').style.display = 'none';
    identityNote.textContent = 'Booking as ' + session.name + '.';
    identityNote.style.display = 'block';
  } else {
    $('f-email-wrap').style.display = '';
    identityNote.style.display = 'none';
  }
  if (vehicleId) $('f-vehicle').value = String(vehicleId);
  if (date) {
    const iso = localDateInput(date);
    $('f-pickup-date').value = iso;
    $('f-return-date').value = iso;
    $('f-pickup-time').value = '09:00';
    $('f-return-time').value = '17:00';
  }
  overlay.classList.add('open');
}
function closeModal() { overlay.classList.remove('open'); }

$('newBookingBtn').addEventListener('click', () => {
  if (isDriver() && !session.license) { openProfileModal(false); return; }
  openModal(null, new Date());
});
$('closeModal').addEventListener('click', closeModal);
$('cancelModal').addEventListener('click', closeModal);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

$('submitBooking').addEventListener('click', () => busy($('submitBooking'), async () => {
  clearError('errorMsg');
  const f = {
    vehicleId: Number($('f-vehicle').value),
    driverName: $('f-name').value.trim(), license: $('f-license').value.trim(), email: $('f-email').value.trim(),
    department: $('f-dept').value.trim(), costCentre: $('f-cc').value.trim(),
    use: document.querySelector('input[name="use"]:checked').value,
  };
  const pickupDate = $('f-pickup-date').value, pickupTime = $('f-pickup-time').value;
  const returnDate = $('f-return-date').value, returnTime = $('f-return-time').value;
  if (!f.driverName || !f.license || !f.department || !f.costCentre || !pickupDate || !pickupTime || !returnDate || !returnTime) {
    showError('errorMsg', 'Fill in every field before confirming the booking.');
    return;
  }
  f.pickup = new Date(pickupDate + 'T' + pickupTime).toISOString();
  f.ret = new Date(returnDate + 'T' + returnTime).toISOString();
  try {
    await api('POST', '/api/bookings', f);
  } catch (err) {
    showError('errorMsg', err.message);
    return;
  }
  closeModal();
  await refreshBookings();
}));

// ---------- modal: trip log ----------

const overlayTrip = $('overlayTrip');
let tripBookingId = null;
let tripMode = 'start';

function openTripModal(bookingId, mode) {
  tripBookingId = bookingId;
  tripMode = mode;
  const b = bookings.find(x => x.id === bookingId);
  clearError('tripError');

  const now = new Date();
  const show = (id, display) => { $(id).style.display = display; };
  if (mode === 'start') {
    $('tripModalTitle').textContent = 'Start trip';
    show('tripStartFields', 'grid'); show('tripFinishFields', 'none'); show('tripAlreadyStarted', 'none');
    $('submitTrip').textContent = 'Save start details';
    $('t-start-date').value = localDateInput(now);
    $('t-start-time').value = localTimeInput(now);
    $('t-start-km').value = '';
    $('t-start-notes').value = '';
  } else if (mode === 'finish') {
    $('tripModalTitle').textContent = 'Finish trip';
    show('tripStartFields', 'none'); show('tripFinishFields', 'grid'); show('tripAlreadyStarted', 'block');
    $('tripAlreadyStarted').textContent = 'Started ' + fmtDateTime(b.actualPickup) + ' at ' + b.startKm + ' km.';
    $('submitTrip').textContent = 'Save finish details';
    $('t-finish-date').value = localDateInput(now);
    $('t-finish-time').value = localTimeInput(now);
    $('t-finish-km').value = '';
    $('t-finish-notes').value = '';
    $('t-fuel-yes').checked = false;
    $('t-fuel-no').checked = false;
  } else {
    $('tripModalTitle').textContent = 'Edit trip log';
    show('tripStartFields', 'grid'); show('tripFinishFields', 'grid'); show('tripAlreadyStarted', 'none');
    $('submitTrip').textContent = 'Save trip log';
    const s = new Date(b.actualPickup), f = new Date(b.actualReturn);
    $('t-start-date').value = localDateInput(s); $('t-start-time').value = localTimeInput(s);
    $('t-start-km').value = b.startKm; $('t-start-notes').value = b.startNotes || '';
    $('t-finish-date').value = localDateInput(f); $('t-finish-time').value = localTimeInput(f);
    $('t-finish-km').value = b.finishKm; $('t-finish-notes').value = b.finishNotes || '';
    $('t-fuel-yes').checked = b.fuelOk === true;
    $('t-fuel-no').checked = b.fuelOk === false;
  }
  overlayTrip.classList.add('open');
}
$('closeTrip').addEventListener('click', () => overlayTrip.classList.remove('open'));
$('cancelTrip').addEventListener('click', () => overlayTrip.classList.remove('open'));
overlayTrip.addEventListener('click', (e) => { if (e.target === overlayTrip) overlayTrip.classList.remove('open'); });

$('submitTrip').addEventListener('click', () => busy($('submitTrip'), async () => {
  clearError('tripError');
  const payload = {};
  if (tripMode !== 'finish') {
    const d = $('t-start-date').value, t = $('t-start-time').value, km = $('t-start-km').value;
    if (!d || !t || km === '') { showError('tripError', 'Fill in the start time and odometer reading.'); return; }
    payload.actualPickup = new Date(d + 'T' + t).toISOString();
    payload.startKm = Number(km);
    payload.startNotes = $('t-start-notes').value;
  }
  if (tripMode !== 'start') {
    const d = $('t-finish-date').value, t = $('t-finish-time').value, km = $('t-finish-km').value;
    const fuel = document.querySelector('input[name="fuelOk"]:checked');
    if (!d || !t || km === '') { showError('tripError', 'Fill in the finish time and odometer reading.'); return; }
    if (!fuel) { showError('tripError', 'Confirm whether the car has at least a quarter tank of fuel before saving.'); return; }
    payload.actualReturn = new Date(d + 'T' + t).toISOString();
    payload.finishKm = Number(km);
    payload.finishNotes = $('t-finish-notes').value;
    payload.fuelOk = fuel.value === 'yes';
  }
  try {
    await api('PUT', '/api/bookings/' + tripBookingId + '/trip', payload);
  } catch (err) {
    showError('tripError', err.message);
    return;
  }
  overlayTrip.classList.remove('open');
  await refreshBookings();
}));

// ---------- week navigation ----------

$('prevWeek').addEventListener('click', () => { weekStart = addDays(weekStart, -7); renderBoard(); });
$('nextWeek').addEventListener('click', () => { weekStart = addDays(weekStart, 7); renderBoard(); });
$('todayBtn').addEventListener('click', () => { weekStart = startOfWeek(new Date()); renderBoard(); });

// ---------- admin: fleet ----------

$('fleetTabActive').addEventListener('click', () => { fleetTab = 'active'; renderFleetPanel(); });
$('fleetTabArchived').addEventListener('click', () => { fleetTab = 'archived'; renderFleetPanel(); });

const overlayVehicle = $('overlayVehicle');
function openVehicleModal(vehicleId) {
  editingVehicleId = vehicleId || null;
  clearError('vehicleError');
  if (editingVehicleId) {
    const v = getVehicle(editingVehicleId);
    $('vehicleModalTitle').textContent = 'Edit vehicle';
    $('v-rego').value = v.rego; $('v-model').value = v.model;
    $('archiveVehicleBtn').style.display = v.archived ? 'none' : 'inline-block';
  } else {
    $('vehicleModalTitle').textContent = 'Add vehicle';
    $('v-rego').value = ''; $('v-model').value = '';
    $('archiveVehicleBtn').style.display = 'none';
  }
  overlayVehicle.classList.add('open');
}
$('addVehicleBtn').addEventListener('click', () => openVehicleModal(null));
$('closeVehicle').addEventListener('click', () => overlayVehicle.classList.remove('open'));
$('cancelVehicle').addEventListener('click', () => overlayVehicle.classList.remove('open'));
overlayVehicle.addEventListener('click', (e) => { if (e.target === overlayVehicle) overlayVehicle.classList.remove('open'); });

$('submitVehicle').addEventListener('click', () => busy($('submitVehicle'), async () => {
  const body = { rego: $('v-rego').value, model: $('v-model').value };
  try {
    if (editingVehicleId) await api('PUT', '/api/vehicles/' + editingVehicleId, body);
    else await api('POST', '/api/vehicles', body);
  } catch (err) { showError('vehicleError', err.message); return; }
  overlayVehicle.classList.remove('open');
  await loadVehicles();
  renderAll();
}));
$('archiveVehicleBtn').addEventListener('click', () => busy($('archiveVehicleBtn'), async () => {
  if (!editingVehicleId) return;
  try { await api('POST', '/api/vehicles/' + editingVehicleId + '/archive'); } catch (err) { showError('vehicleError', err.message); return; }
  overlayVehicle.classList.remove('open');
  fleetTab = 'active';
  await loadVehicles();
  renderAll();
}));

// ---------- admin: alert recipients ----------

const overlayAdminProfile = $('overlayAdminProfile');
let editingAdminProfileId = null;

function openAdminProfileModal(profileId) {
  editingAdminProfileId = profileId || null;
  clearError('adminProfileError');
  if (editingAdminProfileId) {
    const p = adminProfiles.find(x => x.id === editingAdminProfileId);
    $('adminProfileModalTitle').textContent = 'Edit admin profile';
    $('ap-name').value = p.name; $('ap-email').value = p.email;
    $('removeAdminProfileBtn').style.display = 'inline-block';
  } else {
    $('adminProfileModalTitle').textContent = 'Add admin profile';
    $('ap-name').value = ''; $('ap-email').value = '';
    $('removeAdminProfileBtn').style.display = 'none';
  }
  overlayAdminProfile.classList.add('open');
}
$('addAdminProfileBtn').addEventListener('click', () => openAdminProfileModal(null));
$('closeAdminProfile').addEventListener('click', () => overlayAdminProfile.classList.remove('open'));
$('cancelAdminProfile').addEventListener('click', () => overlayAdminProfile.classList.remove('open'));
overlayAdminProfile.addEventListener('click', (e) => { if (e.target === overlayAdminProfile) overlayAdminProfile.classList.remove('open'); });

$('submitAdminProfile').addEventListener('click', () => busy($('submitAdminProfile'), async () => {
  const body = { name: $('ap-name').value, email: $('ap-email').value };
  try {
    if (editingAdminProfileId) await api('PUT', '/api/admin-profiles/' + editingAdminProfileId, body);
    else await api('POST', '/api/admin-profiles', body);
  } catch (err) { showError('adminProfileError', err.message); return; }
  overlayAdminProfile.classList.remove('open');
  adminProfiles = await api('GET', '/api/admin-profiles');
  renderAll();
}));
$('removeAdminProfileBtn').addEventListener('click', () => busy($('removeAdminProfileBtn'), async () => {
  if (!editingAdminProfileId) return;
  try { await api('DELETE', '/api/admin-profiles/' + editingAdminProfileId); } catch (err) { showError('adminProfileError', err.message); return; }
  overlayAdminProfile.classList.remove('open');
  adminProfiles = await api('GET', '/api/admin-profiles');
  renderAll();
}));

// ---------- admin: company vehicles and allocations ----------

const overlayCompanyVehicle = $('overlayCompanyVehicle');
let editingCompanyVehicleId = null;

function openCompanyVehicleModal(vehicleId) {
  editingCompanyVehicleId = vehicleId || null;
  clearError('companyVehicleError');
  if (editingCompanyVehicleId) {
    const v = getCompanyVehicle(editingCompanyVehicleId);
    $('companyVehicleModalTitle').textContent = 'Edit company vehicle';
    $('cv-rego').value = v.rego; $('cv-model').value = v.model; $('cv-due-service').value = v.dueServiceKm || '';
    $('removeCompanyVehicleBtn').style.display = 'inline-block';
  } else {
    $('companyVehicleModalTitle').textContent = 'Add company vehicle';
    $('cv-rego').value = ''; $('cv-model').value = ''; $('cv-due-service').value = '';
    $('removeCompanyVehicleBtn').style.display = 'none';
  }
  overlayCompanyVehicle.classList.add('open');
}
$('addCompanyVehicleBtn').addEventListener('click', () => openCompanyVehicleModal(null));
$('closeCompanyVehicle').addEventListener('click', () => overlayCompanyVehicle.classList.remove('open'));
$('cancelCompanyVehicle').addEventListener('click', () => overlayCompanyVehicle.classList.remove('open'));
overlayCompanyVehicle.addEventListener('click', (e) => { if (e.target === overlayCompanyVehicle) overlayCompanyVehicle.classList.remove('open'); });

async function reloadCompanyAdmin() {
  [companyVehicles, companyCarAllocations, companyCarActivity] = await Promise.all([
    api('GET', '/api/company-vehicles'), api('GET', '/api/company-allocations'), api('GET', '/api/company-car/activity'),
  ]);
  renderAll();
}

$('submitCompanyVehicle').addEventListener('click', () => busy($('submitCompanyVehicle'), async () => {
  const body = { rego: $('cv-rego').value, model: $('cv-model').value, dueServiceKm: $('cv-due-service').value };
  try {
    if (editingCompanyVehicleId) await api('PUT', '/api/company-vehicles/' + editingCompanyVehicleId, body);
    else await api('POST', '/api/company-vehicles', body);
  } catch (err) { showError('companyVehicleError', err.message); return; }
  overlayCompanyVehicle.classList.remove('open');
  await reloadCompanyAdmin();
}));
$('removeCompanyVehicleBtn').addEventListener('click', () => busy($('removeCompanyVehicleBtn'), async () => {
  if (!editingCompanyVehicleId) return;
  if (!confirm('Remove this vehicle? Any allocation to it is removed too.')) return;
  try { await api('DELETE', '/api/company-vehicles/' + editingCompanyVehicleId); } catch (err) { showError('companyVehicleError', err.message); return; }
  overlayCompanyVehicle.classList.remove('open');
  await reloadCompanyAdmin();
}));

const overlayAllocation = $('overlayAllocation');
let editingAllocationId = null;

function openAllocationModal(allocationId) {
  editingAllocationId = allocationId || null;
  clearError('allocationError');
  $('al-vehicle').innerHTML = companyVehicles.map(v => '<option value="' + v.id + '">' + escapeHtml(v.rego) + ' — ' + escapeHtml(v.model) + '</option>').join('');
  if (editingAllocationId) {
    const a = companyCarAllocations.find(x => x.id === editingAllocationId);
    $('allocationModalTitle').textContent = 'Edit allocation';
    $('al-name').value = a.name; $('al-email').value = a.email; $('al-vehicle').value = String(a.vehicleId);
    $('removeAllocationBtn').style.display = 'inline-block';
  } else {
    $('allocationModalTitle').textContent = 'Add allocation';
    $('al-name').value = ''; $('al-email').value = '';
    $('removeAllocationBtn').style.display = 'none';
  }
  overlayAllocation.classList.add('open');
}
$('addAllocationBtn').addEventListener('click', () => openAllocationModal(null));
$('closeAllocation').addEventListener('click', () => overlayAllocation.classList.remove('open'));
$('cancelAllocation').addEventListener('click', () => overlayAllocation.classList.remove('open'));
overlayAllocation.addEventListener('click', (e) => { if (e.target === overlayAllocation) overlayAllocation.classList.remove('open'); });

$('submitAllocation').addEventListener('click', () => busy($('submitAllocation'), async () => {
  const body = { name: $('al-name').value, email: $('al-email').value, vehicleId: Number($('al-vehicle').value) };
  try {
    if (editingAllocationId) await api('PUT', '/api/company-allocations/' + editingAllocationId, body);
    else await api('POST', '/api/company-allocations', body);
  } catch (err) { showError('allocationError', err.message); return; }
  overlayAllocation.classList.remove('open');
  await reloadCompanyAdmin();
}));
$('removeAllocationBtn').addEventListener('click', () => busy($('removeAllocationBtn'), async () => {
  if (!editingAllocationId) return;
  try { await api('DELETE', '/api/company-allocations/' + editingAllocationId); } catch (err) { showError('allocationError', err.message); return; }
  overlayAllocation.classList.remove('open');
  await reloadCompanyAdmin();
}));

// ---------- admin: alert webhook and policy document ----------

$('saveWebhookBtn').addEventListener('click', () => busy($('saveWebhookBtn'), async () => {
  try {
    alertsState.webhookUrl = (await api('PUT', '/api/alerts/webhook', { url: $('alert-webhook').value })).webhookUrl;
    $('saveWebhookBtn').textContent = 'Saved';
    setTimeout(() => { $('saveWebhookBtn').textContent = 'Save'; }, 1500);
  } catch (err) { alert(err.message); }
}));

const policyDropzone = $('policyDropzone');
const policyFileInput = $('policyFileInput');
const POLICY_PDF_MAX_BYTES = 5 * 1024 * 1024;

async function handlePolicyFile(file) {
  clearError('policyDocError');
  if (!(file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) { showError('policyDocError', 'Please choose a PDF file.'); return; }
  if (file.size > POLICY_PDF_MAX_BYTES) { showError('policyDocError', 'That PDF is too large — please keep it under 5MB.'); return; }
  try {
    const res = await fetch('/api/policy', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'X-Requested-By': 'nst-app', 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    policyMeta = data;
  } catch (err) { showError('policyDocError', err.message); return; }
  renderPolicyDocPanel();
}
policyDropzone.addEventListener('click', () => policyFileInput.click());
policyFileInput.addEventListener('change', () => {
  if (policyFileInput.files[0]) handlePolicyFile(policyFileInput.files[0]);
  policyFileInput.value = '';
});
policyDropzone.addEventListener('dragover', (e) => { e.preventDefault(); policyDropzone.classList.add('dragover'); });
policyDropzone.addEventListener('dragleave', () => policyDropzone.classList.remove('dragover'));
policyDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  policyDropzone.classList.remove('dragover');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handlePolicyFile(file);
});
$('viewPolicyDocBtn').addEventListener('click', () => { if (policyMeta) window.open('/api/policy/file', '_blank', 'noopener'); });
$('removePolicyDocBtn').addEventListener('click', async () => {
  if (!confirm('Remove the policy document? New drivers will see a placeholder until another is uploaded.')) return;
  try { await api('DELETE', '/api/policy'); policyMeta = null; } catch (err) { showError('policyDocError', err.message); }
  renderPolicyDocPanel();
});

// ---------- company car (driver) ----------

const PRESTART_ITEMS = [
  { id: 'tyres', label: 'Tyres & tread' },
  { id: 'lights', label: 'Lights & indicators' },
  { id: 'brakes', label: 'Brakes' },
  { id: 'fluids', label: 'Oil & fluid levels' },
  { id: 'mirrors', label: 'Mirrors & windscreen' },
  { id: 'presentable', label: 'Presentable condition — inside & out' },
  { id: 'dents', label: 'No new dents or scratches' },
];

async function loadCompanyCarMe() { companyCarMe = await api('GET', '/api/company-car/me'); }

function renderCompanyCarVehicle() {
  const box = $('companyCarVehicleInfo');
  const vehicle = companyCarMe.vehicle;
  if (!vehicle) {
    box.innerHTML = '<div class="data-note">No vehicle is currently allocated to you. Contact your admin to have one assigned.</div>';
    return;
  }
  box.innerHTML =
    '<div class="cc-vehicle-box"><span class="plate">' + escapeHtml(vehicle.rego) + '</span>' +
    '<div><div style="font-weight:600;">' + escapeHtml(session.name) + '</div>' +
    '<div class="vehicle-model">' + escapeHtml(vehicle.model || '') + '</div></div></div>' +
    (vehicle.dueServiceKm ? '<div class="data-note" style="margin-top:10px;">Next service due at <span class="km-value">' + vehicle.dueServiceKm + ' km</span>.</div>' : '');
}

function renderCompanyCarPrestart() {
  const area = $('companyCarPrestartArea');
  const monthKey = companyCarMe.monthKey;
  const existing = companyCarMe.prestart;

  if (!companyCarMe.vehicle) {
    area.innerHTML = '<div class="data-note">Prestart checks are available once a company vehicle is allocated to you.</div>';
    return;
  }
  if (existing) {
    const failed = failedPrestartItems(existing);
    area.innerHTML =
      '<div class="data-note" style="margin-bottom:10px;">Completed for ' + monthKeyLabel(monthKey) + ' on ' + fmtDateTime(existing.submittedAt) + '.</div>' +
      (failed.length
        ? '<div class="flag-badge" style="margin-bottom:10px;">Issues flagged: ' + failed.map(f => escapeHtml(f.label)).join(', ') + '</div>' +
          (existing.mexNumber ? '<div class="data-note">Mex #: ' + escapeHtml(existing.mexNumber) + '</div>' : '') +
          '<div class="data-note">' + (existing.faultCompleted ? '<span class="status-tag approved">Fault completed</span>' : '<span class="status-tag pending">Fault not yet completed</span>') + '</div>'
        : '<span class="status-tag approved">All items OK</span>') +
      (existing.notes ? '<div class="data-note" style="margin-top:10px;">Notes: ' + escapeHtml(existing.notes) + '</div>' : '');
    return;
  }

  area.innerHTML =
    '<div class="error-msg" id="prestartError"></div>' +
    '<div class="checklist" id="prestartChecklist">' +
      PRESTART_ITEMS.map(item => '<label class="checklist-item"><input type="checkbox" checked data-item="' + item.id + '"> ' + escapeHtml(item.label) + '</label>').join('') +
    '</div>' +
    '<div class="field full" style="margin-bottom:10px;"><label for="prestart-notes">Notes — describe any dents, scratches, or other issues found</label>' +
      '<textarea id="prestart-notes" placeholder="Leave blank if everything checked out"></textarea></div>' +
    '<div id="prestartFaultSection" style="display:none;margin-bottom:14px;">' +
      '<div class="form-grid" style="grid-template-columns:1fr;"><div class="field"><label for="prestart-mex">Mex #</label>' +
        '<input id="prestart-mex" type="text" placeholder="Maintenance exception reference number"></div></div>' +
      '<label class="checklist-item" style="margin-top:10px;"><input type="checkbox" id="prestart-fault-completed"> Fault completed</label>' +
    '</div>' +
    '<div class="data-note" style="margin-bottom:14px;">Any issues found must be reported to the Transport Department.</div>' +
    '<button class="btn-primary" id="submitPrestartBtn">Submit prestart check for ' + monthKeyLabel(monthKey) + '</button>';

  const boxes = () => Array.from(document.querySelectorAll('#prestartChecklist input[type="checkbox"]'));
  boxes().forEach(cb => cb.addEventListener('change', () => {
    $('prestartFaultSection').style.display = boxes().some(c => !c.checked) ? 'block' : 'none';
  }));

  $('submitPrestartBtn').addEventListener('click', () => busy($('submitPrestartBtn'), async () => {
    const items = {};
    boxes().forEach(cb => { items[cb.dataset.item] = cb.checked; });
    const hasFault = Object.values(items).some(v => !v);
    try {
      await api('POST', '/api/company-car/prestart', {
        items, notes: $('prestart-notes').value,
        mexNumber: hasFault ? $('prestart-mex').value : '',
        faultCompleted: hasFault ? $('prestart-fault-completed').checked : false,
      });
      await loadCompanyCarMe();
    } catch (err) { showError('prestartError', err.message); return; }
    renderCompanyCarApp();
  }));
}

function renderCompanyCarKm() {
  const area = $('companyCarKmArea');
  const { monthKey, vehicle, km } = companyCarMe;
  const existing = km.find(k => k.monthKey === monthKey);
  const latest = km[0] || null; // newest first

  if (!vehicle) {
    area.innerHTML = '<div class="data-note">Kilometre readings are available once a company vehicle is allocated to you.</div>';
    return;
  }

  let html = '';
  if (vehicle.dueServiceKm && latest) {
    const remaining = vehicle.dueServiceKm - latest.odometer;
    html += remaining <= 0
      ? '<div class="flag-badge" style="margin-bottom:14px;">Service overdue — due at ' + vehicle.dueServiceKm + ' km, currently ' + latest.odometer + ' km</div>'
      : '<div class="data-note" style="margin-bottom:14px;">' + remaining + ' km until next service (due at ' + vehicle.dueServiceKm + ' km).</div>';
  }
  if (existing) {
    html += '<div class="data-note" style="margin-bottom:14px;">Recorded for ' + monthKeyLabel(monthKey) + ': <span class="km-value">' + existing.odometer + ' km</span> on ' + fmtDateTime(existing.submittedAt) + '.</div>';
  } else {
    html +=
      '<div class="error-msg" id="kmError"></div>' +
      '<div class="form-grid" style="grid-template-columns:1fr auto;align-items:end;">' +
        '<div class="field"><label for="km-reading">Current odometer reading (km)</label>' +
        '<input id="km-reading" type="number" min="0" step="1" placeholder="e.g. 62150"></div>' +
        '<button class="btn-primary" id="submitKmBtn" style="padding:9px 16px;">Submit</button>' +
      '</div>';
  }
  if (km.length > 0) {
    html += '<div class="cc-history"><table><thead><tr><th>Month</th><th>Odometer</th></tr></thead><tbody>' +
      km.map(k => '<tr><td>' + monthKeyLabel(k.monthKey) + '</td><td class="km-value">' + k.odometer + ' km</td></tr>').join('') +
      '</tbody></table></div>';
  }
  area.innerHTML = html;

  if (!existing) {
    $('submitKmBtn').addEventListener('click', () => busy($('submitKmBtn'), async () => {
      clearError('kmError');
      const val = $('km-reading').value;
      if (val === '') { showError('kmError', 'Enter a valid odometer reading.'); return; }
      try {
        await api('POST', '/api/company-car/km', { odometer: Number(val) });
        await loadCompanyCarMe();
      } catch (err) { showError('kmError', err.message); return; }
      renderCompanyCarApp();
    }));
  }
}

function renderCompanyCarApp() {
  renderCompanyCarVehicle();
  renderCompanyCarPrestart();
  renderCompanyCarKm();
}

// ---------- incidents ----------

const INCIDENT_WEATHER_OPTIONS = ['Dry / Sunny', 'Wet / Raining', 'Foggy', 'Overcast', 'Other'];
const INCIDENT_ROAD_SURFACE_OPTIONS = ['Sealed / Asphalt', 'Gravel', 'Dirt', 'Uneven', 'Muddy / Boggy'];
const INCIDENT_VISIBILITY_OPTIONS = ['Clear', 'Drastically Reduced', 'Night (Streetlights ON)', 'Night (Streetlights OFF)'];
let incidentJustSubmitted = false;

function radioGroupHtml(name, options, otherFieldId) {
  return options.map(opt => {
    const isOther = opt === 'Other';
    const id = name + '-' + opt.replace(/[^a-z0-9]+/gi, '').toLowerCase();
    return '<label class="checklist-item"><input type="radio" name="' + name + '" value="' + escapeHtml(opt) + '" id="' + id + '"' +
      (isOther ? ' data-other-toggle="' + otherFieldId + '"' : '') + '> ' + escapeHtml(opt) + '</label>';
  }).join('');
}

function renderIncidentForm() {
  const panel = $('incidentFormPanel');
  const h3 = '<h3 style="font-family:\'Archivo Narrow\',sans-serif;font-size:14px;margin:4px 0 12px;">';
  panel.innerHTML =
    '<div class="panel-title"><span>New incident report</span></div>' +
    (incidentJustSubmitted ? '<div class="data-note" style="color:var(--green);margin:0 0 14px;">Incident report submitted. Thank you.</div>' : '') +
    '<div class="error-msg" id="incidentError"></div>' +
    '<div class="field full" style="margin-bottom:22px;"><label for="incident-description">Brief description of incident</label>' +
      '<textarea id="incident-description" placeholder="What happened, in a few sentences"></textarea></div>' +
    h3 + '4. Environment &amp; road conditions</h3>' +
    '<div class="field full" style="margin-bottom:14px;"><label>Weather conditions</label>' +
      '<div class="checklist">' + radioGroupHtml('incident-weather', INCIDENT_WEATHER_OPTIONS, 'incident-weather-other-text') + '</div>' +
      '<input type="text" id="incident-weather-other-text" placeholder="Describe other weather condition" style="display:none;margin-top:8px;"></div>' +
    '<div class="field full" style="margin-bottom:14px;"><label>Road surface</label>' +
      '<div class="checklist">' + radioGroupHtml('incident-road-surface', INCIDENT_ROAD_SURFACE_OPTIONS) + '</div></div>' +
    '<div class="field" style="margin-bottom:14px;max-width:220px;"><label for="incident-speed-limit">Speed limit allowed (km/h)</label>' +
      '<input type="number" min="0" step="1" id="incident-speed-limit"></div>' +
    '<div class="field full" style="margin-bottom:22px;"><label>Visibility</label>' +
      '<div class="checklist">' + radioGroupHtml('incident-visibility', INCIDENT_VISIBILITY_OPTIONS) + '</div></div>' +
    h3 + '5. Third-party details (if applicable)</h3>' +
    '<div class="form-grid" style="margin-bottom:22px;">' +
      '<div class="field full"><label for="tp-name">Third-party driver name</label><input type="text" id="tp-name"></div>' +
      '<div class="field"><label for="tp-phone">Phone number</label><input type="tel" id="tp-phone"></div>' +
      '<div class="field"><label for="tp-email">Email</label><input type="email" id="tp-email"></div>' +
      '<div class="field full"><label for="tp-licence">Licence number &amp; state</label><input type="text" id="tp-licence"></div>' +
      '<div class="field full"><label for="tp-rego">Vehicle registration / plate number</label><input type="text" id="tp-rego"></div>' +
      '<div class="field full"><label for="tp-vehicle">Vehicle make, model, colour</label><input type="text" id="tp-vehicle"></div>' +
      '<div class="field"><label for="tp-insurer">Insurance company</label><input type="text" id="tp-insurer"></div>' +
      '<div class="field"><label for="tp-policy">Policy number</label><input type="text" id="tp-policy"></div>' +
    '</div>' +
    '<button class="btn-primary" id="submitIncidentBtn">Submit incident report</button>';

  panel.querySelectorAll('input[type="radio"][name="incident-weather"]').forEach(radio => {
    radio.addEventListener('change', () => {
      $('incident-weather-other-text').style.display = radio.dataset.otherToggle ? 'block' : 'none';
    });
  });

  $('submitIncidentBtn').addEventListener('click', () => busy($('submitIncidentBtn'), async () => {
    clearError('incidentError');
    const radioValue = (name) => { const c = panel.querySelector('input[name="' + name + '"]:checked'); return c ? c.value : ''; };
    if (!$('incident-description').value.trim()) { showError('incidentError', 'Enter a brief description of the incident.'); return; }
    const val = (id) => $(id).value.trim();
    try {
      await api('POST', '/api/incidents', {
        description: val('incident-description'),
        weather: radioValue('incident-weather'), weatherOther: val('incident-weather-other-text'),
        roadSurface: radioValue('incident-road-surface'), speedLimit: val('incident-speed-limit'),
        visibility: radioValue('incident-visibility'),
        thirdParty: {
          name: val('tp-name'), phone: val('tp-phone'), email: val('tp-email'), licence: val('tp-licence'),
          rego: val('tp-rego'), vehicle: val('tp-vehicle'), insurer: val('tp-insurer'), policy: val('tp-policy'),
        },
      });
      incidentReports = await api('GET', '/api/incidents');
    } catch (err) { showError('incidentError', err.message); return; }
    incidentJustSubmitted = true;
    renderIncidentApp();
    incidentJustSubmitted = false;
    window.scrollTo(0, 0);
  }));
}

function renderIncidentMyReports() {
  const tbody = $('incidentMyReportsBody');
  if (incidentReports.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No incident reports submitted yet.</td></tr>';
    return;
  }
  tbody.innerHTML = incidentReports.map(r =>
    '<tr><td>' + fmtDateTime(r.submittedAt) + '</td><td>' + escapeHtml(truncateText(r.description, 60)) + '</td>' +
    '<td>' + (r.thirdParty.name ? escapeHtml(r.thirdParty.name) : '—') + '</td>' +
    '<td><button class="btn-ghost" data-view-incident="' + r.id + '" style="padding:5px 10px;font-size:12px;">View</button></td></tr>').join('');
  tbody.querySelectorAll('[data-view-incident]').forEach(btn => btn.addEventListener('click', () => openIncidentDetail(Number(btn.dataset.viewIncident))));
}

function renderIncidentApp() {
  renderIncidentForm();
  renderIncidentMyReports();
}

function openIncidentDetail(reportId) {
  const r = incidentReports.find(x => x.id === reportId);
  if (!r) return;
  const h3 = '<h3 style="font-family:\'Archivo Narrow\',sans-serif;font-size:13.5px;margin:0 0 8px;">';
  const tp = r.thirdParty;
  $('incidentDetailBody').innerHTML =
    '<div class="data-note" style="margin-bottom:14px;">Submitted by ' + escapeHtml(r.name) + ' on ' + fmtDateTime(r.submittedAt) + '</div>' +
    h3 + 'Description</h3>' +
    '<div class="data-note" style="margin-bottom:18px;color:var(--ink);">' + escapeHtml(r.description || '—') + '</div>' +
    h3 + 'Environment &amp; road conditions</h3>' +
    '<table class="upcoming" style="margin-bottom:18px;"><tbody>' +
      '<tr><td>Weather</td><td>' + escapeHtml(r.weather === 'Other' ? (r.weatherOther || '—') + ' (Other)' : (r.weather || '—')) + '</td></tr>' +
      '<tr><td>Road surface</td><td>' + escapeHtml(r.roadSurface || '—') + '</td></tr>' +
      '<tr><td>Speed limit allowed</td><td>' + escapeHtml(r.speedLimit ? r.speedLimit + ' km/h' : '—') + '</td></tr>' +
      '<tr><td>Visibility</td><td>' + escapeHtml(r.visibility || '—') + '</td></tr>' +
    '</tbody></table>' +
    h3 + 'Third-party details</h3>' +
    (tp.name || tp.phone || tp.rego
      ? '<table class="upcoming"><tbody>' +
        [['Driver name', tp.name], ['Phone', tp.phone], ['Email', tp.email], ['Licence &amp; state', tp.licence],
          ['Vehicle rego', tp.rego], ['Vehicle make/model/colour', tp.vehicle], ['Insurer', tp.insurer], ['Policy number', tp.policy]]
          .map(([label, value]) => '<tr><td>' + label + '</td><td>' + escapeHtml(value || '—') + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="data-note">No third party was recorded for this incident.</div>');
  $('overlayIncidentDetail').classList.add('open');
}
for (const id of ['closeIncidentDetail', 'closeIncidentDetail2']) {
  $(id).addEventListener('click', () => $('overlayIncidentDetail').classList.remove('open'));
}
$('overlayIncidentDetail').addEventListener('click', (e) => { if (e.target === $('overlayIncidentDetail')) $('overlayIncidentDetail').classList.remove('open'); });

// ---------- boot ----------

async function init() {
  try { authConfig = await api('GET', '/api/auth/config'); } catch (e) { /* keep defaults */ }
  renderEnvBadge();
  renderTestLogins();
  try {
    const user = await api('GET', '/api/me');
    await afterSignIn(user);
  } catch (err) {
    if (err.status === 401 && authConfig.mode === 'gateway') {
      $('loginForm').style.display = 'none';
      showLogin('Sign in with your Neumann account to continue.');
      $('loginError').insertAdjacentHTML('afterend', '<a class="btn-primary landing-btn" style="text-align:center;text-decoration:none;" href="/.auth/login/aad">Sign in with Microsoft</a>');
    } else if (err.status === 401) {
      showLogin();
    } else {
      showLogin('Could not reach the server. Please refresh and try again.');
    }
  }
}
init();
