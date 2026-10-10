const crypto = require('crypto');
const { DateTime } = require('luxon');
const { describeSchedule } = require('./schedule');

const FORMS = ['tablet', 'capsule', 'vial'];
const STRENGTH_UNITS = ['mg', 'mcg', 'g', 'units', 'IU', 'mmol', 'ml'];

/** '' / undefined -> null, invalid -> NaN (so `!(x > 0)` style checks catch it) */
function num(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
const str = (v) => {
  const s = (v ?? '').toString().trim();
  return s === '' ? null : s;
};
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && DateTime.fromISO(v).isValid;
const today = (tz) => DateTime.now().setZone(tz || 'UTC').toISODate();

function fmtNum(n, dp = 2) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '—';
  return String(Number(Number(n).toFixed(dp)));
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = DateTime.fromISO(d);
  return dt.isValid ? dt.toFormat('d LLL yyyy') : d;
}
function fmtDateTime(iso, tz) {
  if (!iso) return '—';
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz || 'UTC').toFormat('d LLL yyyy, HH:mm');
}
function fmtTime(iso, tz) {
  if (!iso) return '';
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz || 'UTC').toFormat('HH:mm');
}

function formName(med, n = 2) {
  if (med.form === 'vial') return 'ml';
  return Number(n) === 1 ? med.form : `${med.form}s`;
}
/** Unit of whatever is counted in stock: tablets/capsules or ml */
const stockUnit = (med) => (med.form === 'vial' ? 'ml' : `${med.form}s`);
const concUnit = (med) => `${med.strength_unit}/ml`;

/** e.g. "10 mg (2 tablets)" or "25 mg (≈ 0.5 ml)" */
function doseText(med, dose, concentration) {
  const base = `${fmtNum(dose, 3)} ${med.strength_unit}`;
  if (med.form === 'vial') {
    const c = concentration || med.strength;
    return c > 0 ? `${base} (≈ ${fmtNum(dose / c, 3)} ml)` : base;
  }
  const n = dose / med.strength;
  return `${base} (${fmtNum(n, 2)} ${formName(med, n)})`;
}

function stockItemText(med, item) {
  if (med.form === 'vial') {
    return `${fmtNum(item.remaining, 2)} / ${fmtNum(item.volume_ml, 2)} ml @ ${fmtNum(item.concentration, 3)} ${concUnit(med)}`;
  }
  return `${fmtNum(item.remaining, 2)} / ${fmtNum(item.quantity, 0)} ${stockUnit(med)}`;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Only follow local redirects */
function safeReturn(v, fallback = '/') {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : fallback;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const notFound = (what = 'Page') => new HttpError(404, `${what} not found.`);

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  FORMS,
  STRENGTH_UNITS,
  num,
  str,
  isDate,
  today,
  fmtNum,
  fmtDate,
  fmtDateTime,
  fmtTime,
  formName,
  stockUnit,
  concUnit,
  doseText,
  stockItemText,
  describeSchedule,
  safeEqual,
  safeReturn,
  HttpError,
  notFound,
  asyncHandler,
};
