const router = require('express').Router();
const { DateTime } = require('luxon');
const db = require('../db');
const S = require('../schedule');
const stock = require('../stock');
const u = require('../util');

const DUE_WINDOW_MIN = 60; // a dose is "due now" within an hour either side of its time
const REASONS = ['Forgot', 'Chose not to', 'Felt unwell', 'Ran out', 'Advised to stop', 'Other'];
const TABS = ['regular', 'prn', 'stopped'];

const getMed = (uid, id) => db.prepare('SELECT * FROM medications WHERE id = ? AND user_id = ?').get(id, uid);
const getSchedule = (uid, id) =>
  db.prepare('SELECT s.* FROM schedules s JOIN medications m ON m.id = s.medication_id WHERE s.id = ? AND m.user_id = ?').get(id, uid);

function dayLabel(dt, todayKey) {
  const k = dt.toISODate();
  const base = dt.toFormat('ccc d LLL');
  const today = DateTime.fromISO(todayKey, { zone: dt.zone });
  if (k === todayKey) return `Today · ${base}`;
  if (k === today.minus({ days: 1 }).toISODate()) return `Yesterday · ${base}`;
  if (k === today.plus({ days: 1 }).toISODate()) return `Tomorrow · ${base}`;
  return dt.toFormat('ccc d LLL yyyy');
}

/** given | omitted | due | late | future */
function slotStatus(log, at, now) {
  if (log) return log.status === 'taken' ? 'given' : 'omitted';
  if (at.toISODate() > now.toISODate()) return 'future';
  if (at < now.minus({ minutes: DUE_WINDOW_MIN })) return 'late';
  if (at <= now.plus({ minutes: DUE_WINDOW_MIN })) return 'due';
  return 'future';
}

function slotLabel(status, log, at, now, tz) {
  switch (status) {
    case 'given':
      return `Taken ${u.fmtTime(log.taken_at, tz)}`;
    case 'omitted':
      return log.reason || 'Not taken';
    case 'late':
      return at.toISODate() < now.toISODate() ? 'Not recorded' : 'Overdue';
    case 'due':
      return 'Due now';
    default:
      return 'Scheduled';
  }
}

const chartUrl = (date, tab, todayKey) => {
  const q = [];
  if (date && date !== todayKey) q.push(`date=${date}`);
  if (tab && tab !== 'regular') q.push(`tab=${tab}`);
  return '/' + (q.length ? `?${q.join('&')}` : '');
};

// ---- Medicines chart (home) --------------------------------------------------
router.get('/', (req, res) => {
  const tz = req.tz;
  const now = DateTime.now().setZone(tz);
  const todayKey = now.toISODate();
  const date = u.isDate(req.query.date) ? req.query.date : todayKey;
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'regular';
  const dayStart = DateTime.fromISO(date, { zone: tz }).startOf('day');
  const dayEnd = dayStart.plus({ days: 1 });
  const weekStart = dayStart.minus({ days: 6 });
  const warnDays = req.profile.expiry_warning_days;

  const allMeds = db.prepare('SELECT * FROM medications WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id);
  const meds = allMeds.filter((m) => !m.archived);
  const stopped = allMeds.filter((m) => m.archived);
  const schedStmt = db.prepare('SELECT * FROM schedules WHERE medication_id = ? AND active = 1 ORDER BY id');

  // All logs that could matter for this day and the 7-day strips, in one query
  const fromIso = weekStart.toUTC().toISO();
  const toIso = dayEnd.toUTC().toISO();
  const logs = db
    .prepare(
      `SELECT * FROM dose_logs WHERE user_id = ?
         AND ((scheduled_for >= ? AND scheduled_for < ?) OR (taken_at >= ? AND taken_at < ?))`
    )
    .all(req.user.id, fromIso, toIso, fromIso, toIso);
  const logByKey = new Map(logs.filter((l) => l.schedule_id).map((l) => [`${l.schedule_id}|${l.scheduled_for}`, l]));
  const returnTo = chartUrl(date, tab, todayKey);

  const regular = [];
  const prn = [];
  const alerts = [];
  const counts = { given: 0, due: 0, late: 0, total: 0 };

  for (const med of meds) {
    const scheds = schedStmt.all(med.id);
    const timed = scheds.filter((s) => s.frequency !== 'as_needed');
    const asNeeded = scheds.filter((s) => s.frequency === 'as_needed');
    const sum = stock.stockSummary(med, scheds, todayKey, warnDays);
    const conc = sum.currentConcentration;

    // Regular row: shown for every medicine with a timed schedule, or with no schedule at all
    if (timed.length || !asNeeded.length) {
      const slots = [];
      for (const s of timed) {
        for (const at of S.occurrencesBetween(s, dayStart, dayEnd, tz)) {
          const key = at.toUTC().toISO();
          const log = logByKey.get(`${s.id}|${key}`) || null;
          const status = slotStatus(log, at, now);
          slots.push({ at, key, schedule: s, log, status, label: slotLabel(status, log, at, now, tz), dose: s.dose });
          counts.total++;
          if (status === 'given') counts.given++;
          else if (status === 'due') counts.due++;
          else if (status === 'late') counts.late++;
        }
      }
      slots.sort((a, b) => a.at - b.at);
      const doses = new Set(timed.map((s) => s.dose));

      // Last 7 days ending on the chart date
      const week = [];
      for (let i = 6; i >= 0; i--) {
        const d = dayStart.minus({ days: i });
        const dKey = d.toISODate();
        let cls = 'off';
        let title = d.toFormat('ccc d LLL');
        if (dKey <= todayKey) {
          let tot = 0;
          let got = 0;
          let open = 0;
          for (const s of timed) {
            for (const at of S.occurrencesBetween(s, d, d.plus({ days: 1 }), tz)) {
              const st = slotStatus(logByKey.get(`${s.id}|${at.toUTC().toISO()}`), at, now);
              tot++;
              if (st === 'given') got++;
              if (st === 'future' || st === 'due') open++;
            }
          }
          if (!tot) title += ': no doses due';
          else {
            cls = got === tot ? 'full' : open === tot ? 'open' : got ? 'part' : 'none';
            title += `: ${got}/${tot} taken`;
          }
        }
        week.push({ cls, title, label: d.toFormat('ccccc') });
      }

      regular.push({
        med,
        rx: timed.map((s) => `${u.doseText(med, s.dose, conc)} · ${u.describeSchedule(s)}`),
        slots,
        week,
        showDose: doses.size > 1,
        noSchedule: !timed.length,
        conc,
      });
    }

    if (asNeeded.length) {
      const prnIds = new Set(asNeeded.map((s) => s.id));
      const startIso = dayStart.toUTC().toISO();
      const endIso = dayEnd.toUTC().toISO();
      const entries = logs
        .filter(
          (l) =>
            l.medication_id === med.id &&
            l.status === 'taken' &&
            l.taken_at >= startIso &&
            l.taken_at < endIso &&
            (l.schedule_id === null || prnIds.has(l.schedule_id))
        )
        .sort((a, b) => (a.taken_at < b.taken_at ? -1 : 1));
      prn.push({
        med,
        schedule: asNeeded[0],
        rx: asNeeded.map((s) => `${u.doseText(med, s.dose, conc)} · when needed${s.notes ? ` · ${s.notes}` : ''}`),
        entries,
      });
    }

    const href = `/medications/${med.id}`;
    if (sum.expired.length) alerts.push({ level: 'red', href, text: `${med.name}: ${sum.expired.length} expired item(s) still marked in use` });
    if (sum.low || (sum.daysLeft !== null && sum.daysLeft < 7))
      alerts.push({
        level: 'amber',
        href,
        text:
          `${med.name}: low stock — ${u.fmtNum(sum.units)} ${u.stockUnit(med)} left` +
          (sum.daysLeft !== null ? ` (≈ ${Math.floor(sum.daysLeft)} days)` : ''),
      });
    for (const it of sum.expiringSoon)
      alerts.push({ level: 'amber', href, text: `${med.name}${it.batch ? ` batch ${it.batch}` : ''} expires ${u.fmtDate(it.expiry_date)}` });
  }
  for (const d of db
    .prepare(
      'SELECT * FROM disposables WHERE user_id = ? AND archived = 0 AND low_stock_threshold IS NOT NULL AND quantity <= low_stock_threshold'
    )
    .all(req.user.id)) {
    alerts.push({ level: 'amber', href: `/disposables/${d.id}`, text: `${d.name}: low — ${u.fmtNum(d.quantity)} ${d.unit} left` });
  }

  res.render('dashboard', {
    title: 'Chart',
    date,
    todayKey,
    tab,
    dayLabel: dayLabel(dayStart, todayKey),
    prevUrl: chartUrl(dayStart.minus({ days: 1 }).toISODate(), tab, todayKey),
    nextUrl: chartUrl(dayStart.plus({ days: 1 }).toISODate(), tab, todayKey),
    todayUrl: chartUrl(todayKey, tab, todayKey),
    tabUrl: (t) => chartUrl(date, t, todayKey),
    isPast: date < todayKey,
    isFuture: date > todayKey,
    regular,
    prn,
    stopped,
    counts,
    alerts,
    meds,
    returnTo,
  });
});

// ---- Recording doses -----------------------------------------------------------
function resolveContext(req, src) {
  if (src.schedule_id) {
    const schedule = getSchedule(req.user.id, Number(src.schedule_id));
    if (!schedule) throw u.notFound('Schedule');
    const med = getMed(req.user.id, schedule.medication_id);
    let scheduledFor = null;
    if (src.scheduled_for) {
      const dt = DateTime.fromISO(src.scheduled_for, { zone: 'utc' });
      if (!dt.isValid) throw new u.HttpError(400, 'Invalid dose time.');
      scheduledFor = dt.toISO();
    }
    return { med, schedule, scheduledFor, dose: schedule.dose };
  }
  const med = getMed(req.user.id, Number(src.medication_id));
  if (!med) throw u.notFound('Medication');
  return { med, schedule: null, scheduledFor: null, dose: med.default_dose };
}

/** True when a scheduled dose falls on a later day than today (can't be recorded yet) */
const isFutureDay = (scheduledFor, tz) =>
  !!scheduledFor && DateTime.fromISO(scheduledFor, { zone: 'utc' }).setZone(tz).toISODate() > u.today(tz);

router.get('/doses/take', (req, res) => {
  const ctx = resolveContext(req, req.query);
  const tz = req.tz;
  const today = u.today(tz);
  const existing =
    ctx.schedule && ctx.scheduledFor
      ? db.prepare('SELECT * FROM dose_logs WHERE schedule_id = ? AND scheduled_for = ?').get(ctx.schedule.id, ctx.scheduledFor)
      : null;
  const items = stock.activeItems(ctx.med.id).filter((i) => i.remaining > 0 && !stock.isExpired(i, today));
  const disposables = db
    .prepare(
      `SELECT d.*, md.quantity_per_dose FROM disposables d
       LEFT JOIN medication_disposables md ON md.disposable_id = d.id AND md.medication_id = ?
       WHERE d.user_id = ? AND d.archived = 0 ORDER BY md.quantity_per_dose IS NULL, d.name`
    )
    .all(ctx.med.id, req.user.id);
  const scheduledAt = ctx.scheduledFor ? DateTime.fromISO(ctx.scheduledFor, { zone: 'utc' }).setZone(tz) : null;
  // Recording yesterday's 21:00 dose? Default to the scheduled time rather than "now"
  const defaultTaken = scheduledAt && scheduledAt.toISODate() !== today ? scheduledAt : DateTime.now().setZone(tz);
  const sum = stock.stockSummary(ctx.med, [], today);
  res.render('take', {
    title: ctx.med.name,
    ...ctx,
    existing,
    scheduledAt,
    future: isFutureDay(ctx.scheduledFor, tz),
    items,
    disposables,
    reasons: REASONS,
    concentration: sum.currentConcentration,
    takenAtLocal: defaultTaken.toFormat("yyyy-LL-dd'T'HH:mm"),
    returnTo: u.safeReturn(req.query.return_to),
  });
});

router.post('/doses/take', (req, res) => {
  const b = req.body;
  const ctx = resolveContext(req, b);
  const back = u.safeReturn(b.return_to);
  if (isFutureDay(ctx.scheduledFor, req.tz)) {
    req.flash('error', 'That dose is on a future day. You can only record doses up to today.');
    return res.redirect(back);
  }
  const dose = b.dose !== undefined && b.dose !== '' ? u.num(b.dose) : ctx.dose;
  if (!(dose > 0)) {
    req.flash('error', 'Dose must be more than zero.');
    return res.redirect(back);
  }
  let takenAt = new Date().toISOString();
  if (b.taken_at) {
    const dt = DateTime.fromISO(b.taken_at, { zone: req.tz });
    if (!dt.isValid) {
      req.flash('error', 'Invalid time taken.');
      return res.redirect(back);
    }
    takenAt = dt.toUTC().toISO();
  }

  let disposables;
  if (b.quick) {
    disposables = stock.linkedDisposables(ctx.med.id).map((d) => ({ id: d.id, quantity: d.quantity_per_dose }));
  } else {
    disposables = Object.keys(b)
      .filter((k) => /^disp_\d+$/.test(k))
      .map((k) => ({ id: Number(k.slice(5)), quantity: u.num(b[k]) }))
      .filter((d) => d.quantity > 0);
  }

  try {
    const { shortfall } = stock.recordDose({
      userId: req.user.id,
      med: ctx.med,
      scheduleId: ctx.schedule?.id ?? null,
      scheduledFor: ctx.schedule ? ctx.scheduledFor : null,
      dose,
      takenAt,
      stockItemId: b.stock_item_id ? Number(b.stock_item_id) : null,
      disposables,
      notes: u.str(b.notes),
      today: u.today(req.tz),
    });
    if (shortfall) {
      req.flash(
        'warn',
        `${ctx.med.name} recorded, but stock only covered part of it — ${u.fmtNum(shortfall, 3)} ${ctx.med.strength_unit} short. Add a new box/vial or check your stock.`
      );
    } else {
      req.flash('success', `${ctx.med.name} recorded as taken.`);
    }
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') req.flash('warn', 'That dose was already recorded.');
    else throw e;
  }
  res.redirect(back);
});

router.post('/doses/skip', (req, res) => {
  const ctx = resolveContext(req, req.body);
  const back = u.safeReturn(req.body.return_to);
  if (!ctx.schedule || !ctx.scheduledFor) throw new u.HttpError(400, 'Only scheduled doses can be recorded as not taken.');
  if (isFutureDay(ctx.scheduledFor, req.tz)) {
    req.flash('error', 'That dose is on a future day. You can only record doses up to today.');
    return res.redirect(back);
  }
  const reason = REASONS.includes(req.body.reason) ? req.body.reason : null;
  if (!reason) {
    req.flash('error', 'Choose a reason the dose was not taken.');
    return res.redirect(back);
  }
  try {
    stock.recordSkip({
      userId: req.user.id,
      med: ctx.med,
      scheduleId: ctx.schedule.id,
      scheduledFor: ctx.scheduledFor,
      reason,
      notes: u.str(req.body.notes),
    });
    req.flash('info', `${ctx.med.name} recorded as not taken (${reason.toLowerCase()}).`);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') req.flash('warn', 'That dose was already recorded.');
    else throw e;
  }
  res.redirect(back);
});

router.post('/doses/:id/undo', (req, res) => {
  const log = stock.undoDose(Number(req.params.id), req.user.id);
  if (!log) throw u.notFound('Dose');
  req.flash('info', log.status === 'taken' ? 'Entry cleared and stock restored.' : 'Entry cleared.');
  res.redirect(u.safeReturn(req.body.return_to));
});

// ---- History ---------------------------------------------------------------------
router.get('/history', (req, res) => {
  const medId = req.query.medication_id ? Number(req.query.medication_id) : null;
  const logs = db
    .prepare(
      `SELECT dl.*, m.name AS med_name, m.form, m.strength, m.strength_unit,
         (SELECT SUM(amount) FROM dose_stock_usage WHERE dose_log_id = dl.id) AS units_used,
         (SELECT GROUP_CONCAT(d.name || ' ×' || (-t.change), ', ') FROM disposable_transactions t
            JOIN disposables d ON d.id = t.disposable_id WHERE t.dose_log_id = dl.id) AS supplies
       FROM dose_logs dl JOIN medications m ON m.id = dl.medication_id
       WHERE dl.user_id = ? AND (? IS NULL OR dl.medication_id = ?)
       ORDER BY COALESCE(dl.scheduled_for, dl.taken_at) DESC LIMIT 200`
    )
    .all(req.user.id, medId, medId);
  const meds = db.prepare('SELECT id, name FROM medications WHERE user_id = ? ORDER BY name').all(req.user.id);
  res.render('history', { title: 'History', logs, meds, medId });
});

module.exports = router;
