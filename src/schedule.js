const { DateTime } = require('luxon');

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FREQUENCIES = {
  daily: 'Every day',
  every_n_days: 'Every N days',
  weekly: 'On specific days of the week',
  as_needed: 'As needed (no reminders)',
};

function parseList(v) {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
const scheduleTimes = (s) => parseList(s.times).filter((t) => /^\d{2}:\d{2}$/.test(t)).sort();
const scheduleDays = (s) =>
  parseList(s.days_of_week).map(Number).filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);

function matchesDay(s, day, start) {
  switch (s.frequency) {
    case 'daily':
      return true;
    case 'every_n_days': {
      const n = Math.max(1, s.interval_days || 1);
      const diff = Math.round(day.diff(start, 'days').days);
      return diff >= 0 && diff % n === 0;
    }
    case 'weekly':
      return scheduleDays(s).includes(day.weekday);
    default:
      return false;
  }
}

/**
 * All dose times for a schedule in [from, to), as luxon DateTimes in the user's zone.
 */
function occurrencesBetween(s, from, to, tz) {
  if (!s.active || s.frequency === 'as_needed') return [];
  const times = scheduleTimes(s);
  if (!times.length) return [];
  const start = DateTime.fromISO(s.start_date, { zone: tz }).startOf('day');
  if (!start.isValid) return [];
  const end = s.end_date ? DateTime.fromISO(s.end_date, { zone: tz }).endOf('day') : null;

  let day = DateTime.max(start, from.setZone(tz).startOf('day'));
  const lastDay = to.setZone(tz).startOf('day');
  const out = [];
  let guard = 0;
  while (day <= lastDay && guard++ < 1000) {
    if (end && day > end) break;
    if (matchesDay(s, day, start)) {
      for (const t of times) {
        const [h, m] = t.split(':').map(Number);
        const dt = day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
        if (dt >= from && dt < to) out.push(dt);
      }
    }
    day = day.plus({ days: 1 });
  }
  return out;
}

function nextOccurrence(s, tz, from = DateTime.now()) {
  const span = Math.max(8, (s.interval_days || 1) + 2);
  return occurrencesBetween(s, from, from.plus({ days: span }), tz)[0] || null;
}

function describeSchedule(s) {
  const times = scheduleTimes(s);
  const n = times.length;
  const per = n === 1 ? 'Once' : n === 2 ? 'Twice' : n === 3 ? 'Three times' : `${n} times`;
  const at = times.join(', ');
  switch (s.frequency) {
    case 'daily':
      return `${per} daily at ${at}`;
    case 'every_n_days': {
      const i = s.interval_days || 1;
      if (i === 1) return `${per} daily at ${at}`;
      return `Every ${i} days at ${at}`;
    }
    case 'weekly':
      return `Every ${scheduleDays(s).map((d) => DAY_NAMES[d - 1]).join(', ')} at ${at}`;
    case 'as_needed':
      return 'As needed';
    default:
      return s.frequency;
  }
}

/** Average number of doses per day — used for "days of stock left". */
function dosesPerDay(s, today) {
  if (!s.active || s.frequency === 'as_needed') return 0;
  if (s.end_date && today && s.end_date < today) return 0;
  const n = scheduleTimes(s).length;
  switch (s.frequency) {
    case 'daily':
      return n;
    case 'every_n_days':
      return n / Math.max(1, s.interval_days || 1);
    case 'weekly':
      return (n * scheduleDays(s).length) / 7;
    default:
      return 0;
  }
}

module.exports = {
  DAY_NAMES,
  FREQUENCIES,
  scheduleTimes,
  scheduleDays,
  occurrencesBetween,
  nextOccurrence,
  describeSchedule,
  dosesPerDay,
};
