/* ==========================================================================
   PUNCHLINE — app.js
   A single-file, no-build, offline-first time clock for a lawn-care operator.

   Section map
     1.  Constants & tiny utilities
     2.  IndexedDB promise wrapper + data layer
     3.  Engine: rounding, paid minutes, pay splitting, pay periods, overlap
     4.  Geo: haversine, geofence runtime, mileage
     5.  UI primitives: ticker, toast, sheet, confirm, forms
     6.  Router + chrome
     7.  View: Clock
     8.  View: Shifts (+ shift editor)
     9.  View: Jobs (customers / job sites / profitability)
     10. View: Money (pay period, expenses, exports, invoice)
     11. View: Insights (nudges, stats, hand-drawn SVG charts)
     12. View: Settings (rules, crew, equipment, backup/restore)
     13. Boot
   ========================================================================== */
(function () {
'use strict';

/* ==========================================================================
   1. CONSTANTS & TINY UTILITIES
   ========================================================================== */

var DB_NAME = 'punchline';
var DB_VERSION = 1;
var STORES = ['customers', 'jobSites', 'employees', 'shifts', 'expenses',
              'equipment', 'equipUsage', 'mileage', 'meta'];

var LS_ACTIVE = 'punchline.active';   // quick-read mirror of the open punch
var LS_ONBOARD = 'punchline.onboarded';

var EXPENSE_CATEGORIES = ['Fuel', 'Parts', 'Supplies', 'Dump Fee', 'Equipment', 'Other'];
var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var PALETTE = ['#34c759','#0a84ff','#ff9f0a','#ff375f','#bf5af2','#5ac8fa','#ffd60a','#ff6b35','#30d158','#64d2ff'];

var MS_MIN = 60000, MS_HOUR = 3600000, MS_DAY = 86400000;
var ROAD_FACTOR = 1.25;               // straight-line -> road distance fudge

var DEFAULT_SETTINGS = {
  payPeriod: 'weekly',
  periodAnchor: null,                 // filled at first boot with a local Sunday
  weeklyOTThreshold: 40,
  dailyOTThreshold: 0,
  otMultiplier: 1.5,
  dtThreshold: 0,
  dtMultiplier: 2.0,
  rounding: 'none',
  roundingMode: 'nearest',
  autoBreakMinutes: 0,
  autoBreakAfterHours: 0,
  mileageRate: 0.70,
  geoEnabled: false,
  geoMode: 'ask',
  currency: 'USD',
  maxShiftHours: 14
};

function uid(prefix) {
  var r = '';
  if (window.crypto && crypto.getRandomValues) {
    var a = new Uint8Array(9); crypto.getRandomValues(a);
    for (var i = 0; i < a.length; i++) r += a[i].toString(36);
  } else {
    r = Math.random().toString(36).slice(2);
  }
  return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + r.slice(0, 8);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : (d || 0); }
function int(v, d) { var n = parseInt(v, 10); return isFinite(n) ? n : (d || 0); }
function by(key) { return function (a, b) { return a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0; }; }
function sum(arr, f) { var t = 0; for (var i = 0; i < arr.length; i++) t += f ? f(arr[i]) : arr[i]; return t; }
function uniq(arr) { return arr.filter(function (v, i) { return arr.indexOf(v) === i; }); }

/* ---- money / duration formatting ---------------------------------------- */
var _cur = null;
function money(n) {
  if (!_cur) {
    try {
      _cur = new Intl.NumberFormat(undefined, {
        style: 'currency', currency: (state.settings && state.settings.currency) || 'USD'
      });
    } catch (e) { _cur = { format: function (x) { return '$' + x.toFixed(2); } }; }
  }
  return _cur.format(isFinite(n) ? n : 0);
}
function money0(n) { return money(Math.round(isFinite(n) ? n : 0)); }

/** 8130000 ms -> "2:15:30" */
function hms(ms) {
  ms = Math.max(0, Math.floor(ms / 1000));
  var h = Math.floor(ms / 3600), m = Math.floor((ms % 3600) / 60), s = ms % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
/** minutes -> "2h 15m" */
function hm(mins) {
  mins = Math.round(mins || 0);
  var neg = mins < 0; mins = Math.abs(mins);
  var h = Math.floor(mins / 60), m = mins % 60;
  return (neg ? '-' : '') + (h ? h + 'h ' : '') + m + 'm';
}
/** hours (float) -> "7.25 h" style decimal, 2dp trimmed */
function hrs(h) {
  h = Math.round((h || 0) * 100) / 100;
  return (h % 1 === 0 ? h.toFixed(0) : h.toFixed(2)) + 'h';
}
function pct(n) { return (Math.round((n || 0) * 1000) / 10) + '%'; }

/* ---- date helpers (all local-time aware) -------------------------------- */
function startOfDay(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function endOfDay(ts) { return startOfDay(ts) + MS_DAY - 1; }
function addDays(ts, n) {
  // Calendar-safe: walk the date, not the epoch, so DST shifts don't drift.
  var d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime();
}
function dayDiff(a, b) { return Math.round((startOfDay(a) - startOfDay(b)) / MS_DAY); }
function sameDay(a, b) { return startOfDay(a) === startOfDay(b); }
function startOfMonth(ts) { var d = new Date(ts); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); }
function endOfMonth(ts) { var d = new Date(ts); d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); return d.getTime() - 1; }

function fmtTime(ts) {
  if (ts == null) return '—';
  var d = new Date(ts), h = d.getHours(), m = d.getMinutes();
  var ap = h < 12 ? 'AM' : 'PM'; var hh = h % 12; if (hh === 0) hh = 12;
  return hh + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
function fmtDay(ts) {
  var d = new Date(ts);
  return DOW[d.getDay()] + ' ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
}
function fmtDate(ts) {
  var d = new Date(ts);
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}
function fmtDateShort(ts) {
  var d = new Date(ts);
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2);
}
function isoLocalDate(ts) {
  var d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function isoLocalDateTime(ts) {
  var d = new Date(ts);
  return isoLocalDate(ts) + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
/** Parse "YYYY-MM-DDTHH:MM" / "YYYY-MM-DD" as LOCAL time (not UTC). */
function parseLocal(str) {
  if (!str) return null;
  var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(str);
  if (!m) { var t = Date.parse(str); return isFinite(t) ? t : null; }
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), 0, 0).getTime();
}
function median(arr) {
  if (!arr.length) return null;
  var a = arr.slice().sort(function (x, y) { return x - y; });
  var mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/* ---- dom ---------------------------------------------------------------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function on(el, ev, fn, opts) { if (el) el.addEventListener(ev, fn, opts); }
/**
 * Event delegation helper: delegate(root, 'click', '[data-x]', fn)
 * Views re-render into the SAME container element many times, so this is
 * deduplicated per (root, event, selector). Attaching twice would fire the
 * handler twice; registering once and letting it read the DOM at event time is
 * both cheaper and correct. Handlers must therefore not close over per-render
 * values — read fresh state inside the handler.
 */
function delegate(root, ev, sel, fn) {
  var key = ev + '|' + sel;
  if (!root.__deleg) root.__deleg = {};
  if (root.__deleg[key]) return;
  root.__deleg[key] = true;
  on(root, ev, function (e) {
    var t = e.target.closest ? e.target.closest(sel) : null;
    if (t && root.contains(t)) fn.call(t, e, t);
  });
}

/* ==========================================================================
   2. INDEXEDDB PROMISE WRAPPER + DATA LAYER
   ========================================================================== */

var idb = (function () {
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        STORES.forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' });
          }
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('IndexedDB blocked by another tab')); };
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var s = t.objectStore(store);
        var out;
        try { out = fn(s); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('aborted')); };
      });
    });
  }

  return {
    open: open,
    getAll: function (store) { return tx(store, 'readonly', function (s) { return s.getAll(); }); },
    get: function (store, key) { return tx(store, 'readonly', function (s) { return s.get(key); }); },
    put: function (store, val) { return tx(store, 'readwrite', function (s) { s.put(val); return val; }); },
    putAll: function (store, vals) {
      return tx(store, 'readwrite', function (s) { vals.forEach(function (v) { s.put(v); }); return vals.length; });
    },
    del: function (store, key) { return tx(store, 'readwrite', function (s) { s.delete(key); return key; }); },
    clear: function (store) { return tx(store, 'readwrite', function (s) { s.clear(); return true; }); },
    clearAll: function () { return Promise.all(STORES.map(function (n) { return tx(n, 'readwrite', function (s) { s.clear(); }); })); }
  };
})();

/* ---- in-memory mirror ---------------------------------------------------
   The whole dataset for one operator is small (thousands of rows at most), so
   everything is loaded once at boot and kept in memory. IndexedDB stays the
   source of truth; every mutation writes through immediately.
   ------------------------------------------------------------------------- */
var state = {
  settings: null,
  customers: [], jobSites: [], employees: [],
  shifts: [], expenses: [], equipment: [], equipUsage: [], mileage: [],
  ready: false,
  geo: { watchId: null, last: null, insideId: null, lastLeftSiteId: null, lastLeftAt: null, prompting: false },
  filterEmployeeId: 'all',
  route: 'clock'
};

function activePunch() {
  try {
    var raw = localStorage.getItem(LS_ACTIVE);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function setActivePunch(obj) {
  try {
    if (obj) localStorage.setItem(LS_ACTIVE, JSON.stringify(obj));
    else localStorage.removeItem(LS_ACTIVE);
  } catch (e) { /* private mode — the shift record is still in IndexedDB */ }
}
/** The authoritative open shift (localStorage is only a fast hint). */
function openShift(employeeId) {
  var eid = employeeId || selfEmployee().id;
  for (var i = 0; i < state.shifts.length; i++) {
    if (state.shifts[i].employeeId === eid && state.shifts[i].end == null) return state.shifts[i];
  }
  return null;
}
function selfEmployee() {
  return state.employees.filter(function (e) { return e.isSelf; })[0] || state.employees[0] || null;
}
function byId(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
function site(id) { return byId(state.jobSites, id); }
function customer(id) { return byId(state.customers, id); }
function employee(id) { return byId(state.employees, id); }
function siteName(id) { var s = site(id); return s ? s.name : 'Unassigned'; }
function siteColor(id) { var s = site(id); return s && s.colorHex ? s.colorHex : 'var(--text-3)'; }

/* ---- record factories (shapes mirror the native iOS sibling app) -------- */
function newCustomer(o) {
  o = o || {};
  return { id: o.id || uid('cus'), name: o.name || '', contact: o.contact || '', address: o.address || '',
           defaultBillRate: num(o.defaultBillRate, 0), notes: o.notes || '', archived: !!o.archived };
}
function newJobSite(o) {
  o = o || {};
  return { id: o.id || uid('js'), customerId: o.customerId || null, name: o.name || '', address: o.address || '',
           lat: o.lat == null ? null : num(o.lat), lng: o.lng == null ? null : num(o.lng),
           radiusMeters: int(o.radiusMeters, 120), billRate: num(o.billRate, 0),
           colorHex: o.colorHex || PALETTE[state.jobSites.length % PALETTE.length],
           notes: o.notes || '', archived: !!o.archived };
}
function newEmployee(o) {
  o = o || {};
  return { id: o.id || uid('emp'), name: o.name || 'Me', isSelf: !!o.isSelf, hourlyRate: num(o.hourlyRate, 0),
           colorHex: o.colorHex || PALETTE[0], phone: o.phone || '', active: o.active !== false };
}
function newShift(o) {
  o = o || {};
  var now = Date.now();
  return { id: o.id || uid('shf'), employeeId: o.employeeId || null, jobSiteId: o.jobSiteId || null,
           start: o.start || now, end: o.end === undefined ? null : o.end,
           breaks: o.breaks || [], notes: o.notes || '', photos: o.photos || [],
           source: o.source || 'manual', approved: !!o.approved, miles: num(o.miles, 0),
           driveMinutes: num(o.driveMinutes, 0), createdAt: o.createdAt || now, updatedAt: o.updatedAt || now };
}
function newExpense(o) {
  o = o || {};
  return { id: o.id || uid('exp'), shiftId: o.shiftId || null, jobSiteId: o.jobSiteId || null,
           date: o.date || Date.now(), category: o.category || 'Other', amount: num(o.amount, 0),
           note: o.note || '', receipt: o.receipt || null };
}
function newEquipment(o) {
  o = o || {};
  return { id: o.id || uid('eqp'), name: o.name || '', type: o.type || 'Mower',
           hourMeter: num(o.hourMeter, 0), serviceIntervalHours: num(o.serviceIntervalHours, 50),
           lastServiceHours: num(o.lastServiceHours, 0), notes: o.notes || '' };
}
function newEquipUsage(o) {
  o = o || {};
  return { id: o.id || uid('equ'), equipmentId: o.equipmentId || null, shiftId: o.shiftId || null, hours: num(o.hours, 0) };
}
function newMileage(o) {
  o = o || {};
  return { id: o.id || uid('mil'), date: o.date || Date.now(), fromJobSiteId: o.fromJobSiteId || null,
           toJobSiteId: o.toJobSiteId || null, miles: num(o.miles, 0), minutes: num(o.minutes, 0),
           ratePerMile: num(o.ratePerMile, state.settings ? state.settings.mileageRate : 0.7) };
}

/* ---- persistence helpers ------------------------------------------------ */
function saveSettings() {
  return idb.put('meta', { key: 'settings', value: state.settings });
}
function upsert(store, listName, rec) {
  var list = state[listName];
  var existing = byId(list, rec.id);
  if (existing) { var i = list.indexOf(existing); list[i] = rec; }
  else list.push(rec);
  return idb.put(store, rec);
}
function remove(store, listName, id) {
  var list = state[listName];
  var e = byId(list, id);
  if (e) list.splice(list.indexOf(e), 1);
  return idb.del(store, id);
}
function saveShift(sh) {
  sh.updatedAt = Date.now();
  return upsert('shifts', 'shifts', sh);
}

async function loadAll() {
  var metaSettings = await idb.get('meta', 'settings');
  state.settings = Object.assign({}, DEFAULT_SETTINGS, (metaSettings && metaSettings.value) || {});
  if (!state.settings.periodAnchor) {
    // Default anchor: the most recent Sunday at local midnight.
    var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay());
    state.settings.periodAnchor = d.getTime();
    await saveSettings();
  }
  var names = ['customers', 'jobSites', 'employees', 'shifts', 'expenses', 'equipment', 'equipUsage', 'mileage'];
  var results = await Promise.all(names.map(function (n) { return idb.getAll(n); }));
  names.forEach(function (n, i) { state[n] = results[i] || []; });

  // Seed a "Me" employee on very first run.
  if (!state.employees.length) {
    var me = newEmployee({ name: 'Me', isSelf: true, hourlyRate: 0, colorHex: PALETTE[0] });
    state.employees.push(me);
    await idb.put('employees', me);
  }
  state.shifts.sort(function (a, b) { return b.start - a.start; });
  state.ready = true;
}

/* ==========================================================================
   3. ENGINE — time math. Keep this section pure: no DOM, no I/O.
   ========================================================================== */

/**
 * roundMinutes(mins, rounding, mode)
 * Round a duration in minutes to an increment ('none' | '5' | '6' | '10' | '15')
 * using 'nearest' | 'up' | 'down'. 6-minute is the classic tenth-of-an-hour.
 * Negative input is clamped to 0 — a shift never has negative length.
 */
function roundMinutes(mins, rounding, mode) {
  mins = Math.max(0, num(mins, 0));
  var inc = parseInt(rounding, 10);
  if (!rounding || rounding === 'none' || !isFinite(inc) || inc <= 0) return mins;
  var q = mins / inc;
  if (mode === 'up') return Math.ceil(q) * inc;
  if (mode === 'down') return Math.floor(q) * inc;
  return Math.round(q) * inc;
}

/**
 * breakMinutes(shift, [nowTs]) -> { paid, unpaid }
 * Break windows are clipped to the shift so a mis-typed break can never eat
 * more time than the shift contains. An open break (no end) runs to `now`.
 */
function breakMinutes(shift, nowTs) {
  var now = nowTs || Date.now();
  var sEnd = shift.end == null ? now : shift.end;
  var paid = 0, unpaid = 0;
  (shift.breaks || []).forEach(function (b) {
    if (!b || b.start == null) return;
    var bs = clamp(b.start, shift.start, sEnd);
    var be = clamp(b.end == null ? now : b.end, shift.start, sEnd);
    var mins = Math.max(0, (be - bs) / MS_MIN);
    if (b.paid) paid += mins; else unpaid += mins;
  });
  return { paid: paid, unpaid: unpaid };
}

/**
 * paidMinutes(shift, settings, [nowTs])
 * Raw (unrounded) paid minutes: elapsed time minus unpaid breaks, minus the
 * automatic meal deduction when the shift is long enough AND the worker logged
 * no manual break of their own (a real logged break wins over the automatic
 * one, so time is never deducted twice).
 */
function paidMinutes(shift, settings, nowTs) {
  var now = nowTs || Date.now();
  var end = shift.end == null ? now : shift.end;
  var gross = Math.max(0, (end - shift.start) / MS_MIN);
  var br = breakMinutes(shift, now);
  var paid = gross - br.unpaid;

  var autoMin = num(settings.autoBreakMinutes, 0);
  var afterH = num(settings.autoBreakAfterHours, 0);
  var hasManualBreak = (shift.breaks || []).some(function (b) { return b && b.start != null; });
  if (autoMin > 0 && afterH > 0 && !hasManualBreak && gross / 60 >= afterH) {
    paid -= autoMin;
  }
  return Math.max(0, paid);
}

/** Paid minutes with the operator's rounding rule applied. Use for all pay. */
function roundedPaidMinutes(shift, settings, nowTs) {
  return roundMinutes(paidMinutes(shift, settings, nowTs), settings.rounding, settings.roundingMode);
}

/** Convenience: rounded paid HOURS for one shift. */
function shiftHours(shift, settings, nowTs) {
  return roundedPaidMinutes(shift, settings || state.settings, nowTs) / 60;
}

/**
 * splitPay(shiftsInWeek, employee, settings) -> { regular, ot, dt, gross, hours }
 *
 * Order of operations (matches how US wage rules stack):
 *   1. Daily first. Within each calendar day, hours past `dailyOTThreshold`
 *      become OT and hours past `dtThreshold` become double time.
 *   2. Weekly second, and ONLY on hours still classified as regular. Anything
 *      already paid as daily OT/DT is excluded so it can never be counted twice.
 *   3. gross = rate x (regular + ot*otMultiplier + dt*dtMultiplier).
 *
 * `shiftsInWeek` must already be the finished/open shifts for ONE employee in
 * ONE work week; grouping is the caller's job.
 */
function splitPay(shiftsInWeek, emp, settings) {
  var rate = emp ? num(emp.hourlyRate, 0) : 0;
  var dailyOT = num(settings.dailyOTThreshold, 0);
  var dtT = num(settings.dtThreshold, 0);
  var weeklyOT = num(settings.weeklyOTThreshold, 0);

  // --- 1. bucket hours by local calendar day -------------------------------
  var days = {};
  shiftsInWeek.forEach(function (s) {
    var key = startOfDay(s.start);
    days[key] = (days[key] || 0) + shiftHours(s, settings);
  });

  var regular = 0, ot = 0, dt = 0, total = 0;
  Object.keys(days).forEach(function (k) {
    var h = days[k];
    total += h;
    var dDT = 0, dOT = 0;
    if (dtT > 0 && h > dtT) dDT = h - dtT;                       // daily double time
    var afterDT = h - dDT;
    if (dailyOT > 0 && afterDT > dailyOT) dOT = afterDT - dailyOT; // daily overtime
    var dReg = afterDT - dOT;
    regular += dReg; ot += dOT; dt += dDT;
  });

  // --- 2. weekly overtime, applied only to still-regular hours -------------
  if (weeklyOT > 0 && regular > weeklyOT) {
    ot += regular - weeklyOT;
    regular = weeklyOT;
  }

  var gross = rate * (regular + ot * num(settings.otMultiplier, 1.5) + dt * num(settings.dtMultiplier, 2));
  return { regular: regular, ot: ot, dt: dt, gross: gross, hours: total };
}

/* ---- pay periods -------------------------------------------------------- */

/** Weekday the work week starts on, derived from the pay-period anchor. */
function weekStartDay(settings) {
  return new Date(settings.periodAnchor || 0).getDay();
}

/** Local midnight of the work week containing `ts`. */
function weekStart(ts, settings) {
  var wsd = weekStartDay(settings);
  var d = new Date(startOfDay(ts));
  var delta = (d.getDay() - wsd + 7) % 7;
  return addDays(d.getTime(), -delta);
}

/**
 * payPeriodRange(ts, settings) -> { start, end, label }
 * `end` is inclusive (last millisecond of the final day).
 *   weekly / biweekly  — counted forward and backward from periodAnchor
 *   semimonthly        — 1st-15th and 16th-end of month
 *   monthly            — calendar month
 */
function payPeriodRange(ts, settings) {
  var mode = settings.payPeriod || 'weekly';
  var anchor = startOfDay(settings.periodAnchor || Date.now());
  var d0 = startOfDay(ts);

  if (mode === 'weekly' || mode === 'biweekly') {
    var span = mode === 'weekly' ? 7 : 14;
    var diff = dayDiff(d0, anchor);
    var n = Math.floor(diff / span);
    var start = addDays(anchor, n * span);
    var end = addDays(start, span) - 1;
    return { start: start, end: end, label: fmtDateShort(start) + ' – ' + fmtDateShort(end) };
  }
  if (mode === 'semimonthly') {
    var dt = new Date(d0);
    if (dt.getDate() <= 15) {
      var s1 = startOfMonth(d0);
      var e1 = new Date(s1); e1.setDate(16); e1.setHours(0, 0, 0, 0);
      return { start: s1, end: e1.getTime() - 1, label: MONTHS[dt.getMonth()] + ' 1–15, ' + dt.getFullYear() };
    }
    var s2 = new Date(startOfMonth(d0)); s2.setDate(16);
    return { start: s2.getTime(), end: endOfMonth(d0),
             label: MONTHS[dt.getMonth()] + ' 16–' + new Date(endOfMonth(d0)).getDate() + ', ' + dt.getFullYear() };
  }
  // monthly
  var dm = new Date(d0);
  return { start: startOfMonth(d0), end: endOfMonth(d0), label: MONTHS[dm.getMonth()] + ' ' + dm.getFullYear() };
}

/**
 * Step a pay period forward (n>0) or back (n<0) one period at a time. Stepping
 * one period at a time keeps semimonthly/monthly correct across month lengths.
 */
function shiftPayPeriod(range, n, settings) {
  var r = range, steps = Math.abs(n);
  for (var i = 0; i < steps; i++) {
    r = payPeriodRange(n > 0 ? r.end + 1000 : r.start - 1000, settings);
  }
  return r;
}

/** All shifts overlapping [from,to] for an employee ('all' allowed). */
function shiftsInRange(from, to, employeeId) {
  return state.shifts.filter(function (s) {
    if (employeeId && employeeId !== 'all' && s.employeeId !== employeeId) return false;
    var e = s.end == null ? Date.now() : s.end;
    return e >= from && s.start <= to;
  });
}

/**
 * periodTotals(range, employeeId, settings)
 * Splits the pay period into work weeks so weekly OT is computed per week,
 * then adds the weeks together. Returns hours + gross for the whole period.
 */
function periodTotals(range, employeeId, settings) {
  var emps = employeeId && employeeId !== 'all'
    ? [employee(employeeId)].filter(Boolean)
    : state.employees;
  var out = { regular: 0, ot: 0, dt: 0, gross: 0, hours: 0 };

  emps.forEach(function (emp) {
    // Walk week-by-week across the period.
    var cursor = weekStart(range.start, settings);
    while (cursor <= range.end) {
      var wEnd = addDays(cursor, 7) - 1;
      var lo = Math.max(cursor, range.start), hi = Math.min(wEnd, range.end);
      var weekShifts = state.shifts.filter(function (s) {
        return s.employeeId === emp.id && s.start >= lo && s.start <= hi;
      });
      if (weekShifts.length) {
        var r = splitPay(weekShifts, emp, settings);
        out.regular += r.regular; out.ot += r.ot; out.dt += r.dt;
        out.gross += r.gross; out.hours += r.hours;
      }
      cursor = addDays(cursor, 7);
    }
  });
  return out;
}

/** Labor cost of a set of shifts at straight time (used for job profitability). */
function laborCost(shifts, settings) {
  return sum(shifts, function (s) {
    var emp = employee(s.employeeId);
    return shiftHours(s, settings) * (emp ? num(emp.hourlyRate, 0) : 0);
  });
}

/* ---- overlap detection -------------------------------------------------- */

/** Do two shifts share any time? Open shifts are treated as running until now. */
function shiftsOverlap(a, b) {
  var now = Date.now();
  var ae = a.end == null ? Math.max(now, a.start) : a.end;
  var be = b.end == null ? Math.max(now, b.start) : b.end;
  return a.start < be && b.start < ae;
}

/** Existing shifts for the same employee that collide with `candidate`. */
function findOverlaps(candidate) {
  return state.shifts.filter(function (s) {
    return s.id !== candidate.id && s.employeeId === candidate.employeeId && shiftsOverlap(s, candidate);
  });
}

/* ==========================================================================
   4. GEO — haversine, geofence runtime, mileage
   ========================================================================== */

/** Great-circle distance in metres between two lat/lng pairs. */
function haversineMeters(lat1, lng1, lat2, lng2) {
  var R = 6371000;
  var p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  var dp = (lat2 - lat1) * Math.PI / 180, dl = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dp / 2) * Math.sin(dp / 2) +
          Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function metersToMiles(m) { return m / 1609.344; }

/** Nearest geofenced job site to a coordinate, with distance. */
function nearestSite(lat, lng) {
  var best = null;
  state.jobSites.forEach(function (js) {
    if (js.archived || js.lat == null || js.lng == null) return;
    var d = haversineMeters(lat, lng, js.lat, js.lng);
    if (!best || d < best.dist) best = { site: js, dist: d };
  });
  return best;
}
function siteContaining(lat, lng) {
  var n = nearestSite(lat, lng);
  return n && n.dist <= num(n.site.radiusMeters, 120) ? n : null;
}

/* ==========================================================================
   5. UI PRIMITIVES
   ========================================================================== */

/* ---- 5a. One ticker to drive every live number -------------------------- */
var ticker = (function () {
  var subs = [];
  var timer = null;
  function pump() {
    var now = Date.now();
    for (var i = 0; i < subs.length; i++) {
      try { subs[i].fn(now); } catch (e) { console.error('tick', e); }
    }
  }
  function ensure() {
    if (timer == null && subs.length) {
      pump();
      timer = setInterval(pump, 1000);
    } else if (timer != null && !subs.length) {
      clearInterval(timer); timer = null;
    }
  }
  return {
    add: function (key, fn) {
      subs = subs.filter(function (s) { return s.key !== key; });
      subs.push({ key: key, fn: fn });
      ensure();
    },
    remove: function (key) {
      subs = subs.filter(function (s) { return s.key !== key; });
      ensure();
    },
    clearView: function () {
      subs = subs.filter(function (s) { return s.key.indexOf('view:') !== 0; });
      ensure();
    },
    now: pump
  };
})();

// Re-sync when the tab wakes up (iOS freezes timers in the background).
on(document, 'visibilitychange', function () {
  if (!document.hidden) { ticker.now(); if (state.ready) renderRoute(); }
});

/* ---- 5b. Toast ---------------------------------------------------------- */
function toast(msg, kind, ms) {
  var host = $('#toastHost');
  var el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.innerHTML = '<span class="barbell"></span><span class="grow">' + esc(msg) + '</span>';
  host.appendChild(el);
  setTimeout(function () {
    el.style.transition = 'opacity .2s'; el.style.opacity = '0';
    setTimeout(function () { el.remove(); }, 220);
  }, ms || 2600);
}

/* ---- 5c. Sheet (our modal; no alert/confirm anywhere in normal flow) -----
   Sheets stack: opening one over another hides (but keeps) the one below, so a
   confirmation can appear on top of an editor and hand control back on close. */
var sheetStack = [];
var sheetSeq = 0;
function openSheet(opts) {
  // opts: { title, body(html), foot(html), onMount(el, close), onClose(result) }
  var scrim = $('#scrim');
  var prevFocus = document.activeElement;
  if (sheetStack.length) sheetStack[sheetStack.length - 1].el.style.display = 'none';

  var titleId = 'sheetTitle' + (++sheetSeq);
  var sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', titleId);
  sheet.tabIndex = -1;
  sheet.innerHTML =
    '<div class="grab"></div>' +
    '<div class="sheet-head"><h2 id="' + titleId + '">' + esc(opts.title || '') + '</h2>' +
    '<button class="iconbtn" type="button" data-sheet-close aria-label="Close">' +
    '<svg aria-hidden="true"><use href="#i-x"></use></svg></button></div>' +
    '<div class="sheet-body">' + (opts.body || '') + '</div>' +
    (opts.foot ? '<div class="sheet-foot">' + opts.foot + '</div>' : '');
  scrim.appendChild(sheet);
  scrim.hidden = false;
  document.body.style.overflow = 'hidden';

  var closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    sheet.remove();
    sheetStack = sheetStack.filter(function (s) { return s.el !== sheet; });
    if (sheetStack.length) {
      sheetStack[sheetStack.length - 1].el.style.display = '';
    } else {
      scrim.hidden = true;
      document.body.style.overflow = '';
    }
    if (prevFocus && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch (e) {} }
    if (opts.onClose) opts.onClose(result);
  }
  sheetStack.push({ el: sheet, close: close });
  $$('[data-sheet-close]', sheet).forEach(function (b) { on(b, 'click', function () { close(null); }); });
  if (opts.onMount) opts.onMount(sheet, close);
  sheet.scrollTop = 0;
  setTimeout(function () {
    var f = sheet.querySelector('input,select,textarea,button:not([data-sheet-close])');
    (f || sheet).focus({ preventScroll: true });
  }, 60);
  return close;
}
function closeTopSheet() { if (sheetStack.length) sheetStack[sheetStack.length - 1].close(null); }

on($('#scrim'), 'click', function (e) { if (e.target === e.currentTarget) closeTopSheet(); });
on(document, 'keydown', function (e) { if (e.key === 'Escape' && sheetStack.length) closeTopSheet(); });

/** Promise-returning confirm sheet. Every destructive action funnels here. */
function confirmSheet(opts) {
  return new Promise(function (resolve) {
    var done = false;
    var close = openSheet({
      title: opts.title,
      body: '<p>' + esc(opts.message) + '</p>' +
            (opts.detail ? '<div class="card" style="margin-top:6px">' + opts.detail + '</div>' : '') +
            (opts.typed ? '<div class="field" style="margin-top:12px"><label for="typedConfirm">Type <strong>' +
              esc(opts.typed) + '</strong> to continue</label><input id="typedConfirm" type="text" autocapitalize="characters" autocomplete="off"></div>' : ''),
      foot: '<button class="btn ghost" type="button" data-no>' + esc(opts.cancelText || 'Cancel') + '</button>' +
            '<button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" type="button" data-yes' +
            (opts.typed ? ' disabled' : '') + '>' + esc(opts.okText || 'Confirm') + '</button>',
      onMount: function (el, close) {
        var yes = $('[data-yes]', el);
        if (opts.typed) {
          var inp = $('#typedConfirm', el);
          on(inp, 'input', function () { yes.disabled = inp.value.trim().toUpperCase() !== opts.typed.toUpperCase(); });
        }
        on(yes, 'click', function () { done = true; close(true); resolve(true); });
        on($('[data-no]', el), 'click', function () { done = true; close(false); resolve(false); });
      },
      onClose: function () { if (!done) resolve(false); }
    });
    return close;
  });
}

/* ---- 5d. Form helpers --------------------------------------------------- */
function field(opts) {
  // { id, label, type, value, hint, err, attrs, options[], rows }
  var id = opts.id;
  var attrs = opts.attrs || '';
  var ctl;
  if (opts.type === 'select') {
    ctl = '<select id="' + id + '" name="' + id + '" ' + attrs + '>' +
      (opts.options || []).map(function (o) {
        return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(opts.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }).join('') + '</select>';
  } else if (opts.type === 'textarea') {
    ctl = '<textarea id="' + id + '" name="' + id + '" rows="' + (opts.rows || 3) + '" ' + attrs + '>' + esc(opts.value == null ? '' : opts.value) + '</textarea>';
  } else {
    ctl = '<input id="' + id + '" name="' + id + '" type="' + (opts.type || 'text') + '" value="' +
          esc(opts.value == null ? '' : opts.value) + '" ' + attrs + '>';
  }
  return '<div class="field" data-field="' + id + '">' +
    '<label for="' + id + '">' + esc(opts.label) + '</label>' + ctl +
    (opts.hint ? '<div class="hint">' + opts.hint + '</div>' : '') +
    '<div class="err" id="' + id + '-err">' + esc(opts.err || '') + '</div></div>';
}
/** Mark a field invalid, wire the message to the control for screen readers. */
function fieldError(root, id, msg) {
  var f = root.querySelector('[data-field="' + id + '"]');
  if (!f) return;
  f.classList.add('invalid');
  var err = f.querySelector('.err');
  if (err && (msg || !err.textContent)) err.textContent = msg || 'Required';
  var ctl = f.querySelector('input,select,textarea');
  if (ctl) {
    ctl.setAttribute('aria-invalid', 'true');
    ctl.setAttribute('aria-describedby', id + '-err');
    // Focus only the first field flagged in this validation pass.
    if (root.querySelectorAll('.field.invalid').length === 1) {
      try { ctl.focus(); } catch (e) {}
    }
  }
}
function clearErrors(root) {
  $$('.field.invalid', root).forEach(function (f) {
    f.classList.remove('invalid');
    var ctl = f.querySelector('input,select,textarea');
    if (ctl) { ctl.removeAttribute('aria-invalid'); ctl.removeAttribute('aria-describedby'); }
  });
}
function val(root, id) {
  var el = root.querySelector('#' + id);
  return el ? el.value : '';
}
function jobSiteOptions(selected, includeBlank) {
  var opts = (includeBlank === false ? [] : [{ value: '', label: '— No job site —' }]);
  var sites = state.jobSites.filter(function (s) { return !s.archived || s.id === selected; });
  sites.sort(by('name')).forEach(function (s) {
    var c = customer(s.customerId);
    opts.push({ value: s.id, label: (c ? c.name + ' · ' : '') + s.name });
  });
  return opts;
}
function employeeOptions(selected) {
  return state.employees.filter(function (e) { return e.active || e.id === selected; })
    .map(function (e) { return { value: e.id, label: e.name }; });
}

/* ---- 5e. Photos: downscale to <=1280px before storing as a data URL ------ */
function fileToDownscaledDataURL(file, maxPx, quality) {
  maxPx = maxPx || 1280;
  return new Promise(function (resolve, reject) {
    if (!file || !/^image\//.test(file.type)) { reject(new Error('Not an image')); return; }
    var fr = new FileReader();
    fr.onerror = function () { reject(fr.error || new Error('read failed')); };
    fr.onload = function () {
      var img = new Image();
      img.onerror = function () { reject(new Error('decode failed')); };
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, maxPx / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        var ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, cw, ch);
        try { resolve(cv.toDataURL('image/jpeg', quality || 0.72)); }
        catch (e) { reject(e); }
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

/** Photo strip editor used by the clock screen and the shift editor. */
function renderThumbs(list) {
  if (!list || !list.length) return '';
  return '<div class="thumbs">' + list.map(function (src, i) {
    return '<div class="thumb"><img src="' + esc(src) + '" alt="Shift photo ' + (i + 1) + '">' +
      '<button class="x" type="button" data-rmphoto="' + i + '" aria-label="Remove photo ' + (i + 1) + '">' +
      '<span aria-hidden="true">&times;</span></button></div>';
  }).join('') + '</div>';
}
function wirePhotoInput(root, getList, setList, rerender) {
  var inp = $('[data-photo-input]', root);
  if (inp) {
    on(inp, 'change', function () {
      var files = Array.prototype.slice.call(inp.files || []);
      if (!files.length) return;
      Promise.all(files.map(function (f) { return fileToDownscaledDataURL(f).catch(function () { return null; }); }))
        .then(function (urls) {
          var list = getList().concat(urls.filter(Boolean));
          setList(list);
          inp.value = '';
          rerender();
          toast(urls.filter(Boolean).length + ' photo(s) added');
        });
    });
  }
  $$('[data-rmphoto]', root).forEach(function (b) {
    on(b, 'click', function () {
      var i = int(b.getAttribute('data-rmphoto'), -1);
      var list = getList().slice();
      if (i >= 0) list.splice(i, 1);
      setList(list); rerender();
    });
  });
}

/* ---- 5f. File download (blob) ------------------------------------------- */
function downloadFile(filename, content, mime) {
  var blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
}
function csvCell(v) {
  var s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(rows) {
  return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
}
/** Minimal RFC4180-ish CSV parser for timesheet/expense re-import. */
function parseCSV(text) {
  var rows = [], row = [], cur = '', q = false;
  text = String(text).replace(/^﻿/, '');
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(function (r) { return r.length > 1 || (r[0] || '').trim() !== ''; });
}

/* ==========================================================================
   6. ROUTER + CHROME
   ========================================================================== */

var VIEWS = {
  clock:    { title: 'Clock',    sub: 'Punchline',            render: renderClock },
  shifts:   { title: 'Shifts',   sub: 'By pay period',        render: renderShifts },
  jobs:     { title: 'Jobs',     sub: 'Customers & sites',    render: renderJobs },
  money:    { title: 'Money',    sub: 'Pay, costs, invoices', render: renderMoney },
  insights: { title: 'Insights', sub: 'What the data says',   render: renderInsights },
  settings: { title: 'Settings', sub: 'Rules & data',         render: renderSettings }
};

function currentRoute() {
  var h = (location.hash || '').replace(/^#\/?/, '').split('/')[0];
  return VIEWS[h] ? h : 'clock';
}
function go(route) {
  if (currentRoute() === route) renderRoute();
  else location.hash = '#/' + route;
}
function renderRoute() {
  var r = currentRoute();
  state.route = r;
  var v = VIEWS[r];
  ticker.clearView();

  $('#viewTitle').firstChild.nodeValue = v.title;
  $('#viewSub').textContent = v.sub;
  $('#backBtn').hidden = (r !== 'settings');
  $('#settingsBtn').hidden = (r === 'settings');

  Object.keys(VIEWS).forEach(function (k) {
    var el = document.getElementById('view-' + k);
    if (el) el.hidden = (k !== r);
  });
  $$('.tabbar a').forEach(function (a) {
    if (a.getAttribute('data-tab') === r) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  var host = document.getElementById('view-' + r);
  v.render(host);
  window.scrollTo(0, 0);
}
on(window, 'hashchange', function () { if (state.ready) renderRoute(); });
on($('#settingsBtn'), 'click', function () { go('settings'); });
on($('#backBtn'), 'click', function () { history.length > 1 ? history.back() : go('clock'); });

/* ==========================================================================
   7. VIEW: CLOCK
   ========================================================================== */

var clockDraft = { notes: '', photos: [], jobSiteId: null };

/** The break currently running on a shift, if any. */
function openBreak(sh) {
  if (!sh) return null;
  var bs = sh.breaks || [];
  for (var i = bs.length - 1; i >= 0; i--) if (bs[i] && bs[i].end == null) return bs[i];
  return null;
}

function todayShifts(empId) {
  var s0 = startOfDay(Date.now()), s1 = s0 + MS_DAY - 1;
  return state.shifts.filter(function (s) { return s.employeeId === empId && s.start >= s0 && s.start <= s1; });
}
function weekShifts(empId) {
  var ws = weekStart(Date.now(), state.settings), we = addDays(ws, 7) - 1;
  return state.shifts.filter(function (s) { return s.employeeId === empId && s.start >= ws && s.start <= we; });
}

function renderClock(host) {
  var me = selfEmployee();
  var sh = openShift(me.id);
  var brk = openBreak(sh);
  var s = state.settings;

  if (sh && clockDraft.jobSiteId == null) clockDraft.jobSiteId = sh.jobSiteId;

  var onboarding = '';
  if (!localStorage.getItem(LS_ONBOARD) && !state.shifts.length) {
    onboarding =
      '<div class="card">' +
        '<h2>Welcome to Punchline</h2>' +
        '<p>Three things and you are running.</p>' +
        '<ol class="onboard-steps">' +
          '<li><span class="n">1</span><span class="grow"><span class="ttl">Set your hourly rate</span>' +
            '<span class="meta">Settings → Crew. Pay and profit math needs it.</span></span></li>' +
          '<li><span class="n">2</span><span class="grow"><span class="ttl">Add a customer and a job site</span>' +
            '<span class="meta">Jobs tab. Drop a pin with “Use my current location” for geofencing.</span></span></li>' +
          '<li><span class="n">3</span><span class="grow"><span class="ttl">Punch in</span>' +
            '<span class="meta">Big green button. Tap again to punch out.</span></span></li>' +
        '</ol>' +
        '<div class="btn-row" style="margin-top:14px">' +
          '<button class="btn ghost" type="button" data-act="dismiss-onboard">Got it</button>' +
          '<button class="btn primary" type="button" data-act="goto-settings">Set my rate</button>' +
        '</div>' +
      '</div>';
  }

  // Long shift nudge, right where you would see it.
  var longWarn = '';
  if (sh && (Date.now() - sh.start) / MS_HOUR > num(s.maxShiftHours, 14)) {
    longWarn = '<div class="nudge bad"><div class="grow"><div class="ttl">This punch has run ' +
      hrs((Date.now() - sh.start) / MS_HOUR) + '</div>' +
      '<div class="meta">Past your ' + num(s.maxShiftHours, 14) + '-hour limit. Did you forget to clock out?</div>' +
      '<button class="btn sm" type="button" data-act="fix-forgot">Fix the end time</button></div></div>';
  }

  var siteId = sh ? sh.jobSiteId : clockDraft.jobSiteId;
  var siteObj = site(siteId);
  var cust = siteObj ? customer(siteObj.customerId) : null;

  var punchClass = sh ? (brk ? 'brk' : 'in') : 'out';
  var punchInner = sh
    ? '<span class="lead">' + (brk ? 'On break' : 'Clocked in') + '</span>' +
      '<span class="timer mono" data-live="timer">0:00:00</span>' +
      '<span class="sub" data-live="earn">' + money(0) + '</span>'
    : '<span class="lead">Ready</span><span class="main">CLOCK IN</span>' +
      '<span class="sub">' + (siteObj ? esc(siteObj.name) : 'No job site') + '</span>';

  var nearbyChip = '';
  if (state.geo.insideId && (!sh || sh.jobSiteId !== state.geo.insideId)) {
    nearbyChip = '<button class="chip info" type="button" data-act="use-nearby">📍 Nearby: ' +
      esc(siteName(state.geo.insideId)) + ' — use it</button>';
  } else if (state.geo.insideId) {
    nearbyChip = '<span class="chip info">📍 Inside ' + esc(siteName(state.geo.insideId)) + '</span>';
  }

  host.innerHTML =
    onboarding + longWarn +
    '<div class="punch-wrap">' +
      '<button class="punch ' + punchClass + '" type="button" id="punchBtn" ' +
        'aria-label="' + (sh ? 'Clock out' : 'Clock in') + '">' + punchInner + '</button>' +
      '<div class="punch-hint">' +
        (sh ? 'Tap to clock out · long-press for a break' : 'Tap to start the clock') +
      '</div>' +
    '</div>' +

    (sh ? '<div class="btn-row" style="margin-top:14px">' +
      '<button class="btn" type="button" data-act="toggle-break">' + (brk ? 'End break' : 'Start break') + '</button>' +
      '<button class="btn ghost" type="button" data-act="cancel-punch">Discard punch</button></div>' : '') +

    '<div class="card" style="margin-top:16px">' +
      '<button class="row" type="button" data-act="pick-site" style="padding:4px 0;border-bottom:0">' +
        '<span class="dot lg" style="background:' + esc(siteColor(siteId)) + '"></span>' +
        '<span class="grow"><span class="ttl">' + esc(siteObj ? siteObj.name : 'Choose a job site') + '</span>' +
        '<span class="meta">' + esc(cust ? cust.name : (state.jobSites.length ? 'Tap to pick' : 'No job sites yet — add one in Jobs')) + '</span></span>' +
        '<svg class="chev" aria-hidden="true" width="18" height="18"><use href="#i-chev"></use></svg>' +
      '</button>' +
      (nearbyChip ? '<div class="chips" style="margin-top:10px">' + nearbyChip + '</div>' : '') +
      '<div class="live-row">' +
        '<div class="stat"><div class="lbl">Today</div><div class="val sm" data-live="today">0h</div></div>' +
        '<div class="stat"><div class="lbl">This week</div><div class="val sm" data-live="week">0h</div></div>' +
        '<div class="stat"><div class="lbl">Week pay</div><div class="val sm" data-live="weekpay">' + money(0) + '</div></div>' +
      '</div>' +
    '</div>' +

    '<div class="card">' +
      '<h3>Notes &amp; photos</h3>' +
      '<label class="visually-hidden" for="clockNote">Shift note</label>' +
      '<textarea class="notefield" id="clockNote" rows="2" placeholder="What happened on this job?">' +
        esc(sh ? sh.notes : clockDraft.notes) + '</textarea>' +
      '<div class="btn-row" style="margin-top:10px">' +
        '<label class="btn ghost" for="clockPhoto" style="flex:1">Add photo' +
          '<input id="clockPhoto" data-photo-input type="file" accept="image/*" capture="environment" ' +
          'multiple class="visually-hidden"></label>' +
        '<button class="btn ghost" type="button" data-act="save-note">Save note</button>' +
      '</div>' +
      renderThumbs(sh ? sh.photos : clockDraft.photos) +
      '<div class="inline-note">Photos are downscaled to 1280px and stored on this device only.</div>' +
    '</div>' +

    (s.geoEnabled ? '' :
      '<div class="inline-note" style="text-align:center;margin-top:6px">Geofencing is off. Turn it on in Settings to punch by location while the app is open.</div>');

  /* ---- wiring ---- */
  var punch = $('#punchBtn', host);
  var lpTimer = null, longFired = false;
  on(punch, 'pointerdown', function () {
    longFired = false;
    if (!openShift(me.id)) return;
    lpTimer = setTimeout(function () { longFired = true; toggleBreak(); }, 650);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
    on(punch, ev, function () { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
  });
  on(punch, 'click', function () {
    if (longFired) { longFired = false; return; }
    openShift(me.id) ? promptClockOut() : doClockIn('quick');
  });

  delegate(host, 'click', '[data-act]', function (e, t) {
    var act = t.getAttribute('data-act');
    if (act === 'dismiss-onboard') { localStorage.setItem(LS_ONBOARD, '1'); renderClock(host); }
    if (act === 'goto-settings') { localStorage.setItem(LS_ONBOARD, '1'); go('settings'); }
    if (act === 'pick-site') pickJobSite();
    if (act === 'toggle-break') toggleBreak();
    if (act === 'cancel-punch') discardPunch();
    if (act === 'use-nearby') setPunchSite(state.geo.insideId);
    if (act === 'save-note') saveClockNote();
    if (act === 'fix-forgot') { var o = openShift(selfEmployee().id); if (o) openShiftEditor(o); }
  });

  wirePhotoInput(host,
    function () { var o = openShift(me.id); return o ? (o.photos || []) : clockDraft.photos; },
    function (list) {
      var o = openShift(me.id);
      if (o) { o.photos = list; saveShift(o); } else clockDraft.photos = list;
    },
    function () { renderClock(host); });

  var noteEl = $('#clockNote', host);
  on(noteEl, 'input', function () {
    var o = openShift(me.id);
    if (o) { o.notes = noteEl.value; } else clockDraft.notes = noteEl.value;
  });
  on(noteEl, 'blur', function () { var o = openShift(me.id); if (o) saveShift(o); });

  /* ---- live numbers, driven by the single global ticker ---- */
  var lastAnnouncedMin = -1;
  function tick() {
    var cur = openShift(me.id);
    var t = $('[data-live="timer"]', host);
    if (cur && t) {
      var elapsed = Date.now() - cur.start;
      t.textContent = hms(elapsed);
      var paidH = paidMinutes(cur, s) / 60;
      var earn = $('[data-live="earn"]', host);
      if (earn) earn.textContent = money(paidH * num(me.hourlyRate, 0)) + ' · ' + esc(siteName(cur.jobSiteId));
      var mins = Math.floor(elapsed / MS_MIN);
      if (mins !== lastAnnouncedMin) {
        lastAnnouncedMin = mins;
        $('#a11yTimer').textContent = 'Clocked in ' + hm(mins) + ' at ' + siteName(cur.jobSiteId);
      }
    }
    var td = $('[data-live="today"]', host);
    if (td) td.textContent = hrs(sum(todayShifts(me.id), function (x) { return shiftHours(x, s); }));
    var wk = weekShifts(me.id);
    var wkEl = $('[data-live="week"]', host);
    if (wkEl) wkEl.textContent = hrs(sum(wk, function (x) { return shiftHours(x, s); }));
    var wp = $('[data-live="weekpay"]', host);
    if (wp) wp.textContent = money(splitPay(wk, me, s).gross);
  }
  ticker.add('view:clock', tick);
  tick();
}

/* ---- clock actions ------------------------------------------------------ */

function doClockIn(source, jobSiteId) {
  var me = selfEmployee();
  if (openShift(me.id)) { toast('Already clocked in'); return Promise.resolve(); }
  var sh = newShift({
    employeeId: me.id,
    jobSiteId: jobSiteId !== undefined ? jobSiteId : (clockDraft.jobSiteId || lastUsedSiteId(me.id)),
    start: Date.now(),
    source: source || 'quick',
    notes: clockDraft.notes,
    photos: clockDraft.photos.slice(),
    approved: true
  });
  clockDraft.notes = ''; clockDraft.photos = [];
  state.shifts.unshift(sh);
  setActivePunch({ shiftId: sh.id, employeeId: sh.employeeId, jobSiteId: sh.jobSiteId, start: sh.start, breakStart: null });
  return saveShift(sh).then(function () {
    toast('Clocked in' + (sh.jobSiteId ? ' at ' + siteName(sh.jobSiteId) : ''));
    recordMileageOnArrival(sh);
    renderRoute();
  });
}

function lastUsedSiteId(empId) {
  for (var i = 0; i < state.shifts.length; i++) {
    if (state.shifts[i].employeeId === empId && state.shifts[i].jobSiteId) return state.shifts[i].jobSiteId;
  }
  var first = state.jobSites.filter(function (s) { return !s.archived; })[0];
  return first ? first.id : null;
}

/** Clock-out confirmation sheet: raw duration, rounded duration, pay. */
function promptClockOut(auto) {
  var me = selfEmployee();
  var sh = openShift(me.id);
  if (!sh) return;
  var s = state.settings;
  var now = Date.now();
  var raw = paidMinutes(sh, s, now);
  var rounded = roundMinutes(raw, s.rounding, s.roundingMode);
  var pay = (rounded / 60) * num(me.hourlyRate, 0);
  var br = breakMinutes(sh, now);

  openSheet({
    title: 'Clock out?',
    body:
      '<div class="card" style="margin:0 0 12px">' +
        '<div class="kv"><span class="k">Job</span><span class="v">' + esc(siteName(sh.jobSiteId)) + '</span></div>' +
        '<div class="kv"><span class="k">Started</span><span class="v">' + fmtTime(sh.start) + '</span></div>' +
        '<div class="kv"><span class="k">Ending</span><span class="v">' + fmtTime(now) + '</span></div>' +
        '<div class="kv"><span class="k">On the clock</span><span class="v">' + hm((now - sh.start) / MS_MIN) + '</span></div>' +
        (br.unpaid ? '<div class="kv"><span class="k">Unpaid break</span><span class="v">−' + hm(br.unpaid) + '</span></div>' : '') +
        '<div class="kv"><span class="k">Paid time</span><span class="v">' + hm(raw) + '</span></div>' +
        '<div class="kv"><span class="k">Rounded (' + (s.rounding === 'none' ? 'off' : s.rounding + ' min ' + s.roundingMode) + ')</span>' +
          '<span class="v">' + hm(rounded) + '</span></div>' +
        '<div class="kv"><span class="k">Pay at ' + money(num(me.hourlyRate, 0)) + '/hr</span><span class="v">' + money(pay) + '</span></div>' +
      '</div>' +
      (auto ? '<p>You left the ' + esc(siteName(sh.jobSiteId)) + ' geofence.</p>' : ''),
    foot: '<button class="btn ghost" type="button" data-sheet-close>Keep working</button>' +
          '<button class="btn primary" type="button" data-yes>Clock out</button>',
    onMount: function (el, close) {
      on($('[data-yes]', el), 'click', function () { close(); doClockOut(now); });
    }
  });
}

function doClockOut(endTs) {
  var me = selfEmployee();
  var sh = openShift(me.id);
  if (!sh) return Promise.resolve();
  var now = endTs || Date.now();
  // Close any running break at the same moment.
  var b = openBreak(sh);
  if (b) b.end = now;
  sh.end = now;
  setActivePunch(null);
  state.geo.lastLeftSiteId = sh.jobSiteId;
  state.geo.lastLeftAt = now;
  return saveShift(sh).then(function () {
    var mins = roundedPaidMinutes(sh, state.settings);
    toast('Clocked out — ' + hm(mins) + ' · ' + money((mins / 60) * num(me.hourlyRate, 0)));
    renderRoute();
  });
}

function toggleBreak() {
  var me = selfEmployee();
  var sh = openShift(me.id);
  if (!sh) { toast('Not clocked in', 'warn'); return; }
  var b = openBreak(sh);
  if (b) { b.end = Date.now(); toast('Break ended — ' + hm((b.end - b.start) / MS_MIN)); }
  else { sh.breaks = (sh.breaks || []).concat([{ start: Date.now(), end: null, paid: false }]); toast('Break started'); }
  var ap = activePunch(); if (ap) { ap.breakStart = b ? null : Date.now(); setActivePunch(ap); }
  saveShift(sh).then(renderRoute);
}

function discardPunch() {
  var me = selfEmployee();
  var sh = openShift(me.id);
  if (!sh) return;
  confirmSheet({
    title: 'Discard this punch?',
    message: 'The open punch started ' + fmtTime(sh.start) + ' will be deleted. This cannot be undone.',
    okText: 'Discard', danger: true
  }).then(function (ok) {
    if (!ok) return;
    setActivePunch(null);
    remove('shifts', 'shifts', sh.id).then(function () { toast('Punch discarded'); renderRoute(); });
  });
}

function saveClockNote() {
  var me = selfEmployee();
  var sh = openShift(me.id);
  var el = $('#clockNote');
  if (!el) return;
  if (sh) { sh.notes = el.value; saveShift(sh).then(function () { toast('Note saved to this punch'); }); }
  else { clockDraft.notes = el.value; toast('Note saved — it will attach to your next punch'); }
}

function setPunchSite(id) {
  var me = selfEmployee();
  var sh = openShift(me.id);
  if (sh) { sh.jobSiteId = id || null; saveShift(sh).then(renderRoute); }
  else { clockDraft.jobSiteId = id || null; renderRoute(); }
}

function pickJobSite() {
  if (!state.jobSites.length) {
    openSheet({
      title: 'No job sites yet',
      body: '<p>Add a customer and a job site first, then you can attach punches to them and see profit per job.</p>',
      foot: '<button class="btn ghost" type="button" data-sheet-close>Later</button>' +
            '<button class="btn primary" type="button" data-go>Go to Jobs</button>',
      onMount: function (el, close) { on($('[data-go]', el), 'click', function () { close(); go('jobs'); }); }
    });
    return;
  }
  var me = selfEmployee();
  var sh = openShift(me.id);
  var cur = sh ? sh.jobSiteId : clockDraft.jobSiteId;
  var sites = state.jobSites.filter(function (s) { return !s.archived; }).sort(by('name'));
  openSheet({
    title: 'Job site',
    body: '<div class="card tight"><div class="rows">' +
      '<button class="row" type="button" data-site="">' +
        '<span class="dot" style="background:var(--text-3)"></span>' +
        '<span class="grow"><span class="ttl">No job site</span></span>' +
        (cur ? '' : '<span class="badge good">Current</span>') + '</button>' +
      sites.map(function (s) {
        var c = customer(s.customerId);
        return '<button class="row" type="button" data-site="' + esc(s.id) + '">' +
          '<span class="dot" style="background:' + esc(s.colorHex) + '"></span>' +
          '<span class="grow"><span class="ttl">' + esc(s.name) + '</span>' +
          '<span class="meta">' + esc(c ? c.name : 'No customer') + (s.billRate ? ' · bills ' + money(s.billRate) + '/hr' : '') + '</span></span>' +
          (cur === s.id ? '<span class="badge good">Current</span>' : '') + '</button>';
      }).join('') + '</div></div>',
    onMount: function (el, close) {
      delegate(el, 'click', '[data-site]', function (e, t) {
        close(); setPunchSite(t.getAttribute('data-site') || null);
      });
    }
  });
}

/* ==========================================================================
   8. VIEW: SHIFTS  (+ shift editor sheet)
   ========================================================================== */

var shiftsPeriodLimit = 6;

function renderShifts(host) {
  var s = state.settings;
  var filterId = state.filterEmployeeId;
  var all = state.shifts.filter(function (x) {
    return filterId === 'all' || x.employeeId === filterId;
  }).slice().sort(function (a, b) { return b.start - a.start; });

  var head =
    '<div class="btn-row" style="margin-bottom:12px">' +
      '<button class="btn primary" type="button" data-act="add-shift">+ Add shift</button>' +
      '<button class="btn ghost" type="button" data-act="export-csv">Export CSV</button>' +
    '</div>' +
    (state.employees.length > 1 ?
      '<div class="chips" style="margin-bottom:12px">' +
        '<button class="chip" type="button" aria-pressed="' + (filterId === 'all') + '" data-emp="all">Everyone</button>' +
        state.employees.map(function (e) {
          return '<button class="chip" type="button" aria-pressed="' + (filterId === e.id) + '" data-emp="' + esc(e.id) + '">' +
            esc(e.name) + '</button>';
        }).join('') + '</div>' : '');

  if (!all.length) {
    host.innerHTML = head +
      '<div class="card"><div class="empty"><div class="big">🕒</div><h3>No shifts yet</h3>' +
      '<p>Punch in on the Clock tab, or add one by hand.</p></div></div>';
    wireShifts(host);
    return;
  }

  // --- group into pay periods, newest first --------------------------------
  var periods = [];
  var seen = {};
  all.forEach(function (sh) {
    var r = payPeriodRange(sh.start, s);
    if (!seen[r.start]) { seen[r.start] = { range: r, shifts: [] }; periods.push(seen[r.start]); }
    seen[r.start].shifts.push(sh);
  });
  periods.sort(function (a, b) { return b.range.start - a.range.start; });
  var shown = periods.slice(0, shiftsPeriodLimit);

  var html = head + shown.map(function (p) {
    var tot = { regular: 0, ot: 0, dt: 0, gross: 0, hours: 0 };
    var emps = filterId === 'all' ? state.employees : [employee(filterId)].filter(Boolean);
    emps.forEach(function (emp) {
      var cursor = weekStart(p.range.start, s);
      while (cursor <= p.range.end) {
        var wEnd = addDays(cursor, 7) - 1;
        var lo = Math.max(cursor, p.range.start), hi = Math.min(wEnd, p.range.end);
        var ws = p.shifts.filter(function (x) { return x.employeeId === emp.id && x.start >= lo && x.start <= hi; });
        if (ws.length) {
          var r = splitPay(ws, emp, s);
          tot.regular += r.regular; tot.ot += r.ot; tot.dt += r.dt; tot.gross += r.gross; tot.hours += r.hours;
        }
        cursor = addDays(cursor, 7);
      }
    });

    // days within the period
    var days = {}, dayKeys = [];
    p.shifts.forEach(function (sh) {
      var k = startOfDay(sh.start);
      if (!days[k]) { days[k] = []; dayKeys.push(k); }
      days[k].push(sh);
    });
    dayKeys.sort(function (a, b) { return b - a; });

    return '<div class="grp-head"><h3>' + esc(p.range.label) + '</h3>' +
      '<span class="tot">' + hrs(tot.hours) + ' · ' + money(tot.gross) + '</span></div>' +
      '<div class="chips" style="margin:0 2px 8px">' +
        '<span class="badge">Reg ' + hrs(tot.regular) + '</span>' +
        (tot.ot > 0.001 ? '<span class="badge warn">OT ' + hrs(tot.ot) + '</span>' : '') +
        (tot.dt > 0.001 ? '<span class="badge bad">DT ' + hrs(tot.dt) + '</span>' : '') +
      '</div>' +
      '<div class="card tight">' + dayKeys.map(function (k) {
        var list = days[k].slice().sort(function (a, b) { return b.start - a.start; });
        var dayH = sum(list, function (x) { return shiftHours(x, s); });
        return '<div class="day-head">' + fmtDay(k) + ' · ' + hrs(dayH) + '</div>' +
          '<div class="rows">' + list.map(shiftRowHTML).join('') + '</div>';
      }).join('') + '</div>';
  }).join('') +
  (periods.length > shown.length ?
    '<button class="btn ghost block" type="button" data-act="more-periods">Show older pay periods</button>' : '') +
  '<div class="swipe-hint">Tap a shift to edit · long-press to delete</div>';

  host.innerHTML = html;
  wireShifts(host);
}

function shiftRowHTML(sh) {
  var s = state.settings;
  var emp = employee(sh.employeeId);
  var mins = roundedPaidMinutes(sh, s);
  var pay = (mins / 60) * (emp ? num(emp.hourlyRate, 0) : 0);
  var running = sh.end == null;
  var flags = '';
  if (running) flags += '<span class="badge good">Running</span> ';
  if (!sh.approved) flags += '<span class="badge warn">Unapproved</span> ';
  if (sh.source === 'geo') flags += '<span class="badge info">Geo</span> ';
  return '<button class="row" type="button" data-shift="' + esc(sh.id) + '">' +
    '<span class="dot" style="background:' + esc(siteColor(sh.jobSiteId)) + '"></span>' +
    '<span class="grow"><span class="ttl">' + esc(siteName(sh.jobSiteId)) + '</span>' +
    '<span class="meta">' + fmtTime(sh.start) + ' – ' + (running ? 'now' : fmtTime(sh.end)) +
      (state.employees.length > 1 && emp ? ' · ' + esc(emp.name) : '') +
      (sh.notes ? ' · 📝' : '') + (sh.photos && sh.photos.length ? ' 📷' + sh.photos.length : '') +
      '</span>' + (flags ? '<span class="meta">' + flags + '</span>' : '') + '</span>' +
    '<span class="right"><span class="big">' + hm(mins) + '</span>' +
    '<span class="meta">' + money(pay) + '</span></span>' +
    '<svg class="chev" aria-hidden="true" width="16" height="16"><use href="#i-chev"></use></svg>' +
    '</button>';
}

function wireShifts(host) {
  delegate(host, 'click', '[data-act]', function (e, t) {
    var a = t.getAttribute('data-act');
    if (a === 'add-shift') openShiftEditor(null);
    if (a === 'export-csv') exportTimesheetCSV();
    if (a === 'more-periods') { shiftsPeriodLimit += 6; renderShifts(host); }
  });
  delegate(host, 'click', '[data-emp]', function (e, t) {
    state.filterEmployeeId = t.getAttribute('data-emp');
    renderShifts(host);
  });

  // Tap = edit, long-press = delete.
  var timer = null, fired = false;
  delegate(host, 'pointerdown', '[data-shift]', function (e, t) {
    fired = false;
    timer = setTimeout(function () {
      fired = true;
      confirmDeleteShift(t.getAttribute('data-shift'));
    }, 600);
  });
  ['pointerup', 'pointercancel', 'pointerleave', 'pointermove'].forEach(function (ev) {
    delegate(host, ev, '[data-shift]', function () { if (timer) { clearTimeout(timer); timer = null; } });
  });
  delegate(host, 'click', '[data-shift]', function (e, t) {
    if (fired) { fired = false; return; }
    var sh = byId(state.shifts, t.getAttribute('data-shift'));
    if (sh) openShiftEditor(sh);
  });
}

function confirmDeleteShift(id) {
  var sh = byId(state.shifts, id);
  if (!sh) return;
  confirmSheet({
    title: 'Delete shift?',
    message: fmtDay(sh.start) + ', ' + fmtTime(sh.start) + ' – ' + (sh.end ? fmtTime(sh.end) : 'running') +
             ' at ' + siteName(sh.jobSiteId) + '. This cannot be undone.',
    okText: 'Delete', danger: true
  }).then(function (ok) {
    if (!ok) return;
    if (sh.end == null) setActivePunch(null);
    remove('shifts', 'shifts', sh.id).then(function () { toast('Shift deleted'); renderRoute(); });
  });
}

/* ---- shift editor sheet ------------------------------------------------- */
function openShiftEditor(existing) {
  var s = state.settings;
  var me = selfEmployee();
  var draft = existing
    ? JSON.parse(JSON.stringify(existing))
    : newShift({ employeeId: me.id, jobSiteId: lastUsedSiteId(me.id),
                 start: startOfDay(Date.now()) + 8 * MS_HOUR,
                 end: startOfDay(Date.now()) + 12 * MS_HOUR, source: 'manual', approved: true });

  function breaksHTML() {
    return (draft.breaks || []).map(function (b, i) {
      return '<div class="card" style="padding:12px;margin-bottom:8px">' +
        '<div class="two-up">' +
          '<div class="field" style="margin:0"><label for="bs' + i + '">Break start</label>' +
            '<input id="bs' + i + '" type="datetime-local" value="' + (b.start ? isoLocalDateTime(b.start) : '') + '" data-bstart="' + i + '"></div>' +
          '<div class="field" style="margin:0"><label for="be' + i + '">Break end</label>' +
            '<input id="be' + i + '" type="datetime-local" value="' + (b.end ? isoLocalDateTime(b.end) : '') + '" data-bend="' + i + '"></div>' +
        '</div>' +
        '<div class="switch-row" style="border-bottom:0">' +
          '<span class="grow"><span class="ttl">Paid break</span>' +
          '<span class="meta">' + (b.paid ? 'Counted as work time' : 'Deducted from paid time') + '</span></span>' +
          '<button class="switch" type="button" role="switch" aria-checked="' + (!!b.paid) + '" data-bpaid="' + i + '" aria-label="Paid break"></button>' +
        '</div>' +
        '<button class="btn danger sm" type="button" data-brm="' + i + '">Remove break</button>' +
      '</div>';
    }).join('');
  }

  function bodyHTML() {
    return '' +
      field({ id: 'shEmp', label: 'Employee', type: 'select', value: draft.employeeId, options: employeeOptions(draft.employeeId) }) +
      field({ id: 'shSite', label: 'Job site', type: 'select', value: draft.jobSiteId || '', options: jobSiteOptions(draft.jobSiteId) }) +
      '<div class="two-up">' +
        field({ id: 'shStart', label: 'Start', type: 'datetime-local', value: isoLocalDateTime(draft.start), err: 'Start time required' }) +
        field({ id: 'shEnd', label: 'End', type: 'datetime-local', value: draft.end == null ? '' : isoLocalDateTime(draft.end),
                hint: 'Leave blank to keep it running', err: 'End must be after start' }) +
      '</div>' +
      '<div class="section-title">Breaks</div>' + breaksHTML() +
      '<button class="btn ghost sm" type="button" data-badd>+ Add break</button>' +
      '<div class="section-title">Details</div>' +
      field({ id: 'shNotes', label: 'Notes', type: 'textarea', value: draft.notes, rows: 3 }) +
      '<div class="two-up">' +
        field({ id: 'shMiles', label: 'Miles driven', type: 'number', value: draft.miles, attrs: 'step="0.1" min="0" inputmode="decimal"' }) +
        field({ id: 'shDrive', label: 'Drive minutes', type: 'number', value: draft.driveMinutes, attrs: 'step="1" min="0" inputmode="numeric"' }) +
      '</div>' +
      '<div class="switch-row"><span class="grow"><span class="ttl">Approved</span>' +
        '<span class="meta">Crew punches start unapproved until you check them.</span></span>' +
        '<button class="switch" type="button" role="switch" aria-checked="' + (!!draft.approved) + '" data-approve aria-label="Approved"></button></div>' +
      '<div class="section-title">Photos</div>' +
      '<label class="btn ghost sm" for="shPhoto">Add photo<input id="shPhoto" data-photo-input type="file" accept="image/*" capture="environment" multiple class="visually-hidden"></label>' +
      renderThumbs(draft.photos) +
      '<div id="shWarn"></div>' +
      (existing ? '<button class="btn danger block" type="button" data-del style="margin-top:16px">Delete shift</button>' : '');
  }

  openSheet({
    title: existing ? 'Edit shift' : 'Add shift',
    body: bodyHTML(),
    foot: '<button class="btn ghost" type="button" data-sheet-close>Cancel</button>' +
          '<button class="btn primary" type="button" data-save>Save</button>',
    onMount: function (el, close) {
      function rerender() {
        $('.sheet-body', el).innerHTML = bodyHTML();
        wire();
      }
      function readFields() {
        draft.employeeId = val(el, 'shEmp') || draft.employeeId;
        draft.jobSiteId = val(el, 'shSite') || null;
        draft.notes = val(el, 'shNotes');
        draft.miles = num(val(el, 'shMiles'), 0);
        draft.driveMinutes = num(val(el, 'shDrive'), 0);
        var st = parseLocal(val(el, 'shStart'));
        var en = val(el, 'shEnd') ? parseLocal(val(el, 'shEnd')) : null;
        return { start: st, end: en };
      }
      function wire() {
        wirePhotoInput(el, function () { return draft.photos || []; },
          function (l) { draft.photos = l; }, rerender);

        var ap = $('[data-approve]', el);
        if (ap) on(ap, 'click', function () {
          draft.approved = !draft.approved;
          ap.setAttribute('aria-checked', String(draft.approved));
        });
        var badd = $('[data-badd]', el);
        if (badd) on(badd, 'click', function () {
          var t = readFields();
          if (t.start) draft.start = t.start;
          draft.breaks = (draft.breaks || []).concat([{ start: draft.start + 4 * MS_HOUR, end: draft.start + 4.5 * MS_HOUR, paid: false }]);
          rerender();
        });
        $$('[data-brm]', el).forEach(function (b) {
          on(b, 'click', function () { draft.breaks.splice(int(b.getAttribute('data-brm'), 0), 1); rerender(); });
        });
        $$('[data-bpaid]', el).forEach(function (b) {
          on(b, 'click', function () {
            var i = int(b.getAttribute('data-bpaid'), 0);
            draft.breaks[i].paid = !draft.breaks[i].paid;
            b.setAttribute('aria-checked', String(draft.breaks[i].paid));
          });
        });
        $$('[data-bstart]', el).forEach(function (inp) {
          on(inp, 'change', function () { draft.breaks[int(inp.getAttribute('data-bstart'), 0)].start = parseLocal(inp.value); });
        });
        $$('[data-bend]', el).forEach(function (inp) {
          on(inp, 'change', function () {
            var v = inp.value ? parseLocal(inp.value) : null;
            draft.breaks[int(inp.getAttribute('data-bend'), 0)].end = v;
          });
        });
        var del = $('[data-del]', el);
        if (del) on(del, 'click', function () {
          close();
          confirmDeleteShift(existing.id);
        });
      }
      wire();

      on($('[data-save]', el), 'click', function () {
        clearErrors(el);
        var t = readFields();
        var bad = false;
        if (!t.start) { fieldError(el, 'shStart', 'Pick a start time'); bad = true; }
        if (t.end != null && t.start != null && t.end <= t.start) { fieldError(el, 'shEnd', 'End must be after start'); bad = true; }
        if (bad) return;

        draft.start = t.start;
        draft.end = t.end;
        (draft.breaks || []).forEach(function (b) {
          if (b.start == null) b.start = draft.start;
        });

        var hours = (( (draft.end == null ? Date.now() : draft.end) - draft.start) / MS_HOUR);
        var warn = $('#shWarn', el);
        var overlaps = findOverlaps(draft);

        function finish() {
          var rec = newShift(draft);
          rec.updatedAt = Date.now();
          upsert('shifts', 'shifts', rec).then(function () {
            state.shifts.sort(function (a, b) { return b.start - a.start; });
            if (rec.end == null) {
              setActivePunch({ shiftId: rec.id, employeeId: rec.employeeId, jobSiteId: rec.jobSiteId, start: rec.start, breakStart: null });
            } else if (existing && existing.end == null) {
              setActivePunch(null);
            }
            close();
            toast(existing ? 'Shift updated' : 'Shift added');
            renderRoute();
          });
        }

        if (overlaps.length) {
          warn.innerHTML = '';
          confirmSheet({
            title: 'Overlapping shift',
            message: 'This overlaps ' + overlaps.length + ' existing shift' + (overlaps.length > 1 ? 's' : '') +
                     ' for ' + (employee(draft.employeeId) || {}).name + '. Save anyway?',
            detail: overlaps.map(function (o) {
              return '<div class="kv"><span class="k">' + fmtDay(o.start) + '</span><span class="v">' +
                fmtTime(o.start) + ' – ' + (o.end ? fmtTime(o.end) : 'running') + '</span></div>';
            }).join(''),
            okText: 'Save anyway'
          }).then(function (ok) { if (ok) finish(); });
          return;
        }
        if (hours > num(s.maxShiftHours, 14)) {
          confirmSheet({
            title: 'That is a long shift',
            message: hrs(hours) + ' is past your ' + num(s.maxShiftHours, 14) + '-hour limit. Save it anyway?',
            okText: 'Save anyway'
          }).then(function (ok) { if (ok) finish(); });
          return;
        }
        finish();
      });
    }
  });
}

/* ==========================================================================
   9. VIEW: JOBS — customers, job sites, per-site profitability
   ========================================================================== */

/** Effective bill rate for a site: site rate wins, else the customer default. */
function billRateFor(js) {
  if (!js) return 0;
  if (num(js.billRate, 0) > 0) return num(js.billRate, 0);
  var c = customer(js.customerId);
  return c ? num(c.defaultBillRate, 0) : 0;
}

/**
 * siteStats(jobSiteId, [from, to]) -> hours, labor, billed, expenses, profit, margin
 * Expenses attach either directly to the site or to a shift worked there.
 */
function siteStats(jobSiteId, from, to) {
  var s = state.settings;
  var shifts = state.shifts.filter(function (x) {
    if (x.jobSiteId !== jobSiteId) return false;
    if (from != null && x.start < from) return false;
    if (to != null && x.start > to) return false;
    return true;
  });
  var ids = {};
  shifts.forEach(function (x) { ids[x.id] = 1; });
  var hours = sum(shifts, function (x) { return shiftHours(x, s); });
  var labor = laborCost(shifts, s);
  var billed = hours * billRateFor(site(jobSiteId));
  var exp = sum(state.expenses.filter(function (e) {
    if (from != null && e.date < from) return false;
    if (to != null && e.date > to) return false;
    return e.jobSiteId === jobSiteId || (e.shiftId && ids[e.shiftId]);
  }), function (e) { return num(e.amount, 0); });
  var profit = billed - labor - exp;
  return {
    shifts: shifts.length, hours: hours, labor: labor, billed: billed, expenses: exp,
    profit: profit, margin: billed > 0 ? profit / billed : null,
    perHour: hours > 0 ? (billed - exp) / hours : null
  };
}

function customerStats(customerId, from, to) {
  var sites = state.jobSites.filter(function (s) { return s.customerId === customerId; });
  var agg = { hours: 0, labor: 0, billed: 0, expenses: 0, profit: 0, shifts: 0 };
  sites.forEach(function (s) {
    var st = siteStats(s.id, from, to);
    agg.hours += st.hours; agg.labor += st.labor; agg.billed += st.billed;
    agg.expenses += st.expenses; agg.profit += st.profit; agg.shifts += st.shifts;
  });
  agg.margin = agg.billed > 0 ? agg.profit / agg.billed : null;
  agg.perHour = agg.hours > 0 ? (agg.billed - agg.expenses) / agg.hours : null;
  return agg;
}

function marginBadge(margin) {
  if (margin == null) return '<span class="badge">No bill rate</span>';
  var cls = margin >= 0.4 ? 'good' : margin >= 0.15 ? 'warn' : 'bad';
  return '<span class="badge ' + cls + '">' + pct(margin) + ' margin</span>';
}

function renderJobs(host) {
  var custs = state.customers.slice().sort(function (a, b) {
    return (a.archived ? 1 : 0) - (b.archived ? 1 : 0) || (a.name < b.name ? -1 : 1);
  });

  var head = '<div class="btn-row" style="margin-bottom:12px">' +
    '<button class="btn primary" type="button" data-act="add-cust">+ Customer</button>' +
    '<button class="btn ghost" type="button" data-act="add-site"' + (custs.length ? '' : ' disabled') + '>+ Job site</button>' +
    '</div>';

  if (!custs.length) {
    host.innerHTML = head + '<div class="card"><div class="empty"><div class="big">🏡</div>' +
      '<h3>No customers yet</h3><p>Add a customer, then a job site under them. Job sites are what your punches attach to.</p></div></div>';
    wireJobs(host);
    return;
  }

  var orphans = state.jobSites.filter(function (s) { return !s.customerId || !customer(s.customerId); });

  host.innerHTML = head + custs.map(function (c) {
    var sites = state.jobSites.filter(function (s) { return s.customerId === c.id; }).sort(by('name'));
    var cs = customerStats(c.id);
    return '<div class="grp-head"><h3>' + esc(c.name) + (c.archived ? ' <span class="badge">Archived</span>' : '') + '</h3>' +
      '<span class="tot">' + hrs(cs.hours) + ' · ' + money(cs.profit) + ' profit</span></div>' +
      '<div class="card tight"><div class="rows">' +
        sites.map(function (s) {
          var st = siteStats(s.id);
          return '<button class="row" type="button" data-site="' + esc(s.id) + '">' +
            '<span class="dot lg" style="background:' + esc(s.colorHex) + '"></span>' +
            '<span class="grow"><span class="ttl">' + esc(s.name) + (s.archived ? ' · archived' : '') + '</span>' +
            '<span class="meta">' + hrs(st.hours) + ' · labor ' + money(st.labor) + ' · billed ' + money(st.billed) +
            (s.lat != null ? ' · 📍' + int(s.radiusMeters, 120) + 'm' : '') + '</span>' +
            '<span class="meta" style="margin-top:5px">' + marginBadge(st.margin) +
            (st.perHour != null ? ' <span class="badge">' + money(st.perHour) + '/hr net</span>' : '') + '</span></span>' +
            '<span class="right"><span class="big">' + money(st.profit) + '</span><span class="meta">profit</span></span>' +
            '</button>';
        }).join('') +
        '<button class="row" type="button" data-editcust="' + esc(c.id) + '">' +
          '<span class="dot" style="background:var(--text-3)"></span>' +
          '<span class="grow"><span class="ttl">Edit ' + esc(c.name) + '</span>' +
          '<span class="meta">' + esc(c.contact || 'No contact') + ' · bills ' + money(c.defaultBillRate) + '/hr</span></span>' +
          '<svg class="chev" aria-hidden="true" width="16" height="16"><use href="#i-chev"></use></svg></button>' +
        (sites.length ? '' : '<div class="day-head">No job sites for this customer yet</div>') +
      '</div></div>';
  }).join('') +
  (orphans.length ? '<div class="grp-head"><h3>Unassigned sites</h3></div><div class="card tight"><div class="rows">' +
    orphans.map(function (s) {
      var st = siteStats(s.id);
      return '<button class="row" type="button" data-site="' + esc(s.id) + '">' +
        '<span class="dot lg" style="background:' + esc(s.colorHex) + '"></span>' +
        '<span class="grow"><span class="ttl">' + esc(s.name) + '</span><span class="meta">' + hrs(st.hours) + '</span></span>' +
        '</button>';
    }).join('') + '</div></div>' : '');

  wireJobs(host);
}

function wireJobs(host) {
  delegate(host, 'click', '[data-act]', function (e, t) {
    var a = t.getAttribute('data-act');
    if (a === 'add-cust') openCustomerEditor(null);
    if (a === 'add-site') openJobSiteEditor(null);
  });
  delegate(host, 'click', '[data-editcust]', function (e, t) {
    openCustomerEditor(byId(state.customers, t.getAttribute('data-editcust')));
  });
  delegate(host, 'click', '[data-site]', function (e, t) {
    openJobSiteEditor(byId(state.jobSites, t.getAttribute('data-site')));
  });
}

/* ---- customer editor ---------------------------------------------------- */
function openCustomerEditor(existing) {
  var d = existing ? Object.assign({}, existing) : newCustomer({});
  openSheet({
    title: existing ? 'Edit customer' : 'New customer',
    body:
      field({ id: 'cName', label: 'Name', value: d.name, attrs: 'autocomplete="off" required', err: 'Name is required' }) +
      field({ id: 'cContact', label: 'Contact', value: d.contact, attrs: 'autocomplete="off"', hint: 'Phone or email' }) +
      field({ id: 'cAddr', label: 'Address', value: d.address, attrs: 'autocomplete="off"' }) +
      field({ id: 'cRate', label: 'Default bill rate ($/hr)', type: 'number', value: d.defaultBillRate,
              attrs: 'step="0.01" min="0" inputmode="decimal"', hint: 'What you charge them per hour. Job sites can override this.' }) +
      field({ id: 'cNotes', label: 'Notes', type: 'textarea', value: d.notes, rows: 2 }) +
      '<div class="switch-row"><span class="grow"><span class="ttl">Archived</span>' +
        '<span class="meta">Hidden from pickers, history is kept.</span></span>' +
        '<button class="switch" type="button" role="switch" aria-checked="' + (!!d.archived) + '" data-arch aria-label="Archived"></button></div>' +
      (existing ? '<button class="btn danger block" type="button" data-del style="margin-top:16px">Delete customer</button>' : ''),
    foot: '<button class="btn ghost" type="button" data-sheet-close>Cancel</button>' +
          '<button class="btn primary" type="button" data-save>Save</button>',
    onMount: function (el, close) {
      var arch = $('[data-arch]', el);
      on(arch, 'click', function () { d.archived = !d.archived; arch.setAttribute('aria-checked', String(d.archived)); });
      var del = $('[data-del]', el);
      if (del) on(del, 'click', function () {
        var sites = state.jobSites.filter(function (s) { return s.customerId === existing.id; });
        confirmSheet({
          title: 'Delete customer?',
          message: sites.length
            ? 'This also deletes ' + sites.length + ' job site(s). Shifts stay but lose their job. This cannot be undone.'
            : 'This cannot be undone.',
          okText: 'Delete', danger: true
        }).then(function (ok) {
          if (!ok) return;
          Promise.all(sites.map(function (s) {
            state.shifts.forEach(function (sh) { if (sh.jobSiteId === s.id) { sh.jobSiteId = null; saveShift(sh); } });
            return remove('jobSites', 'jobSites', s.id);
          })).then(function () {
            return remove('customers', 'customers', existing.id);
          }).then(function () { close(); toast('Customer deleted'); renderRoute(); });
        });
      });
      on($('[data-save]', el), 'click', function () {
        clearErrors(el);
        if (!val(el, 'cName').trim()) { fieldError(el, 'cName', 'Name is required'); return; }
        d.name = val(el, 'cName').trim();
        d.contact = val(el, 'cContact').trim();
        d.address = val(el, 'cAddr').trim();
        d.defaultBillRate = num(val(el, 'cRate'), 0);
        d.notes = val(el, 'cNotes');
        upsert('customers', 'customers', newCustomer(d)).then(function () {
          close(); toast('Customer saved'); renderRoute();
        });
      });
    }
  });
}

/* ---- job site editor (with "use my location" + radius slider) ----------- */
function openJobSiteEditor(existing) {
  var d = existing ? Object.assign({}, existing) : newJobSite({ customerId: (state.customers[0] || {}).id });
  var stats = existing ? siteStats(existing.id) : null;

  function coordLine() {
    return d.lat == null
      ? 'No pin set — geofencing off for this site'
      : d.lat.toFixed(5) + ', ' + d.lng.toFixed(5);
  }
  function body() {
    return field({ id: 'jName', label: 'Job site name', value: d.name, attrs: 'autocomplete="off"', err: 'Name is required' }) +
      field({ id: 'jCust', label: 'Customer', type: 'select', value: d.customerId || '',
              options: [{ value: '', label: '— None —' }].concat(state.customers.map(function (c) { return { value: c.id, label: c.name }; })) }) +
      field({ id: 'jAddr', label: 'Address', value: d.address, attrs: 'autocomplete="off"' }) +
      field({ id: 'jRate', label: 'Bill rate ($/hr)', type: 'number', value: d.billRate,
              attrs: 'step="0.01" min="0" inputmode="decimal"', hint: 'Blank or 0 uses the customer default.' }) +
      '<div class="field"><span class="lbl-txt">Colour</span>' +
        '<div class="chips">' + PALETTE.map(function (c) {
          return '<button class="chip" type="button" data-color="' + c + '" aria-pressed="' + (d.colorHex === c) + '" ' +
            'aria-label="Colour ' + c + '"><span class="dot" style="background:' + c + '"></span></button>';
        }).join('') + '</div></div>' +
      '<div class="section-title">Geofence</div>' +
      '<div class="card" style="padding:14px">' +
        '<div class="kv"><span class="k">Pin</span><span class="v mono">' + esc(coordLine()) + '</span></div>' +
        '<div class="btn-row" style="margin-top:10px">' +
          '<button class="btn ghost sm" type="button" data-locate>Use my current location</button>' +
          (d.lat != null ? '<button class="btn ghost sm" type="button" data-clearpin>Clear pin</button>' : '') +
        '</div>' +
        '<div class="field" style="margin-top:14px;margin-bottom:0">' +
          '<label for="jRadius">Radius: <span data-radlbl>' + int(d.radiusMeters, 120) + '</span> m</label>' +
          '<input id="jRadius" type="range" min="50" max="500" step="10" value="' + int(d.radiusMeters, 120) + '">' +
          '<div class="hint">Punch prompts fire when you cross this circle — only while Punchline is open.</div>' +
        '</div>' +
      '</div>' +
      (stats ? '<div class="section-title">Lifetime</div><div class="card">' +
        '<div class="kv"><span class="k">Shifts</span><span class="v">' + stats.shifts + '</span></div>' +
        '<div class="kv"><span class="k">Hours</span><span class="v">' + hrs(stats.hours) + '</span></div>' +
        '<div class="kv"><span class="k">Labor cost</span><span class="v">' + money(stats.labor) + '</span></div>' +
        '<div class="kv"><span class="k">Expenses</span><span class="v">' + money(stats.expenses) + '</span></div>' +
        '<div class="kv"><span class="k">Billed</span><span class="v">' + money(stats.billed) + '</span></div>' +
        '<div class="kv"><span class="k">Profit</span><span class="v">' + money(stats.profit) + ' ' + marginBadge(stats.margin) + '</span></div>' +
        '</div>' : '') +
      field({ id: 'jNotes', label: 'Notes', type: 'textarea', value: d.notes, rows: 2 }) +
      '<div class="switch-row"><span class="grow"><span class="ttl">Archived</span>' +
        '<span class="meta">Hidden from pickers, history is kept.</span></span>' +
        '<button class="switch" type="button" role="switch" aria-checked="' + (!!d.archived) + '" data-arch aria-label="Archived"></button></div>' +
      (existing ? '<button class="btn danger block" type="button" data-del style="margin-top:16px">Delete job site</button>' : '');
  }

  openSheet({
    title: existing ? 'Edit job site' : 'New job site',
    body: body(),
    foot: '<button class="btn ghost" type="button" data-sheet-close>Cancel</button>' +
          '<button class="btn primary" type="button" data-save>Save</button>',
    onMount: function (el, close) {
      function rerender() { $('.sheet-body', el).innerHTML = body(); wire(); }
      function wire() {
        $$('[data-color]', el).forEach(function (btn) {
          on(btn, 'click', function () {
            d.colorHex = btn.getAttribute('data-color');
            $$('[data-color]', el).forEach(function (b) {
              b.setAttribute('aria-pressed', String(b.getAttribute('data-color') === d.colorHex));
            });
          });
        });
        var rad = $('#jRadius', el);
        if (rad) on(rad, 'input', function () {
          d.radiusMeters = int(rad.value, 120);
          $('[data-radlbl]', el).textContent = d.radiusMeters;
        });
        var loc = $('[data-locate]', el);
        if (loc) on(loc, 'click', function () {
          if (!navigator.geolocation) { toast('This browser has no geolocation', 'err'); return; }
          loc.disabled = true; loc.textContent = 'Locating…';
          navigator.geolocation.getCurrentPosition(function (pos) {
            d.lat = pos.coords.latitude; d.lng = pos.coords.longitude;
            if (pos.coords.accuracy && pos.coords.accuracy > d.radiusMeters) {
              d.radiusMeters = clamp(Math.round(pos.coords.accuracy), 50, 500);
            }
            // Capture typed values before the re-render blows them away.
            d.name = val(el, 'jName'); d.address = val(el, 'jAddr');
            d.billRate = num(val(el, 'jRate'), 0); d.notes = val(el, 'jNotes');
            d.customerId = val(el, 'jCust') || null;
            rerender();
            toast('Pin set (±' + Math.round(pos.coords.accuracy || 0) + 'm)');
          }, function (err) {
            loc.disabled = false; loc.textContent = 'Use my current location';
            toast('Location failed: ' + (err && err.message ? err.message : 'denied'), 'err', 4000);
          }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
        });
        var clr = $('[data-clearpin]', el);
        if (clr) on(clr, 'click', function () {
          d.lat = null; d.lng = null;
          d.name = val(el, 'jName'); d.address = val(el, 'jAddr');
          rerender(); toast('Pin cleared');
        });
        var arch = $('[data-arch]', el);
        if (arch) on(arch, 'click', function () { d.archived = !d.archived; arch.setAttribute('aria-checked', String(d.archived)); });
        var del = $('[data-del]', el);
        if (del) on(del, 'click', function () {
          confirmSheet({
            title: 'Delete job site?',
            message: 'Shifts worked here stay, but lose their job assignment. This cannot be undone.',
            okText: 'Delete', danger: true
          }).then(function (ok) {
            if (!ok) return;
            state.shifts.forEach(function (sh) { if (sh.jobSiteId === existing.id) { sh.jobSiteId = null; saveShift(sh); } });
            remove('jobSites', 'jobSites', existing.id).then(function () { close(); toast('Job site deleted'); renderRoute(); });
          });
        });
      }
      wire();
      on($('[data-save]', el), 'click', function () {
        clearErrors(el);
        if (!val(el, 'jName').trim()) { fieldError(el, 'jName', 'Name is required'); return; }
        d.name = val(el, 'jName').trim();
        d.customerId = val(el, 'jCust') || null;
        d.address = val(el, 'jAddr').trim();
        d.billRate = num(val(el, 'jRate'), 0);
        d.notes = val(el, 'jNotes');
        var rec = newJobSite(d);
        rec.colorHex = d.colorHex || rec.colorHex;
        upsert('jobSites', 'jobSites', rec).then(function () { close(); toast('Job site saved'); renderRoute(); });
      });
    }
  });
}

/* ==========================================================================
   10. VIEW: MONEY — pay period, expenses, profitability, exports, invoice
   ========================================================================== */

var moneyPeriodOffset = 0;   // 0 = current period, -1 = previous, ...

function currentMoneyRange() {
  var base = payPeriodRange(Date.now(), state.settings);
  return moneyPeriodOffset === 0 ? base : shiftPayPeriod(base, moneyPeriodOffset, state.settings);
}

function renderMoney(host) {
  var s = state.settings;
  var range = currentMoneyRange();
  var isCurrent = Date.now() >= range.start && Date.now() <= range.end;
  var totals = periodTotals(range, state.filterEmployeeId, s);

  var exps = state.expenses.filter(function (e) { return e.date >= range.start && e.date <= range.end; })
                           .sort(function (a, b) { return b.date - a.date; });
  var expTotal = sum(exps, function (e) { return num(e.amount, 0); });

  // Mileage reimbursement inside the period (informational, added to net).
  var miles = sum(shiftsInRange(range.start, range.end, state.filterEmployeeId), function (x) { return num(x.miles, 0); });
  var mileagePay = miles * num(s.mileageRate, 0);

  // --- OT progress: current work week against the weekly threshold ---------
  var wkStart = weekStart(isCurrent ? Date.now() : range.start, s);
  var wkEnd = addDays(wkStart, 7) - 1;
  var wkShifts = state.shifts.filter(function (x) {
    return (state.filterEmployeeId === 'all' || x.employeeId === state.filterEmployeeId) &&
           x.start >= wkStart && x.start <= wkEnd;
  });
  var wkHours = sum(wkShifts, function (x) { return shiftHours(x, s); });
  var otThresh = num(s.weeklyOTThreshold, 40);
  var otPctVal = otThresh > 0 ? clamp(wkHours / otThresh, 0, 1) : 0;

  // --- projection based on pace -------------------------------------------
  var projection = '';
  if (isCurrent) {
    var elapsedDays = clamp(dayDiff(Date.now(), range.start) + 1, 1, 400);
    var totalDays = dayDiff(range.end, range.start) + 1;
    if (totals.hours > 0 && elapsedDays < totalDays) {
      var projGross = totals.gross / elapsedDays * totalDays;
      var projHours = totals.hours / elapsedDays * totalDays;
      projection = '<div class="kv"><span class="k">Projected at this pace</span><span class="v">' +
        money(projGross) + ' · ' + hrs(projHours) + '</span></div>';
    } else if (elapsedDays >= totalDays) {
      projection = '<div class="kv"><span class="k">Period complete</span><span class="v">' + money(totals.gross) + '</span></div>';
    }
  }

  var perCustomer = state.customers.map(function (c) {
    var st = customerStats(c.id, range.start, range.end);
    return { c: c, st: st };
  }).filter(function (r) { return r.st.hours > 0.001; })
    .sort(function (a, b) { return (b.st.perHour || 0) - (a.st.perHour || 0); });

  host.innerHTML =
    '<div class="btn-row" style="margin-bottom:12px">' +
      '<button class="btn ghost sm" type="button" data-act="prev-period" aria-label="Previous pay period">‹ Prev</button>' +
      '<button class="btn ghost sm" type="button" data-act="this-period">' + esc(range.label) + '</button>' +
      '<button class="btn ghost sm" type="button" data-act="next-period" aria-label="Next pay period"' +
        (moneyPeriodOffset >= 0 ? ' disabled' : '') + '>Next ›</button>' +
    '</div>' +

    (state.employees.length > 1 ?
      '<div class="chips" style="margin-bottom:12px">' +
        '<button class="chip" type="button" aria-pressed="' + (state.filterEmployeeId === 'all') + '" data-emp="all">Everyone</button>' +
        state.employees.map(function (e) {
          return '<button class="chip" type="button" aria-pressed="' + (state.filterEmployeeId === e.id) + '" data-emp="' + esc(e.id) + '">' + esc(e.name) + '</button>';
        }).join('') + '</div>' : '') +

    '<div class="card">' +
      '<h2>' + esc(s.payPeriod.charAt(0).toUpperCase() + s.payPeriod.slice(1)) + ' pay period</h2>' +
      '<div class="stats" style="margin:10px 0 14px">' +
        '<div class="stat"><div class="lbl">Regular</div><div class="val">' + hrs(totals.regular) + '</div></div>' +
        '<div class="stat"><div class="lbl">Overtime</div><div class="val">' + hrs(totals.ot) + '</div></div>' +
        '<div class="stat"><div class="lbl">Double</div><div class="val">' + hrs(totals.dt) + '</div></div>' +
      '</div>' +
      '<div class="kv"><span class="k">Gross pay</span><span class="v">' + money(totals.gross) + '</span></div>' +
      '<div class="kv"><span class="k">Expenses</span><span class="v">−' + money(expTotal) + '</span></div>' +
      (miles > 0 ? '<div class="kv"><span class="k">Mileage (' + miles.toFixed(1) + ' mi @ ' + money(s.mileageRate) + ')</span><span class="v">+' + money(mileagePay) + '</span></div>' : '') +
      '<div class="kv"><span class="k">Net</span><span class="v">' + money(totals.gross - expTotal + mileagePay) + '</span></div>' +
      projection +
      '<div style="margin-top:14px">' +
        '<div class="kv" style="padding-bottom:4px"><span class="k">Week of ' + fmtDateShort(wkStart) + '</span>' +
          '<span class="v">' + hrs(wkHours) + ' / ' + hrs(otThresh) + '</span></div>' +
        '<div class="bar"><span class="' + (wkHours > otThresh ? 'over' : '') + '" style="width:' + (otPctVal * 100).toFixed(1) + '%"></span></div>' +
        '<div class="inline-note">' +
          (otThresh <= 0 ? 'Weekly overtime is switched off.' :
            wkHours >= otThresh ? 'Over the threshold — extra hours pay at ' + num(s.otMultiplier, 1.5) + '×.' :
            hrs(otThresh - wkHours) + ' left before overtime kicks in.') +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="section-title">Exports</div>' +
    '<div class="card">' +
      '<div class="btn-row">' +
        '<button class="btn ghost" type="button" data-act="csv-time">CSV timesheet</button>' +
        '<button class="btn ghost" type="button" data-act="csv-exp">CSV expenses</button>' +
      '</div>' +
      '<button class="btn primary block" type="button" data-act="invoice" style="margin-top:10px">Build an invoice</button>' +
      '<div class="inline-note">CSV covers the pay period shown above. The invoice opens a printable page — use your browser’s Print → Save as PDF.</div>' +
    '</div>' +

    '<div class="section-title">Expenses</div>' +
    '<div class="card tight">' +
      '<div class="rows">' +
        (exps.length ? exps.map(function (e) {
          return '<button class="row" type="button" data-exp="' + esc(e.id) + '">' +
            '<span class="dot" style="background:' + esc(e.jobSiteId ? siteColor(e.jobSiteId) : 'var(--warn)') + '"></span>' +
            '<span class="grow"><span class="ttl">' + esc(e.category) + (e.receipt ? ' 🧾' : '') + '</span>' +
            '<span class="meta">' + fmtDateShort(e.date) + (e.jobSiteId ? ' · ' + esc(siteName(e.jobSiteId)) : '') +
            (e.note ? ' · ' + esc(e.note) : '') + '</span></span>' +
            '<span class="right"><span class="big">' + money(e.amount) + '</span></span></button>';
        }).join('') : '<div class="day-head">No expenses in this period</div>') +
      '</div>' +
    '</div>' +
    '<button class="btn ghost block" type="button" data-act="add-exp">+ Add expense</button>' +

    '<div class="section-title">Customer profitability</div>' +
    (perCustomer.length ?
      '<div class="card"><div class="table-wrap"><table class="data">' +
        '<caption class="visually-hidden">Customer profitability for ' + esc(range.label) + '</caption>' +
        '<thead><tr><th scope="col">Customer</th><th scope="col">Hrs</th><th scope="col">Billed</th>' +
        '<th scope="col">Cost</th><th scope="col">Profit</th><th scope="col">$/hr</th></tr></thead><tbody>' +
        perCustomer.map(function (r) {
          return '<tr><td>' + esc(r.c.name) + '</td><td>' + hrs(r.st.hours) + '</td><td>' + money0(r.st.billed) + '</td>' +
            '<td>' + money0(r.st.labor + r.st.expenses) + '</td><td>' + money0(r.st.profit) + '</td>' +
            '<td>' + (r.st.perHour == null ? '—' : money(r.st.perHour)) + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="inline-note">Effective $/hr is (billed − expenses) ÷ hours. Sorted best first.</div></div>'
      : '<div class="card"><div class="empty"><h3>Nothing billed yet</h3>' +
        '<p>Set a bill rate on a customer or job site, then work a shift there.</p></div></div>');

  delegate(host, 'click', '[data-act]', function (e, t) {
    var a = t.getAttribute('data-act');
    if (a === 'prev-period') { moneyPeriodOffset--; renderMoney(host); }
    if (a === 'next-period') { moneyPeriodOffset = Math.min(0, moneyPeriodOffset + 1); renderMoney(host); }
    if (a === 'this-period') { moneyPeriodOffset = 0; renderMoney(host); }
    // Read the range fresh: this handler is registered once and outlives renders.
    if (a === 'csv-time') exportTimesheetCSV(currentMoneyRange());
    if (a === 'csv-exp') exportExpensesCSV(currentMoneyRange());
    if (a === 'invoice') openInvoiceBuilder(currentMoneyRange());
    if (a === 'add-exp') openExpenseEditor(null);
  });
  delegate(host, 'click', '[data-emp]', function (e, t) {
    state.filterEmployeeId = t.getAttribute('data-emp');
    renderMoney(host);
  });
  delegate(host, 'click', '[data-exp]', function (e, t) {
    openExpenseEditor(byId(state.expenses, t.getAttribute('data-exp')));
  });
}

/* ---- expense editor ----------------------------------------------------- */
function openExpenseEditor(existing) {
  var d = existing ? Object.assign({}, existing) : newExpense({ date: Date.now(), category: 'Fuel' });
  function body() {
    return '<div class="field"><span class="lbl-txt">Category</span><div class="chips">' +
        EXPENSE_CATEGORIES.map(function (c) {
          return '<button class="chip" type="button" data-cat="' + esc(c) + '" aria-pressed="' + (d.category === c) + '">' + esc(c) + '</button>';
        }).join('') + '</div></div>' +
      field({ id: 'eAmt', label: 'Amount', type: 'number', value: d.amount || '',
              attrs: 'step="0.01" min="0" inputmode="decimal"', err: 'Enter an amount above 0' }) +
      field({ id: 'eDate', label: 'Date', type: 'date', value: isoLocalDate(d.date), err: 'Pick a date' }) +
      field({ id: 'eSite', label: 'Job site (optional)', type: 'select', value: d.jobSiteId || '', options: jobSiteOptions(d.jobSiteId) }) +
      field({ id: 'eNote', label: 'Note', value: d.note, attrs: 'autocomplete="off"' }) +
      '<div class="field"><span class="lbl-txt">Receipt</span>' +
        '<label class="btn ghost sm" for="eRcpt">' + (d.receipt ? 'Replace photo' : 'Add photo') +
        '<input id="eRcpt" type="file" accept="image/*" capture="environment" class="visually-hidden"></label>' +
        (d.receipt ? '<div class="thumbs"><div class="thumb"><img src="' + esc(d.receipt) + '" alt="Receipt">' +
          '<button class="x" type="button" data-rmrcpt aria-label="Remove receipt"><span aria-hidden="true">&times;</span></button></div></div>' : '') +
      '</div>' +
      (existing ? '<button class="btn danger block" type="button" data-del style="margin-top:12px">Delete expense</button>' : '');
  }
  openSheet({
    title: existing ? 'Edit expense' : 'Add expense',
    body: body(),
    foot: '<button class="btn ghost" type="button" data-sheet-close>Cancel</button>' +
          '<button class="btn primary" type="button" data-save>Save</button>',
    onMount: function (el, close) {
      function rerender() { $('.sheet-body', el).innerHTML = body(); wire(); }
      function wire() {
        $$('[data-cat]', el).forEach(function (b) {
          on(b, 'click', function () {
            d.category = b.getAttribute('data-cat');
            $$('[data-cat]', el).forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-cat') === d.category)); });
          });
        });
        var f = $('#eRcpt', el);
        if (f) on(f, 'change', function () {
          var file = f.files && f.files[0];
          if (!file) return;
          d.amount = num(val(el, 'eAmt'), d.amount); d.note = val(el, 'eNote');
          fileToDownscaledDataURL(file, 1280, 0.7).then(function (u) { d.receipt = u; rerender(); toast('Receipt attached'); })
            .catch(function () { toast('Could not read that image', 'err'); });
        });
        var rm = $('[data-rmrcpt]', el);
        if (rm) on(rm, 'click', function () { d.receipt = null; rerender(); });
        var del = $('[data-del]', el);
        if (del) on(del, 'click', function () {
          confirmSheet({ title: 'Delete expense?', message: money(existing.amount) + ' · ' + existing.category, okText: 'Delete', danger: true })
            .then(function (ok) {
              if (!ok) return;
              remove('expenses', 'expenses', existing.id).then(function () { close(); toast('Expense deleted'); renderRoute(); });
            });
        });
      }
      wire();
      on($('[data-save]', el), 'click', function () {
        clearErrors(el);
        var amt = num(val(el, 'eAmt'), 0);
        var dt = parseLocal(val(el, 'eDate'));
        var bad = false;
        if (!(amt > 0)) { fieldError(el, 'eAmt', 'Enter an amount above 0'); bad = true; }
        if (!dt) { fieldError(el, 'eDate', 'Pick a date'); bad = true; }
        if (bad) return;
        d.amount = amt; d.date = dt;
        d.jobSiteId = val(el, 'eSite') || null;
        d.note = val(el, 'eNote');
        upsert('expenses', 'expenses', newExpense(d)).then(function () { close(); toast('Expense saved'); renderRoute(); });
      });
    }
  });
}

/* ---- CSV exports (column order is the contract with the iOS sibling) ---- */
function exportTimesheetCSV(range) {
  var r = range || currentMoneyRange();
  var s = state.settings;
  var rows = [['shiftId', 'employeeId', 'employee', 'jobSiteId', 'jobSite', 'customer',
               'startISO', 'endISO', 'breakUnpaidMinutes', 'paidMinutes', 'roundedMinutes', 'hours',
               'hourlyRate', 'pay', 'miles', 'driveMinutes', 'source', 'approved', 'notes']];
  var list = shiftsInRange(r.start, r.end, state.filterEmployeeId)
    .slice().sort(function (a, b) { return a.start - b.start; });
  list.forEach(function (sh) {
    var emp = employee(sh.employeeId), js = site(sh.jobSiteId), c = js ? customer(js.customerId) : null;
    var raw = paidMinutes(sh, s), rd = roundMinutes(raw, s.rounding, s.roundingMode);
    var rate = emp ? num(emp.hourlyRate, 0) : 0;
    rows.push([sh.id, sh.employeeId || '', emp ? emp.name : '', sh.jobSiteId || '', js ? js.name : '',
      c ? c.name : '', new Date(sh.start).toISOString(), sh.end == null ? '' : new Date(sh.end).toISOString(),
      Math.round(breakMinutes(sh).unpaid), Math.round(raw), Math.round(rd), (rd / 60).toFixed(2),
      rate.toFixed(2), ((rd / 60) * rate).toFixed(2), num(sh.miles, 0), num(sh.driveMinutes, 0),
      sh.source, sh.approved ? 'yes' : 'no', sh.notes || '']);
  });
  if (list.length === 0) { toast('No shifts in this period', 'warn'); return; }
  downloadFile('punchline-timesheet-' + isoLocalDate(r.start) + '.csv', toCSV(rows), 'text/csv;charset=utf-8');
  toast(list.length + ' shifts exported');
}

function exportExpensesCSV(range) {
  var r = range || currentMoneyRange();
  var rows = [['expenseId', 'dateISO', 'category', 'amount', 'jobSiteId', 'jobSite', 'shiftId', 'note', 'hasReceipt']];
  var list = state.expenses.filter(function (e) { return e.date >= r.start && e.date <= r.end; })
    .sort(function (a, b) { return a.date - b.date; });
  list.forEach(function (e) {
    var js = site(e.jobSiteId);
    rows.push([e.id, new Date(e.date).toISOString(), e.category, num(e.amount, 0).toFixed(2),
      e.jobSiteId || '', js ? js.name : '', e.shiftId || '', e.note || '', e.receipt ? 'yes' : 'no']);
  });
  if (!list.length) { toast('No expenses in this period', 'warn'); return; }
  downloadFile('punchline-expenses-' + isoLocalDate(r.start) + '.csv', toCSV(rows), 'text/csv;charset=utf-8');
  toast(list.length + ' expenses exported');
}

/* ---- invoice builder ---------------------------------------------------- */
function openInvoiceBuilder(range) {
  var r = range || currentMoneyRange();
  var custs = state.customers.filter(function (c) { return !c.archived; });
  if (!custs.length) { toast('Add a customer first', 'warn'); return; }
  openSheet({
    title: 'Build invoice',
    body:
      field({ id: 'ivCust', label: 'Customer', type: 'select', value: custs[0].id,
              options: custs.map(function (c) { return { value: c.id, label: c.name }; }) }) +
      '<div class="two-up">' +
        field({ id: 'ivFrom', label: 'From', type: 'date', value: isoLocalDate(r.start) }) +
        field({ id: 'ivTo', label: 'To', type: 'date', value: isoLocalDate(r.end) }) +
      '</div>' +
      field({ id: 'ivBiz', label: 'Your business name', value: localStorage.getItem('punchline.biz') || '',
              attrs: 'autocomplete="organization"', hint: 'Shown at the top of the invoice. Saved for next time.' }) +
      field({ id: 'ivNum', label: 'Invoice number', value: 'INV-' + new Date().getFullYear() + '-' +
              String(state.shifts.length + 1).padStart(3, '0') }) +
      '<div class="switch-row"><span class="grow"><span class="ttl">Include expenses</span>' +
        '<span class="meta">Bill materials and dump fees back to the customer.</span></span>' +
        '<button class="switch" type="button" role="switch" aria-checked="false" data-incexp aria-label="Include expenses"></button></div>',
    foot: '<button class="btn ghost" type="button" data-sheet-close>Cancel</button>' +
          '<button class="btn primary" type="button" data-go>Preview &amp; print</button>',
    onMount: function (el, close) {
      var incExp = false;
      var sw = $('[data-incexp]', el);
      on(sw, 'click', function () { incExp = !incExp; sw.setAttribute('aria-checked', String(incExp)); });
      on($('[data-go]', el), 'click', function () {
        var cid = val(el, 'ivCust');
        var from = parseLocal(val(el, 'ivFrom'));
        var to = parseLocal(val(el, 'ivTo'));
        clearErrors(el);
        if (from == null || to == null || to < from) { fieldError(el, 'ivTo', 'End date must be on or after the start'); return; }
        to = endOfDay(to);
        var biz = val(el, 'ivBiz').trim();
        try { localStorage.setItem('punchline.biz', biz); } catch (e) {}
        var html = buildInvoiceHTML(cid, from, to, biz, val(el, 'ivNum'), incExp);
        if (!html) { toast('No billable work in that range', 'warn'); return; }
        close();
        presentInvoice(html);
      });
    }
  });
}

/**
 * buildInvoiceHTML — a self-contained printable document (its own @media print
 * rules, no external CSS) listing every shift as a line item.
 */
function buildInvoiceHTML(customerId, from, to, biz, invNum, includeExpenses) {
  var s = state.settings;
  var c = customer(customerId);
  if (!c) return null;
  var sites = state.jobSites.filter(function (x) { return x.customerId === customerId; });
  var siteIds = {}; sites.forEach(function (x) { siteIds[x.id] = 1; });
  var shifts = state.shifts.filter(function (x) {
    return x.end != null && siteIds[x.jobSiteId] && x.start >= from && x.start <= to;
  }).sort(function (a, b) { return a.start - b.start; });

  var expenses = includeExpenses ? state.expenses.filter(function (e) {
    return e.date >= from && e.date <= to && (siteIds[e.jobSiteId] ||
      shifts.some(function (sh) { return sh.id === e.shiftId; }));
  }) : [];

  if (!shifts.length && !expenses.length) return null;

  var lines = shifts.map(function (sh) {
    var js = site(sh.jobSiteId);
    var h = roundedPaidMinutes(sh, s) / 60;
    var rate = billRateFor(js);
    return { date: sh.start, desc: (js ? js.name : 'Work') + (sh.notes ? ' — ' + sh.notes : ''),
             qty: h, unit: rate, amount: h * rate };
  });
  var labor = sum(lines, function (l) { return l.amount; });
  var expTotal = sum(expenses, function (e) { return num(e.amount, 0); });
  var total = labor + expTotal;
  var totalHours = sum(lines, function (l) { return l.qty; });

  var css =
    'body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111;background:#fff;margin:0;padding:32px}' +
    '.wrap{max-width:760px;margin:0 auto}' +
    'h1{font-size:26px;margin:0 0 2px}h2{font-size:15px;margin:26px 0 8px;text-transform:uppercase;letter-spacing:.06em;color:#666}' +
    '.head{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;border-bottom:2px solid #111;padding-bottom:16px}' +
    '.muted{color:#666}' +
    'table{width:100%;border-collapse:collapse;margin-top:6px}' +
    'th,td{text-align:right;padding:8px 6px;border-bottom:1px solid #ddd;font-variant-numeric:tabular-nums}' +
    'th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#666;border-bottom:1px solid #111}' +
    'th:first-child,td:first-child{text-align:left}' +
    'tfoot td{border-bottom:0;font-weight:700}' +
    '.total{font-size:20px}' +
    '.note{margin-top:28px;color:#666;font-size:12px;border-top:1px solid #ddd;padding-top:12px}' +
    '.actions{margin:24px 0 0;text-align:center}' +
    'button{font:inherit;padding:12px 22px;border-radius:10px;border:1px solid #111;background:#111;color:#fff;cursor:pointer}' +
    '@media print{body{padding:0}.actions{display:none}.wrap{max-width:none}@page{margin:14mm}}';

  var rowsHTML = lines.map(function (l) {
    return '<tr><td>' + esc(fmtDateShort(l.date)) + ' — ' + esc(l.desc) + '</td>' +
      '<td>' + l.qty.toFixed(2) + '</td><td>' + money(l.unit) + '</td><td>' + money(l.amount) + '</td></tr>';
  }).join('') + expenses.map(function (e) {
    return '<tr><td>' + esc(fmtDateShort(e.date)) + ' — ' + esc(e.category) + (e.note ? ': ' + esc(e.note) : '') +
      '</td><td>1</td><td>' + money(e.amount) + '</td><td>' + money(e.amount) + '</td></tr>';
  }).join('');

  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Invoice ' + esc(invNum) + ' — ' + esc(c.name) + '</title><style>' + css + '</style></head><body><div class="wrap">' +
    '<div class="head"><div><h1>' + esc(biz || 'Invoice') + '</h1>' +
      '<div class="muted">Invoice ' + esc(invNum) + '</div>' +
      '<div class="muted">' + esc(fmtDate(from)) + ' – ' + esc(fmtDate(to)) + '</div></div>' +
      '<div style="text-align:right"><div class="muted">Bill to</div><strong>' + esc(c.name) + '</strong>' +
      (c.address ? '<div class="muted">' + esc(c.address) + '</div>' : '') +
      (c.contact ? '<div class="muted">' + esc(c.contact) + '</div>' : '') + '</div></div>' +
    '<h2>Work performed</h2>' +
    '<table><thead><tr><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>' +
    '<tbody>' + rowsHTML + '</tbody>' +
    '<tfoot>' +
      (expTotal ? '<tr><td colspan="3">Labor</td><td>' + money(labor) + '</td></tr>' +
                  '<tr><td colspan="3">Materials &amp; fees</td><td>' + money(expTotal) + '</td></tr>' : '') +
      '<tr class="total"><td colspan="3">Total due</td><td>' + money(total) + '</td></tr></tfoot></table>' +
    '<div class="note">' + totalHours.toFixed(2) + ' hours across ' + shifts.length + ' visit' + (shifts.length === 1 ? '' : 's') +
    '. Generated by Punchline on ' + esc(fmtDate(Date.now())) + '.</div>' +
    '<div class="actions"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>' +
    '</div></body></html>';
}

/**
 * presentInvoice — try a new window (best on desktop). If the popup is blocked
 * (common on iOS), fall back to an in-page overlay that prints on its own.
 */
function presentInvoice(html) {
  var w = null;
  try { w = window.open('', '_blank'); } catch (e) { w = null; }
  if (w && w.document) {
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(function () { try { w.focus(); } catch (e) {} }, 100);
    toast('Invoice opened — use Print → Save as PDF');
    return;
  }
  // Fallback: render into a full-screen iframe overlay we can print directly.
  var host = document.createElement('div');
  host.id = 'invoiceOverlay';
  host.innerHTML =
    '<div class="invoice-bar">' +
      '<button class="btn ghost sm" type="button" data-close>Close</button>' +
      '<button class="btn primary sm" type="button" data-print>Print / Save as PDF</button>' +
    '</div><iframe title="Invoice preview"></iframe>';
  document.body.appendChild(host);
  var frame = host.querySelector('iframe');
  frame.srcdoc = html;
  on(host.querySelector('[data-close]'), 'click', function () { host.remove(); });
  on(host.querySelector('[data-print]'), 'click', function () {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); }
    catch (e) { window.print(); }
  });
  toast('Popup blocked — showing the invoice here');
}

/* ==========================================================================
   11. VIEW: INSIGHTS — nudges, honest stats, hand-drawn SVG charts
   Every number here is computed from stored shifts. When there is not enough
   data to say something true, the card says so instead of guessing.
   ========================================================================== */

/** Days (local midnights) on which the given employee worked, newest first. */
function workedDays(empId) {
  var set = {};
  state.shifts.forEach(function (s) {
    if (empId && empId !== 'all' && s.employeeId !== empId) return;
    set[startOfDay(s.start)] = 1;
  });
  return Object.keys(set).map(Number).sort(function (a, b) { return b - a; });
}

/** Current streak (counting back from today or yesterday) and the longest ever. */
function streaks(empId) {
  var days = workedDays(empId);
  if (!days.length) return { current: 0, longest: 0 };
  var today = startOfDay(Date.now());
  var current = 0;
  if (days[0] === today || days[0] === addDays(today, -1)) {
    current = 1;
    for (var i = 1; i < days.length; i++) {
      if (dayDiff(days[i - 1], days[i]) === 1) current++;
      else break;
    }
  }
  var longest = 1, run = 1;
  for (var j = 1; j < days.length; j++) {
    if (dayDiff(days[j - 1], days[j]) === 1) { run++; longest = Math.max(longest, run); }
    else run = 1;
  }
  return { current: current, longest: Math.max(longest, current) };
}

/** Median clock-in time (minutes after midnight) over the last N days. */
function typicalStart(empId, days) {
  var since = addDays(startOfDay(Date.now()), -(days || 30));
  var firsts = {};
  state.shifts.forEach(function (s) {
    if (empId && empId !== 'all' && s.employeeId !== empId) return;
    if (s.start < since) return;
    var k = startOfDay(s.start);
    if (firsts[k] == null || s.start < firsts[k]) firsts[k] = s.start;
  });
  var mins = Object.keys(firsts).map(function (k) {
    var d = new Date(firsts[k]);
    return d.getHours() * 60 + d.getMinutes();
  });
  return { n: mins.length, median: median(mins), firsts: firsts };
}

function minutesToClock(m) {
  if (m == null) return '—';
  m = Math.round(m);
  var h = Math.floor(m / 60) % 24, mm = m % 60;
  var ap = h < 12 ? 'AM' : 'PM', hh = h % 12; if (hh === 0) hh = 12;
  return hh + ':' + String(mm).padStart(2, '0') + ' ' + ap;
}

/** Average hours worked per calendar day-of-week, across weeks that had work. */
function hoursByDayOfWeek(empId) {
  var s = state.settings;
  var totals = [0, 0, 0, 0, 0, 0, 0];
  var daysSeen = [{}, {}, {}, {}, {}, {}, {}];
  state.shifts.forEach(function (sh) {
    if (empId && empId !== 'all' && sh.employeeId !== empId) return;
    var d = new Date(sh.start).getDay();
    totals[d] += shiftHours(sh, s);
    daysSeen[d][startOfDay(sh.start)] = 1;
  });
  return totals.map(function (t, i) {
    var n = Object.keys(daysSeen[i]).length;
    return { label: DOW[i], value: n ? t / n : 0, days: n };
  });
}

/** Hours per work week for the last n weeks (oldest first). */
function lastNWeeks(empId, n) {
  var s = state.settings;
  var out = [];
  var cur = weekStart(Date.now(), s);
  for (var i = n - 1; i >= 0; i--) {
    var ws = addDays(cur, -7 * i), we = addDays(ws, 7) - 1;
    var h = sum(state.shifts.filter(function (sh) {
      return (!empId || empId === 'all' || sh.employeeId === empId) && sh.start >= ws && sh.start <= we;
    }), function (sh) { return shiftHours(sh, s); });
    out.push({ label: fmtDateShort(ws).replace(/\/\d\d$/, ''), value: h, start: ws, end: we });
  }
  return out;
}

/* ---- inline SVG charts (no library, accessible table fallback) ---------- */
function svgBars(data, opts) {
  opts = opts || {};
  var w = 320, h = opts.height || 130, padL = 6, padB = 20, padT = 14;
  var n = data.length || 1;
  var max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([opts.min || 1]));
  var bw = (w - padL * 2) / n;
  var bars = data.map(function (d, i) {
    var bh = max > 0 ? (h - padB - padT) * (d.value / max) : 0;
    var x = padL + i * bw + bw * 0.16;
    var y = h - padB - bh;
    var cls = 'barfill' + (d.dim ? ' dim' : '');
    return '<rect class="' + cls + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw * 0.68).toFixed(1) +
      '" height="' + Math.max(1, bh).toFixed(1) + '" rx="3"></rect>' +
      '<text class="lbl" x="' + (padL + i * bw + bw / 2).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle">' + esc(d.label) + '</text>' +
      (d.value > 0 ? '<text class="vlbl" x="' + (padL + i * bw + bw / 2).toFixed(1) + '" y="' + Math.max(10, y - 4).toFixed(1) +
        '" text-anchor="middle">' + esc(opts.fmt ? opts.fmt(d.value) : d.value.toFixed(1)) + '</text>' : '');
  }).join('');
  return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(opts.aria || 'Bar chart') + '">' +
    '<line class="grid" x1="' + padL + '" y1="' + (h - padB) + '" x2="' + (w - padL) + '" y2="' + (h - padB) + '"></line>' +
    bars + '</svg>' + hiddenTable(data, opts);
}

function svgLine(data, opts) {
  opts = opts || {};
  var w = 320, h = opts.height || 130, padL = 10, padR = 10, padB = 20, padT = 16;
  var max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([opts.min || 1]));
  var n = Math.max(1, data.length - 1);
  var step = (w - padL - padR) / n;
  var pts = data.map(function (d, i) {
    var x = padL + i * step;
    var y = h - padB - (max > 0 ? (h - padB - padT) * (d.value / max) : 0);
    return { x: x, y: y, d: d };
  });
  var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' ');
  return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(opts.aria || 'Line chart') + '">' +
    '<line class="grid" x1="' + padL + '" y1="' + (h - padB) + '" x2="' + (w - padR) + '" y2="' + (h - padB) + '"></line>' +
    '<path class="line" d="' + path + '"></path>' +
    pts.map(function (p, i) {
      return '<circle class="pt" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="3"></circle>' +
        (i % 2 === 0 || i === pts.length - 1
          ? '<text class="lbl" x="' + p.x.toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle">' + esc(p.d.label) + '</text>' : '') +
        (p.d.value > 0 ? '<text class="vlbl" x="' + p.x.toFixed(1) + '" y="' + Math.max(11, p.y - 7).toFixed(1) +
          '" text-anchor="middle">' + esc(opts.fmt ? opts.fmt(p.d.value) : p.d.value.toFixed(1)) + '</text>' : '');
    }).join('') + '</svg>' + hiddenTable(data, opts);
}

function hiddenTable(data, opts) {
  return '<table class="visually-hidden"><caption>' + esc(opts.aria || 'Chart data') + '</caption>' +
    '<thead><tr><th scope="col">' + esc(opts.keyLabel || 'Period') + '</th><th scope="col">' +
    esc(opts.valLabel || 'Hours') + '</th></tr></thead><tbody>' +
    data.map(function (d) {
      return '<tr><th scope="row">' + esc(d.label) + '</th><td>' + esc((opts.fmt ? opts.fmt(d.value) : d.value.toFixed(2))) + '</td></tr>';
    }).join('') + '</tbody></table>';
}

/* ---- nudges ------------------------------------------------------------- */
function buildNudges() {
  var s = state.settings, out = [];

  // 1. Forgot to clock out
  state.shifts.forEach(function (sh) {
    if (sh.end != null) return;
    var h = (Date.now() - sh.start) / MS_HOUR;
    if (h > num(s.maxShiftHours, 14)) {
      out.push({ kind: 'bad', title: 'Open punch running ' + hrs(h),
        meta: (employee(sh.employeeId) || {}).name + ' at ' + siteName(sh.jobSiteId) +
              ', started ' + fmtDay(sh.start) + ' ' + fmtTime(sh.start) + '.',
        action: 'Fix it', act: 'edit-shift:' + sh.id });
    }
  });

  // 2. Approaching overtime this week
  var otT = num(s.weeklyOTThreshold, 40);
  if (otT > 0) {
    state.employees.forEach(function (e) {
      var ws = weekStart(Date.now(), s), we = addDays(ws, 7) - 1;
      var h = sum(state.shifts.filter(function (x) { return x.employeeId === e.id && x.start >= ws && x.start <= we; }),
        function (x) { return shiftHours(x, s); });
      if (h >= otT) {
        out.push({ kind: 'warn', title: e.name + ' is in overtime',
          meta: hrs(h) + ' this week — anything more pays at ' + num(s.otMultiplier, 1.5) + '×.' });
      } else if (h >= otT * 0.85) {
        out.push({ kind: 'warn', title: e.name + ' is near overtime',
          meta: hrs(h) + ' of ' + hrs(otT) + '. ' + hrs(otT - h) + ' left this week.' });
      }
    });
  }

  // 3. Long stretch without a day off
  state.employees.forEach(function (e) {
    var st = streaks(e.id);
    if (st.current >= 6) {
      out.push({ kind: 'warn', title: e.name + ' has worked ' + st.current + ' days straight',
        meta: 'Longest stretch on record is ' + st.longest + ' days.' });
    }
  });

  // 4. Unapproved crew punches
  var unapproved = state.shifts.filter(function (sh) {
    var e = employee(sh.employeeId);
    return sh.end != null && !sh.approved && e && !e.isSelf;
  });
  if (unapproved.length) {
    out.push({ kind: 'info', title: unapproved.length + ' crew punch' + (unapproved.length === 1 ? '' : 'es') + ' need approval',
      meta: 'Totalling ' + hrs(sum(unapproved, function (x) { return shiftHours(x, s); })) + ' · ' +
            money(laborCost(unapproved, s)) + ' in labor.',
      action: 'Review', act: 'goto-shifts' });
  }

  // 5. Equipment service due
  state.equipment.forEach(function (eq) {
    var since = num(eq.hourMeter, 0) - num(eq.lastServiceHours, 0);
    if (num(eq.serviceIntervalHours, 0) > 0 && since >= num(eq.serviceIntervalHours, 0)) {
      out.push({ kind: 'bad', title: eq.name + ' is due for service',
        meta: since.toFixed(1) + ' h since the last service (interval ' + num(eq.serviceIntervalHours, 0) + ' h).',
        action: 'Log service', act: 'service:' + eq.id });
    }
  });

  return out;
}

function renderInsights(host) {
  var s = state.settings;
  var empId = state.filterEmployeeId;
  var mine = state.shifts.filter(function (x) { return empId === 'all' || x.employeeId === empId; });
  var nudges = buildNudges();

  if (!mine.length) {
    host.innerHTML = (nudges.length ? nudgesHTML(nudges) : '') +
      '<div class="card"><div class="empty"><div class="big">📈</div><h3>Not enough data yet</h3>' +
      '<p>Work a few shifts and this tab fills in: your typical start time, streaks, hours by weekday, and which customers actually pay.</p></div></div>';
    wireInsights(host);
    return;
  }

  // --- typical start -------------------------------------------------------
  var ts = typicalStart(empId, 30);
  var todayFirst = null;
  mine.forEach(function (x) {
    if (sameDay(x.start, Date.now()) && (todayFirst == null || x.start < todayFirst)) todayFirst = x.start;
  });
  var startCard;
  if (ts.n < 3) {
    startCard = '<div class="card"><h3>Typical start time</h3><p>Not enough data yet — ' + ts.n +
      ' of the last 30 days have punches. Three days gets you a median.</p></div>';
  } else {
    var todayMin = todayFirst == null ? null : new Date(todayFirst).getHours() * 60 + new Date(todayFirst).getMinutes();
    var delta = todayMin == null ? null : todayMin - ts.median;
    startCard = '<div class="card"><h3>Typical start time</h3>' +
      '<div class="stats" style="margin-top:8px">' +
        '<div class="stat"><div class="lbl">Median (30d)</div><div class="val sm">' + minutesToClock(ts.median) + '</div></div>' +
        '<div class="stat"><div class="lbl">Today</div><div class="val sm">' + (todayMin == null ? '—' : minutesToClock(todayMin)) + '</div></div>' +
      '</div>' +
      '<p style="margin-top:10px">' + (todayMin == null
        ? 'You have not punched in today.'
        : Math.abs(delta) < 8 ? 'Right on your usual time today.'
        : delta > 0 ? 'You started ' + hm(delta) + ' later than usual today.'
                    : 'You started ' + hm(-delta) + ' earlier than usual today.') +
      ' Based on ' + ts.n + ' days.</p></div>';
  }

  // --- streaks -------------------------------------------------------------
  var st = streaks(empId);
  var streakCard = '<div class="card"><h3>Days worked</h3><div class="stats" style="margin-top:8px">' +
    '<div class="stat"><div class="lbl">Current streak</div><div class="val">' + st.current + '</div></div>' +
    '<div class="stat"><div class="lbl">Longest</div><div class="val">' + st.longest + '</div></div>' +
    '<div class="stat"><div class="lbl">Days logged</div><div class="val">' + workedDays(empId).length + '</div></div>' +
    '</div>' + (st.current >= 6 ? '<p style="margin-top:10px">Six days straight or more. Worth a day off.</p>' : '') + '</div>';

  // --- charts --------------------------------------------------------------
  var dow = hoursByDayOfWeek(empId);
  var anyDow = dow.some(function (d) { return d.value > 0; });
  var dowCard = '<div class="card"><h3>Average hours by weekday</h3>' +
    (anyDow ? svgBars(dow, { aria: 'Average hours worked by day of week', keyLabel: 'Weekday',
                             fmt: function (v) { return v.toFixed(1); } })
            : '<p>Not enough data yet.</p>') +
    (anyDow ? '<div class="inline-note">Averaged only over days you actually worked.</div>' : '') + '</div>';

  var weeks = lastNWeeks(empId, 8);
  var anyWeeks = weeks.some(function (d) { return d.value > 0; });
  var weeksCard = '<div class="card"><h3>Last 8 weeks</h3>' +
    (anyWeeks ? svgLine(weeks, { aria: 'Hours worked per week, last eight weeks', keyLabel: 'Week of',
                                 fmt: function (v) { return v.toFixed(1); } })
              : '<p>Not enough data yet.</p>') + '</div>';

  // --- week over week ------------------------------------------------------
  var wow = '';
  var wsNow = weekStart(Date.now(), s);
  var elapsedMs = Date.now() - wsNow;
  var thisWeek = sum(mine.filter(function (x) { return x.start >= wsNow; }), function (x) { return shiftHours(x, s); });
  var lastWs = addDays(wsNow, -7);
  var lastSamePoint = sum(mine.filter(function (x) { return x.start >= lastWs && x.start < lastWs + elapsedMs; }),
    function (x) { return shiftHours(x, s); });
  var lastFull = sum(mine.filter(function (x) { return x.start >= lastWs && x.start < wsNow; }), function (x) { return shiftHours(x, s); });
  if (lastFull <= 0 && thisWeek <= 0) {
    wow = '<div class="card"><h3>Week over week</h3><p>Not enough data yet — no hours this week or last.</p></div>';
  } else {
    var diff = thisWeek - lastSamePoint;
    var sentence;
    if (lastSamePoint <= 0) sentence = 'Nothing logged by this point last week, so there is nothing to compare against yet.';
    else if (Math.abs(diff) < 0.25) sentence = 'You are running level with last week at this point.';
    else sentence = 'You are ' + hrs(Math.abs(diff)) + ' ' + (diff > 0 ? 'ahead of' : 'behind') +
      ' where you were at this point last week (' + hrs(lastSamePoint) + ').';
    wow = '<div class="card"><h3>Week over week</h3>' +
      '<div class="stats" style="margin-top:8px">' +
        '<div class="stat"><div class="lbl">This week</div><div class="val sm">' + hrs(thisWeek) + '</div></div>' +
        '<div class="stat"><div class="lbl">Last week</div><div class="val sm">' + hrs(lastFull) + '</div></div>' +
      '</div><p style="margin-top:10px">' + esc(sentence) + '</p></div>';
  }

  // --- best / worst customer ----------------------------------------------
  var ranked = state.customers.map(function (c) { return { c: c, st: customerStats(c.id) }; })
    .filter(function (r) { return r.st.hours >= 1 && r.st.perHour != null; })
    .sort(function (a, b) { return b.st.perHour - a.st.perHour; });
  var custCard;
  if (ranked.length < 2) {
    custCard = '<div class="card"><h3>Best and worst customers</h3>' +
      '<p>Not enough data yet — needs at least two customers with an hour of work and a bill rate set.</p></div>';
  } else {
    var best = ranked[0], worst = ranked[ranked.length - 1];
    custCard = '<div class="card"><h3>Best and worst by effective $/hr</h3>' +
      '<div class="kv"><span class="k">Best · ' + esc(best.c.name) + '</span><span class="v">' + money(best.st.perHour) + '/hr</span></div>' +
      '<div class="kv"><span class="k">Worst · ' + esc(worst.c.name) + '</span><span class="v">' + money(worst.st.perHour) + '/hr</span></div>' +
      '<p style="margin-top:10px">' + esc(best.c.name) + ' pays ' + money(best.st.perHour - worst.st.perHour) +
      ' more per hour worked than ' + esc(worst.c.name) + '. Same hour of your life.</p></div>';
  }

  host.innerHTML =
    (state.employees.length > 1 ?
      '<div class="chips" style="margin-bottom:12px">' +
        '<button class="chip" type="button" aria-pressed="' + (empId === 'all') + '" data-emp="all">Everyone</button>' +
        state.employees.map(function (e) {
          return '<button class="chip" type="button" aria-pressed="' + (empId === e.id) + '" data-emp="' + esc(e.id) + '">' + esc(e.name) + '</button>';
        }).join('') + '</div>' : '') +
    (nudges.length ? nudgesHTML(nudges) : '<div class="nudge good"><div class="grow">' +
      '<div class="ttl">Nothing needs your attention</div>' +
      '<div class="meta">No open punches, no overtime creeping up, nothing overdue.</div></div></div>') +
    startCard + streakCard + dowCard + weeksCard + wow + custCard;

  wireInsights(host);
}

function nudgesHTML(nudges) {
  return nudges.map(function (n) {
    return '<div class="nudge ' + n.kind + '"><div class="grow">' +
      '<div class="ttl">' + esc(n.title) + '</div>' +
      '<div class="meta">' + esc(n.meta) + '</div>' +
      (n.action ? '<button class="btn sm" type="button" data-nudge="' + esc(n.act) + '">' + esc(n.action) + '</button>' : '') +
      '</div></div>';
  }).join('');
}

function wireInsights(host) {
  delegate(host, 'click', '[data-emp]', function (e, t) {
    state.filterEmployeeId = t.getAttribute('data-emp');
    renderInsights(host);
  });
  delegate(host, 'click', '[data-nudge]', function (e, t) {
    var a = t.getAttribute('data-nudge');
    if (a === 'goto-shifts') { state.filterEmployeeId = 'all'; go('shifts'); }
    else if (a.indexOf('edit-shift:') === 0) {
      var sh = byId(state.shifts, a.slice(11));
      if (sh) openShiftEditor(sh);
    } else if (a.indexOf('service:') === 0) {
      var eq = byId(state.equipment, a.slice(8));
      if (eq) openEquipmentEditor(eq);
    }
  });
}

/* ==========================================================================
   12. VIEW: SETTINGS — rules, crew, equipment, backup/restore
   ========================================================================== */

var APP_VERSION = '1.0.0';

function renderSettings(host) {
  var s = state.settings;

  host.innerHTML =
    '<div class="section-title">Pay period</div>' +
    '<div class="card">' +
      field({ id: 'setPeriod', label: 'Length', type: 'select', value: s.payPeriod, options: [
        { value: 'weekly', label: 'Weekly' }, { value: 'biweekly', label: 'Every two weeks' },
        { value: 'semimonthly', label: 'Twice a month (1–15, 16–end)' }, { value: 'monthly', label: 'Monthly' }] }) +
      field({ id: 'setAnchor', label: 'Period starts on', type: 'date', value: isoLocalDate(s.periodAnchor),
              hint: 'Also sets which weekday your work week starts on — used for overtime.' }) +
      '<div class="inline-note">Current period: <strong>' + esc(payPeriodRange(Date.now(), s).label) + '</strong></div>' +
    '</div>' +

    '<div class="section-title">Overtime rules</div>' +
    '<div class="card">' +
      '<div class="two-up">' +
        field({ id: 'setWeeklyOT', label: 'Weekly OT after (hrs)', type: 'number', value: s.weeklyOTThreshold,
                attrs: 'step="0.5" min="0" inputmode="decimal"' }) +
        field({ id: 'setOTMult', label: 'OT multiplier', type: 'number', value: s.otMultiplier,
                attrs: 'step="0.05" min="1" inputmode="decimal"' }) +
      '</div>' +
      '<div class="two-up">' +
        field({ id: 'setDailyOT', label: 'Daily OT after (hrs)', type: 'number', value: s.dailyOTThreshold,
                attrs: 'step="0.5" min="0" inputmode="decimal"', hint: '0 turns daily OT off' }) +
        field({ id: 'setDT', label: 'Double time after (hrs/day)', type: 'number', value: s.dtThreshold,
                attrs: 'step="0.5" min="0" inputmode="decimal"', hint: '0 turns it off' }) +
      '</div>' +
      field({ id: 'setDTMult', label: 'Double-time multiplier', type: 'number', value: s.dtMultiplier,
              attrs: 'step="0.05" min="1" inputmode="decimal"' }) +
      '<div class="inline-note">Daily rules apply first. Weekly overtime then applies only to hours still counted as regular, so no hour is paid twice.</div>' +
    '</div>' +

    '<div class="section-title">Rounding &amp; breaks</div>' +
    '<div class="card">' +
      '<div class="two-up">' +
        field({ id: 'setRounding', label: 'Round to', type: 'select', value: s.rounding, options: [
          { value: 'none', label: 'No rounding' }, { value: '5', label: '5 minutes' }, { value: '6', label: '6 minutes (0.1 h)' },
          { value: '10', label: '10 minutes' }, { value: '15', label: '15 minutes' }] }) +
        field({ id: 'setRoundMode', label: 'Direction', type: 'select', value: s.roundingMode, options: [
          { value: 'nearest', label: 'Nearest' }, { value: 'up', label: 'Always up' }, { value: 'down', label: 'Always down' }] }) +
      '</div>' +
      '<div class="two-up">' +
        field({ id: 'setAutoBreakMin', label: 'Auto break (min)', type: 'number', value: s.autoBreakMinutes,
                attrs: 'step="5" min="0" inputmode="numeric"' }) +
        field({ id: 'setAutoBreakAfter', label: 'After (hrs)', type: 'number', value: s.autoBreakAfterHours,
                attrs: 'step="0.5" min="0" inputmode="decimal"' }) +
      '</div>' +
      '<div class="inline-note">The auto break is only deducted when no break was logged by hand on that shift.</div>' +
    '</div>' +

    '<div class="section-title">Money</div>' +
    '<div class="card">' +
      '<div class="two-up">' +
        field({ id: 'setMileage', label: 'Mileage rate ($/mi)', type: 'number', value: s.mileageRate,
                attrs: 'step="0.01" min="0" inputmode="decimal"' }) +
        field({ id: 'setCurrency', label: 'Currency', type: 'select', value: s.currency, options: [
          { value: 'USD', label: 'USD $' }, { value: 'CAD', label: 'CAD $' }, { value: 'EUR', label: 'EUR €' },
          { value: 'GBP', label: 'GBP £' }, { value: 'AUD', label: 'AUD $' }] }) +
      '</div>' +
      field({ id: 'setMaxShift', label: 'Warn on shifts over (hrs)', type: 'number', value: s.maxShiftHours,
              attrs: 'step="1" min="1" inputmode="numeric"' }) +
    '</div>' +

    '<div class="section-title">Location</div>' +
    '<div class="card">' +
      '<div class="switch-row"><span class="grow"><span class="ttl">Geofenced punches</span>' +
        '<span class="meta">Watch your position while Punchline is open.</span></span>' +
        '<button class="switch" type="button" role="switch" aria-checked="' + (!!s.geoEnabled) + '" data-geo aria-label="Geofenced punches"></button></div>' +
      field({ id: 'setGeoMode', label: 'When you cross a job-site boundary', type: 'select', value: s.geoMode, options: [
        { value: 'ask', label: 'Ask me first' }, { value: 'auto', label: 'Punch automatically' }] }) +
      '<div class="inline-note"><strong>The web cannot geofence in the background.</strong> Browsers stop location updates as soon as ' +
      'the tab is closed or backgrounded, so this only works while Punchline is open and on screen. ' +
      'The native iOS build of Punchline handles true background geofencing; this PWA does not pretend to.</div>' +
      (state.geo.last ? '<div class="inline-note">Last fix: ' + state.geo.last.lat.toFixed(4) + ', ' +
        state.geo.last.lng.toFixed(4) + ' · ' + (state.geo.insideId ? 'inside ' + esc(siteName(state.geo.insideId)) : 'outside every job site') + '</div>' : '') +
    '</div>' +

    '<div class="section-title">Crew</div>' +
    '<div class="card tight"><div class="rows">' +
      state.employees.map(function (e) {
        return '<button class="row" type="button" data-emp-edit="' + esc(e.id) + '">' +
          '<span class="dot lg" style="background:' + esc(e.colorHex) + '"></span>' +
          '<span class="grow"><span class="ttl">' + esc(e.name) + (e.isSelf ? ' · you' : '') + (e.active ? '' : ' · inactive') + '</span>' +
          '<span class="meta">' + money(e.hourlyRate) + '/hr' + (e.phone ? ' · ' + esc(e.phone) : '') + '</span></span>' +
          '<svg class="chev" aria-hidden="true" width="16" height="16"><use href="#i-chev"></use></svg></button>';
      }).join('') +
    '</div></div>' +
    '<button class="btn ghost block" type="button" data-act="add-emp">+ Add crew member</button>' +

    '<div class="section-title">Equipment</div>' +
    '<div class="card tight"><div class="rows">' +
      (state.equipment.length ? state.equipment.map(function (eq) {
        var since = num(eq.hourMeter, 0) - num(eq.lastServiceHours, 0);
        var due = num(eq.serviceIntervalHours, 0) > 0 && since >= num(eq.serviceIntervalHours, 0);
        return '<button class="row" type="button" data-eq-edit="' + esc(eq.id) + '">' +
          '<span class="dot" style="background:' + (due ? 'var(--danger)' : 'var(--accent)') + '"></span>' +
          '<span class="grow"><span class="ttl">' + esc(eq.name) + '</span>' +
          '<span class="meta">' + esc(eq.type) + ' · ' + num(eq.hourMeter, 0).toFixed(1) + ' h on the meter · ' +
          since.toFixed(1) + '/' + num(eq.serviceIntervalHours, 0) + ' h since service</span></span>' +
          (due ? '<span class="badge bad">Service due</span>' : '') + '</button>';
      }).join('') : '<div class="day-head">No equipment tracked</div>') +
    '</div></div>' +
    '<button class="btn ghost block" type="button" data-act="add-eq">+ Add equipment</button>' +

    '<div class="section-title">Data</div>' +
    '<div class="card">' +
      '<div class="btn-row">' +
        '<button class="btn ghost" type="button" data-act="backup">Download backup</button>' +
        '<label class="btn ghost" for="restoreFile" style="flex:1 1 140px">Restore backup' +
          '<input id="restoreFile" type="file" accept="application/json,.json" class="visually-hidden"></label>' +
      '</div>' +
      '<div class="btn-row" style="margin-top:10px">' +
        '<label class="btn ghost" for="csvFile" style="flex:1">Import timesheet CSV' +
          '<input id="csvFile" type="file" accept=".csv,text/csv" class="visually-hidden"></label>' +
      '</div>' +
      '<div class="inline-note">Backup is a single JSON file holding every record, including photos. Restore replaces everything.</div>' +
      '<button class="btn danger block" type="button" data-act="reset" style="margin-top:14px">Reset all data</button>' +
    '</div>' +

    '<div class="section-title">About</div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Version</span><span class="v">' + APP_VERSION + '</span></div>' +
      '<div class="kv"><span class="k">Records</span><span class="v">' + state.shifts.length + ' shifts · ' +
        state.jobSites.length + ' sites · ' + state.expenses.length + ' expenses</span></div>' +
      '<div class="kv"><span class="k">Offline</span><span class="v">' +
        ('serviceWorker' in navigator ? 'Cached and ready' : 'Not supported here') + '</span></div>' +
      '<div class="inline-note">Everything lives on this device. Nothing is uploaded anywhere — there is no server. ' +
      'Back up regularly, and before clearing Safari data.</div>' +
      (deferredInstall ? '<button class="btn primary block" type="button" data-act="install" style="margin-top:12px">Install Punchline</button>' : '') +
    '</div>';

  wireSettings(host);
}

function wireSettings(host) {
  var s = state.settings;

  function bind(id, key, parse) {
    var el = $('#' + id, host);
    if (!el) return;
    on(el, 'change', function () {
      s[key] = parse ? parse(el.value) : el.value;
      _cur = null; // currency may have changed
      saveSettings().then(function () { toast('Saved'); renderSettings(host); });
    });
  }
  bind('setPeriod', 'payPeriod');
  bind('setAnchor', 'periodAnchor', function (v) { return parseLocal(v) || s.periodAnchor; });
  bind('setWeeklyOT', 'weeklyOTThreshold', function (v) { return Math.max(0, num(v, 40)); });
  bind('setOTMult', 'otMultiplier', function (v) { return Math.max(1, num(v, 1.5)); });
  bind('setDailyOT', 'dailyOTThreshold', function (v) { return Math.max(0, num(v, 0)); });
  bind('setDT', 'dtThreshold', function (v) { return Math.max(0, num(v, 0)); });
  bind('setDTMult', 'dtMultiplier', function (v) { return Math.max(1, num(v, 2)); });
  bind('setRounding', 'rounding');
  bind('setRoundMode', 'roundingMode');
  bind('setAutoBreakMin', 'autoBreakMinutes', function (v) { return Math.max(0, num(v, 0)); });
  bind('setAutoBreakAfter', 'autoBreakAfterHours', function (v) { return Math.max(0, num(v, 0)); });
  bind('setMileage', 'mileageRate', function (v) { return Math.max(0, num(v, 0.7)); });
  bind('setCurrency', 'currency');
  bind('setMaxShift', 'maxShiftHours', function (v) { return clamp(num(v, 14), 1, 48); });
  bind('setGeoMode', 'geoMode');

  var geo = $('[data-geo]', host);
  on(geo, 'click', function () {
    var next = !s.geoEnabled;
    if (next) {
      enableGeo().then(function (ok) {
        s.geoEnabled = ok;
        saveSettings().then(function () { renderSettings(host); });
      });
    } else {
      s.geoEnabled = false;
      stopGeo();
      saveSettings().then(function () { renderSettings(host); toast('Geofencing off'); });
    }
  });

  delegate(host, 'click', '[data-emp-edit]', function (e, t) {
    openEmployeeEditor(byId(state.employees, t.getAttribute('data-emp-edit')));
  });
  delegate(host, 'click', '[data-eq-edit]', function (e, t) {
    openEquipmentEditor(byId(state.equipment, t.getAttribute('data-eq-edit')));
  });
  delegate(host, 'click', '[data-act]', function (e, t) {
    var a = t.getAttribute('data-act');
    if (a === 'add-emp') openEmployeeEditor(null);
    if (a === 'add-eq') openEquipmentEditor(null);
    if (a === 'backup') downloadBackup();
    if (a === 'reset') resetAllData();
    if (a === 'install') promptInstall();
  });

  var rf = $('#restoreFile', host);
  if (rf) on(rf, 'change', function () {
    var f = rf.files && rf.files[0];
    rf.value = '';
    if (f) restoreBackup(f);
  });
  var cf = $('#csvFile', host);
  if (cf) on(cf, 'change', function () {
    var f = cf.files && cf.files[0];
    cf.value = '';
    if (f) importTimesheetCSV(f);
  });
}

/* ---- crew editor -------------------------------------------------------- */
function openEmployeeEditor(existing) {
  var d = existing ? Object.assign({}, existing) : newEmployee({ name: '', colorHex: PALETTE[state.employees.length % PALETTE.length] });
  openSheet({
    title: existing ? 'Edit ' + existing.name : 'Add crew member',
    body:
      field({ id: 'empName', label: 'Name', value: d.name, attrs: 'autocomplete="name"', err: 'Name is required' }) +
      field({ id: 'empRate', label: 'Hourly rate ($/hr)', type: 'number', value: d.hourlyRate,
              attrs: 'step="0.01" min="0" inputmode="decimal"', hint: 'What this hour costs you. For yourself, use what you pay yourself.' }) +
      field({ id: 'empPhone', label: 'Phone', type: 'tel', value: d.phone, attrs: 'autocomplete="tel"' }) +
      '<div class="field"><span class="lbl-txt">Colour</span><div class="chips">' +
        PALETTE.map(function (c) {
          return '<button class="chip" type="button" data-color="' + c + '" aria-pressed="' + (d.colorHex === c) + '" aria-label="Colour ' + c + '">' +
            '<span class="dot" style="background:' + c + '"></span></button>';
        }).join('') + '</div></div>' +
      '<div class="switch-row"><span class="grow"><span class="ttl">This is me</span>' +
        '<span class="meta">The Clock tab punches for whoever is marked as you.</span></span>' +
        '<button class="switch" type="button" role="switch" aria-checked="' + (!!d.isSelf) + '" data-self aria-label="This is me"></button></div>' +
      '<div class="switch-row"><span class="grow"><span class="ttl">Active</span>' +
        '<span class="meta">Inactive people stay in history but drop out of pickers.</span></span>' +
        '<button class="switch" type="button" role="switch" aria-checked="' + (d.active !== false) + '" data-active aria-label="Active"></button></div>' +
      (existing && !existing.isSelf ? '<button class="btn danger block" type="button" data-del style="margin-top:16px">Delete crew member</button>' : ''),
    foot: '<button class="btn ghost" type="button" data-sheet-close>Cancel</button>' +
          '<button class="btn primary" type="button" data-save>Save</button>',
    onMount: function (el, close) {
      $$('[data-color]', el).forEach(function (b) {
        on(b, 'click', function () {
          d.colorHex = b.getAttribute('data-color');
          $$('[data-color]', el).forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-color') === d.colorHex)); });
        });
      });
      var sf = $('[data-self]', el);
      on(sf, 'click', function () { d.isSelf = !d.isSelf; sf.setAttribute('aria-checked', String(d.isSelf)); });
      var ac = $('[data-active]', el);
      on(ac, 'click', function () { d.active = !d.active; ac.setAttribute('aria-checked', String(d.active)); });
      var del = $('[data-del]', el);
      if (del) on(del, 'click', function () {
        var n = state.shifts.filter(function (x) { return x.employeeId === existing.id; }).length;
        confirmSheet({
          title: 'Delete ' + existing.name + '?',
          message: n ? 'They have ' + n + ' shift(s). Those shifts are deleted too. This cannot be undone.'
                     : 'This cannot be undone.',
          okText: 'Delete', danger: true
        }).then(function (ok) {
          if (!ok) return;
          var theirs = state.shifts.filter(function (x) { return x.employeeId === existing.id; });
          Promise.all(theirs.map(function (x) { return remove('shifts', 'shifts', x.id); }))
            .then(function () { return remove('employees', 'employees', existing.id); })
            .then(function () { close(); toast('Crew member deleted'); renderRoute(); });
        });
      });
      on($('[data-save]', el), 'click', function () {
        clearErrors(el);
        if (!val(el, 'empName').trim()) { fieldError(el, 'empName', 'Name is required'); return; }
        d.name = val(el, 'empName').trim();
        d.hourlyRate = num(val(el, 'empRate'), 0);
        d.phone = val(el, 'empPhone').trim();
        var rec = newEmployee(d);
        var others = d.isSelf ? state.employees.filter(function (e) { return e.id !== rec.id && e.isSelf; }) : [];
        Promise.all(others.map(function (e) { e.isSelf = false; return idb.put('employees', e); }))
          .then(function () { return upsert('employees', 'employees', rec); })
          .then(function () { close(); toast('Saved'); renderRoute(); });
      });
    }
  });
}

/* ---- equipment editor --------------------------------------------------- */
function openEquipmentEditor(existing) {
  var d = existing ? Object.assign({}, existing) : newEquipment({});
  var since = num(d.hourMeter, 0) - num(d.lastServiceHours, 0);
  openSheet({
    title: existing ? 'Edit ' + existing.name : 'Add equipment',
    body:
      field({ id: 'eqName', label: 'Name', value: d.name, attrs: 'autocomplete="off"', err: 'Name is required' }) +
      field({ id: 'eqType', label: 'Type', type: 'select', value: d.type, options:
        ['Mower', 'Zero-turn', 'Trimmer', 'Blower', 'Edger', 'Truck', 'Trailer', 'Other'].map(function (t) { return { value: t, label: t }; }) }) +
      '<div class="two-up">' +
        field({ id: 'eqMeter', label: 'Hour meter', type: 'number', value: d.hourMeter, attrs: 'step="0.1" min="0" inputmode="decimal"' }) +
        field({ id: 'eqInterval', label: 'Service every (hrs)', type: 'number', value: d.serviceIntervalHours, attrs: 'step="5" min="0" inputmode="numeric"' }) +
      '</div>' +
      field({ id: 'eqLast', label: 'Meter at last service', type: 'number', value: d.lastServiceHours, attrs: 'step="0.1" min="0" inputmode="decimal"' }) +
      (existing ? '<div class="card"><div class="kv"><span class="k">Hours since service</span><span class="v">' + since.toFixed(1) + '</span></div>' +
        '<button class="btn sm block" type="button" data-service style="margin-top:10px">Mark serviced now</button></div>' : '') +
      field({ id: 'eqNotes', label: 'Notes', type: 'textarea', value: d.notes, rows: 2 }) +
      (existing ? '<button class="btn danger block" type="button" data-del style="margin-top:16px">Delete equipment</button>' : ''),
    foot: '<button class="btn ghost" type="button" data-sheet-close>Cancel</button>' +
          '<button class="btn primary" type="button" data-save>Save</button>',
    onMount: function (el, close) {
      var sv = $('[data-service]', el);
      if (sv) on(sv, 'click', function () {
        var meter = num(val(el, 'eqMeter'), d.hourMeter);
        $('#eqLast', el).value = meter;
        toast('Set last service to ' + meter.toFixed(1) + ' h — save to keep it');
      });
      var del = $('[data-del]', el);
      if (del) on(del, 'click', function () {
        confirmSheet({ title: 'Delete ' + existing.name + '?', message: 'This cannot be undone.', okText: 'Delete', danger: true })
          .then(function (ok) {
            if (!ok) return;
            remove('equipment', 'equipment', existing.id).then(function () { close(); toast('Deleted'); renderRoute(); });
          });
      });
      on($('[data-save]', el), 'click', function () {
        clearErrors(el);
        if (!val(el, 'eqName').trim()) { fieldError(el, 'eqName', 'Name is required'); return; }
        d.name = val(el, 'eqName').trim();
        d.type = val(el, 'eqType');
        d.hourMeter = num(val(el, 'eqMeter'), 0);
        d.serviceIntervalHours = num(val(el, 'eqInterval'), 0);
        d.lastServiceHours = num(val(el, 'eqLast'), 0);
        d.notes = val(el, 'eqNotes');
        upsert('equipment', 'equipment', newEquipment(d)).then(function () { close(); toast('Saved'); renderRoute(); });
      });
    }
  });
}

/* ---- backup / restore / reset ------------------------------------------- */
function downloadBackup() {
  var payload = {
    app: 'punchline', version: APP_VERSION, schema: 1, exportedAt: new Date().toISOString(),
    settings: state.settings,
    customers: state.customers, jobSites: state.jobSites, employees: state.employees,
    shifts: state.shifts, expenses: state.expenses, equipment: state.equipment,
    equipUsage: state.equipUsage, mileage: state.mileage
  };
  downloadFile('punchline-backup-' + isoLocalDate(Date.now()) + '.json',
    JSON.stringify(payload, null, 2), 'application/json');
  toast('Backup downloaded');
}

function restoreBackup(file) {
  var fr = new FileReader();
  fr.onerror = function () { toast('Could not read that file', 'err'); };
  fr.onload = function () {
    var data;
    try { data = JSON.parse(fr.result); }
    catch (e) { toast('That is not a valid Punchline backup', 'err'); return; }
    if (!data || data.app !== 'punchline' || !Array.isArray(data.shifts)) {
      toast('That JSON is not a Punchline backup', 'err'); return;
    }
    confirmSheet({
      title: 'Restore backup?',
      message: 'Everything currently on this device is replaced by the backup from ' +
        (data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'an unknown date') + '.',
      detail: '<div class="kv"><span class="k">Shifts</span><span class="v">' + (data.shifts || []).length + '</span></div>' +
              '<div class="kv"><span class="k">Job sites</span><span class="v">' + (data.jobSites || []).length + '</span></div>' +
              '<div class="kv"><span class="k">Expenses</span><span class="v">' + (data.expenses || []).length + '</span></div>',
      okText: 'Replace everything', danger: true
    }).then(function (ok) {
      if (!ok) return;
      idb.clearAll().then(function () {
        var jobs = [];
        [['customers', data.customers], ['jobSites', data.jobSites], ['employees', data.employees],
         ['shifts', data.shifts], ['expenses', data.expenses], ['equipment', data.equipment],
         ['equipUsage', data.equipUsage], ['mileage', data.mileage]].forEach(function (pair) {
          if (Array.isArray(pair[1]) && pair[1].length) jobs.push(idb.putAll(pair[0], pair[1]));
        });
        if (data.settings) jobs.push(idb.put('meta', { key: 'settings', value: Object.assign({}, DEFAULT_SETTINGS, data.settings) }));
        return Promise.all(jobs);
      }).then(function () {
        setActivePunch(null);
        return loadAll();
      }).then(function () {
        _cur = null;
        state.filterEmployeeId = 'all';
        toast('Backup restored');
        renderRoute();
      }).catch(function (e) {
        toast('Restore failed: ' + e.message, 'err', 5000);
      });
    });
  };
  fr.readAsText(file);
}

/**
 * importTimesheetCSV — accepts the CSV this app exports (and anything with the
 * same headers from the iOS sibling). Rows are matched to existing employees /
 * job sites by id first, then by name; unknown names are created.
 */
function importTimesheetCSV(file) {
  var fr = new FileReader();
  fr.onerror = function () { toast('Could not read that file', 'err'); };
  fr.onload = function () {
    var rows = parseCSV(fr.result);
    if (rows.length < 2) { toast('That CSV has no rows', 'err'); return; }
    var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    function col(name) { return head.indexOf(name.toLowerCase()); }
    var iStart = col('startISO'), iEnd = col('endISO');
    if (iStart < 0) { toast('CSV needs a startISO column', 'err', 4000); return; }
    var iEmpId = col('employeeId'), iEmp = col('employee'), iSiteId = col('jobSiteId'),
        iSite = col('jobSite'), iNotes = col('notes'), iMiles = col('miles'),
        iDrive = col('driveMinutes'), iSrc = col('source'), iAppr = col('approved'), iId = col('shiftId');

    var body = rows.slice(1);
    var made = [], skipped = 0;
    var pendingEmps = [], pendingSites = [];

    body.forEach(function (r) {
      var st = Date.parse(r[iStart]);
      if (!isFinite(st)) { skipped++; return; }
      var en = iEnd >= 0 && r[iEnd] ? Date.parse(r[iEnd]) : null;
      if (en != null && !isFinite(en)) en = null;

      var empId = iEmpId >= 0 && r[iEmpId] && byId(state.employees, r[iEmpId]) ? r[iEmpId] : null;
      if (!empId && iEmp >= 0 && r[iEmp]) {
        var found = state.employees.filter(function (e) { return e.name.toLowerCase() === r[iEmp].trim().toLowerCase(); })[0];
        if (!found) {
          found = newEmployee({ name: r[iEmp].trim(), colorHex: PALETTE[state.employees.length % PALETTE.length] });
          state.employees.push(found); pendingEmps.push(found);
        }
        empId = found.id;
      }
      if (!empId) empId = selfEmployee().id;

      var siteId = iSiteId >= 0 && r[iSiteId] && byId(state.jobSites, r[iSiteId]) ? r[iSiteId] : null;
      if (!siteId && iSite >= 0 && r[iSite]) {
        var fs = state.jobSites.filter(function (x) { return x.name.toLowerCase() === r[iSite].trim().toLowerCase(); })[0];
        if (!fs) {
          fs = newJobSite({ name: r[iSite].trim() });
          state.jobSites.push(fs); pendingSites.push(fs);
        }
        siteId = fs.id;
      }

      var rec = newShift({
        id: iId >= 0 && r[iId] ? r[iId] : undefined,
        employeeId: empId, jobSiteId: siteId, start: st, end: en,
        notes: iNotes >= 0 ? r[iNotes] : '', miles: iMiles >= 0 ? num(r[iMiles], 0) : 0,
        driveMinutes: iDrive >= 0 ? num(r[iDrive], 0) : 0,
        source: iSrc >= 0 && r[iSrc] ? r[iSrc] : 'manual',
        approved: iAppr >= 0 ? /^(yes|true|1)$/i.test(r[iAppr] || '') : true
      });
      made.push(rec);
    });

    if (!made.length) { toast('No usable rows in that CSV', 'err'); return; }
    confirmSheet({
      title: 'Import ' + made.length + ' shifts?',
      message: 'They are added to what you already have.' + (skipped ? ' ' + skipped + ' row(s) had no readable start time and are skipped.' : ''),
      okText: 'Import'
    }).then(function (ok) {
      if (!ok) {
        pendingEmps.forEach(function (e) { state.employees.splice(state.employees.indexOf(e), 1); });
        pendingSites.forEach(function (s) { state.jobSites.splice(state.jobSites.indexOf(s), 1); });
        return;
      }
      Promise.all([
        pendingEmps.length ? idb.putAll('employees', pendingEmps) : null,
        pendingSites.length ? idb.putAll('jobSites', pendingSites) : null,
        idb.putAll('shifts', made)
      ]).then(function () {
        made.forEach(function (m) {
          var ex = byId(state.shifts, m.id);
          if (ex) state.shifts[state.shifts.indexOf(ex)] = m; else state.shifts.push(m);
        });
        state.shifts.sort(function (a, b) { return b.start - a.start; });
        toast(made.length + ' shifts imported');
        renderRoute();
      });
    });
  };
  fr.readAsText(file);
}

function resetAllData() {
  confirmSheet({
    title: 'Reset all data?',
    message: 'Every shift, customer, job site, expense and setting on this device is erased. There is no undo and no cloud copy. ' +
             'Download a backup first if you might want it back.',
    typed: 'ERASE', okText: 'Erase everything', danger: true
  }).then(function (ok) {
    if (!ok) return;
    stopGeo();
    setActivePunch(null);
    try { localStorage.removeItem(LS_ONBOARD); } catch (e) {}
    idb.clearAll().then(function () { return loadAll(); }).then(function () {
      _cur = null;
      state.filterEmployeeId = 'all';
      moneyPeriodOffset = 0;
      shiftsPeriodLimit = 6;
      clockDraft = { notes: '', photos: [], jobSiteId: null };
      toast('All data erased');
      go('clock');
      renderRoute();
    });
  });
}

/* ==========================================================================
   4b. GEOFENCE RUNTIME  (declared here so the views above can call it)
   Web geolocation only runs while the page is open and visible. There is no
   background geofencing on the web — the UI says so plainly rather than
   pretending otherwise.
   ========================================================================== */

function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body: body, icon: './icon-192.png', badge: './icon-192.png', tag: 'punchline-geo' });
    }
  } catch (e) { /* Safari throws on constructor in some contexts — toast still shows */ }
}

function enableGeo() {
  return new Promise(function (resolve) {
    if (!navigator.geolocation) { toast('This browser has no geolocation', 'err'); resolve(false); return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      onPosition(pos);
      startGeo();
      if ('Notification' in window && Notification.permission === 'default') {
        try { Notification.requestPermission(); } catch (e) {}
      }
      toast('Geofencing on — works while Punchline is open');
      resolve(true);
    }, function (err) {
      toast('Location denied: ' + (err && err.message ? err.message : 'permission refused'), 'err', 4500);
      resolve(false);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}

function startGeo() {
  if (!navigator.geolocation || state.geo.watchId != null) return;
  state.geo.watchId = navigator.geolocation.watchPosition(onPosition, function (err) {
    if (err && err.code === 1) {   // PERMISSION_DENIED
      state.settings.geoEnabled = false;
      saveSettings();
      stopGeo();
      toast('Location permission was revoked — geofencing off', 'warn', 4000);
      if (state.route === 'settings') renderRoute();
    }
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
}

function stopGeo() {
  if (state.geo.watchId != null) {
    try { navigator.geolocation.clearWatch(state.geo.watchId); } catch (e) {}
    state.geo.watchId = null;
  }
  state.geo.insideId = null;
}

/** Single position handler: figures out enter/exit transitions and reacts. */
function onPosition(pos) {
  var lat = pos.coords.latitude, lng = pos.coords.longitude;
  state.geo.last = { lat: lat, lng: lng, acc: pos.coords.accuracy, ts: Date.now() };

  var hit = siteContaining(lat, lng);
  var wasInside = state.geo.insideId;
  var nowInside = hit ? hit.site.id : null;
  if (nowInside === wasInside) return;      // no boundary crossed, nothing to do

  state.geo.insideId = nowInside;

  if (nowInside) handleGeoEnter(hit.site);
  else if (wasInside) handleGeoExit(wasInside);

  // The "Nearby" chip lives in the Clock view, so a crossing re-renders it.
  if (state.route === 'clock') renderRoute();
}

function handleGeoEnter(js) {
  var me = selfEmployee();
  var cur = openShift(me.id);
  if (cur) {
    // Already on the clock: if it is a different site, offer to switch.
    if (cur.jobSiteId !== js.id && !state.geo.prompting) {
      state.geo.prompting = true;
      openSheet({
        title: 'Arrived at ' + js.name,
        body: '<p>You are clocked in under ' + esc(siteName(cur.jobSiteId)) + '. Move this punch to ' + esc(js.name) + '?</p>',
        foot: '<button class="btn ghost" type="button" data-sheet-close>Leave it</button>' +
              '<button class="btn primary" type="button" data-yes>Switch job</button>',
        onMount: function (el, close) {
          on($('[data-yes]', el), 'click', function () { close(); setPunchSite(js.id); });
        },
        onClose: function () { state.geo.prompting = false; }
      });
    }
    return;
  }
  if (state.settings.geoMode === 'auto') {
    doClockIn('geo', js.id);
    notify('Clocked in', 'Punchline started the clock at ' + js.name + '.');
    return;
  }
  if (state.geo.prompting) return;
  state.geo.prompting = true;
  notify('Arrived at ' + js.name, 'Tap to clock in.');
  openSheet({
    title: 'You are at ' + js.name,
    body: '<p>Start the clock here?</p>' +
          '<div class="inline-note">You are inside the ' + int(js.radiusMeters, 120) + ' m boundary for this job site.</div>',
    foot: '<button class="btn ghost" type="button" data-sheet-close>Not now</button>' +
          '<button class="btn primary" type="button" data-yes>Clock in</button>',
    onMount: function (el, close) {
      on($('[data-yes]', el), 'click', function () { close(); doClockIn('geo', js.id); });
    },
    onClose: function () { state.geo.prompting = false; }
  });
}

function handleGeoExit(leftSiteId) {
  state.geo.lastLeftSiteId = leftSiteId;
  state.geo.lastLeftAt = Date.now();
  var me = selfEmployee();
  var cur = openShift(me.id);
  if (!cur || cur.jobSiteId !== leftSiteId) return;

  if (state.settings.geoMode === 'auto') {
    notify('Clocked out', 'You left ' + siteName(leftSiteId) + '.');
    doClockOut();
    return;
  }
  if (state.geo.prompting) return;
  state.geo.prompting = true;
  notify('Left ' + siteName(leftSiteId), 'Tap to clock out.');
  promptClockOut(true);
  // promptClockOut owns its sheet; release the debounce once the stack empties
  // so a later crossing can prompt again.
  var iv = setInterval(function () {
    if (!sheetStack.length) { state.geo.prompting = false; clearInterval(iv); }
  }, 500);
}

/**
 * recordMileageOnArrival — when a punch starts at a site different from the one
 * you last left, log the trip: straight-line distance x ROAD_FACTOR, and the
 * wall-clock minutes between leaving and arriving.
 */
function recordMileageOnArrival(shift) {
  var fromId = state.geo.lastLeftSiteId, leftAt = state.geo.lastLeftAt;
  if (!fromId || !leftAt || !shift.jobSiteId || fromId === shift.jobSiteId) return;
  var a = site(fromId), b = site(shift.jobSiteId);
  state.geo.lastLeftSiteId = null; state.geo.lastLeftAt = null;
  if (!a || !b || a.lat == null || b.lat == null) return;

  var minutes = clamp((shift.start - leftAt) / MS_MIN, 0, 240);
  var miles = metersToMiles(haversineMeters(a.lat, a.lng, b.lat, b.lng)) * ROAD_FACTOR;
  if (miles < 0.05) return;

  var rec = newMileage({ date: shift.start, fromJobSiteId: fromId, toJobSiteId: shift.jobSiteId,
                         miles: Math.round(miles * 100) / 100, minutes: Math.round(minutes),
                         ratePerMile: num(state.settings.mileageRate, 0.7) });
  upsert('mileage', 'mileage', rec);
  shift.miles = num(shift.miles, 0) + rec.miles;
  shift.driveMinutes = num(shift.driveMinutes, 0) + rec.minutes;
  saveShift(shift);
  toast('Logged ' + rec.miles.toFixed(1) + ' mi drive from ' + siteName(fromId));
}

/* ==========================================================================
   13. BOOT
   ========================================================================== */

var deferredInstall = null;
on(window, 'beforeinstallprompt', function (e) {
  e.preventDefault();
  deferredInstall = e;
  if (state.route === 'settings') renderRoute();
});
function promptInstall() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall.userChoice.then(function () { deferredInstall = null; renderRoute(); });
}

/** Reconcile the localStorage quick-read with the real records in IndexedDB. */
function reconcileActivePunch() {
  var me = selfEmployee();
  var open = openShift(me.id);
  var ap = activePunch();
  if (open && (!ap || ap.shiftId !== open.id)) {
    setActivePunch({ shiftId: open.id, employeeId: open.employeeId, jobSiteId: open.jobSiteId,
                     start: open.start, breakStart: (openBreak(open) || {}).start || null });
  } else if (!open && ap) {
    setActivePunch(null);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;   // SW cannot run from file://
  navigator.serviceWorker.register('./sw.js').then(function (reg) {
    reg.addEventListener('updatefound', function () {
      var sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', function () {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Update ready — reopen Punchline to apply', 'warn', 5000);
        }
      });
    });
  }).catch(function (e) { console.warn('SW registration failed', e); });
}

function boot() {
  loadAll().then(function () {
    reconcileActivePunch();
    _cur = null;
    if (!location.hash) location.hash = '#/clock';
    renderRoute();
    if (state.settings.geoEnabled) startGeo();
    registerServiceWorker();
  }).catch(function (e) {
    console.error(e);
    document.querySelector('main').innerHTML =
      '<div class="card"><h2>Punchline could not start</h2><p>' + esc(e && e.message ? e.message : String(e)) +
      '</p><p>This usually means private browsing has blocked local storage. Punchline needs IndexedDB to keep your shifts.</p></div>';
  });
}

if (document.readyState === 'loading') on(document, 'DOMContentLoaded', boot);
else boot();

})();
