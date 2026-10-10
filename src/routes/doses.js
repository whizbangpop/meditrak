const router = require('express').Router();
const { DateTime } = require('luxon');
const db = require('../db');
const S = require('../schedule');
const stock = require('../stock');
const u = require('../util');

const getMed = (uid, id) => db.prepare('SELECT * FROM medications WHERE id = ? AND user_id = ?').get(id, uid);
const getSchedule = (uid, id) =>
  db.prepare('SELECT s.* FROM schedules s JOIN medications m ON m.id = s.medication_id WHERE s.id = ? AND m.user_id = ?').get(id, uid);

// ---- Today ---------------------------------------------------------------
router.get('/', (req, res) => {
  const tz = req.tz;
  const now = DateTime.now().setZone(tz);
  const today = now.toISODate();
  const warnDays = req.profile.expiry_warning_days;
  const meds = db.prepare('SELECT * FROM medications WHERE user_id = ? AND archived = 0 ORDER BY name').all(req.user.id);
  const schedStmt = db.prepare('SELECT * FROM schedules WHERE medication_id = ? ORDER BY id');
  const logStmt = db.prepare('SELECT * FROM dose_logs WHERE schedule_id = ? AND scheduled_for = ?');

  const doses = [];
  const prn = [];
  const alerts = [];
  for (const med of meds) {
    const scheds = schedStmt.all(med.id).filter((s) => s.active);
    const sum = stock.stockSummary(med, scheds, today, warnDays);
    for (const s of scheds) {
      if (s.frequency === 'as_needed') {
        prn.push({ med, schedule: s, doseText: u.doseText(med, s.dose, sum.currentConcentration) });
        continue;
      }
      // today's doses, plus anything missed in the 24h before today
      const windows = [
        [now.startOf('day'), now.endOf('day'), false],
        [now.minus({ hours: 24 }), now.startOf('day'), true],
      ];
      for (const [from, to, earlier] of windows) {
        for (const at of S.occurrencesBetween(s, from, to, tz)) {
          const key = at.toUTC().toISO();
          const log = logStmt.get(s.id, key);
          if (earlier && log) continue;
          const status = log
            ? log.status
            : earlier || at < now.minus({ minutes: 60 })
              ? 'overdue'
              : at <= now.plus({ minutes: 30 })
                ? 'due'
                : 'upcoming';
          doses.push({ med, schedule: s, at, key, log, status, earlier, doseText: u.doseText(med, s.dose, sum.currentConcentration) });
        }
      }
    }
    const href = `/medications/${med.id}`;
    if (sum.expired.length) alerts.push({ level: 'danger', href, text: `${med.name}: ${sum.expired.length} expired item(s) still marked in use` });
    if (sum.low || (sum.daysLeft !== null && sum.daysLeft < 7))
      alerts.push({
        level: 'warn',
        href,
        text: `${med.name}: low stock — ${u.fmtNum(sum.units)} ${u.stockUnit(med)} left` + (sum.daysLeft !== null ? ` (≈ ${Math.floor(sum.daysLeft)} days)` : ''),
      });
    for (const it of sum.expiringSoon)
      alerts.push({ level: 'info', href, text: `${med.name}${it.batch ? ` batch ${it.batch}` : ''} expires ${u.fmtDate(it.expiry_date)}` });
  }
  for (const d of db
    .prepare('SELECT * FROM disposables WHERE user_id = ? AND archived = 0 AND low_stock_threshold IS NOT NULL AND quantity <= low_stock_threshold')
    .all(req.user.id)) {
    alerts.push({ level: 'warn', href: `/disposables/${d.id}`, text: `${d.name}: low — ${u.fmtNum(d.quantity)} ${d.unit} left` });
  }
  doses.sort((a, b) => a.at - b.at);
  res.render('dashboard', { title: 'Today', doses, prn, alerts, meds, now });
});

// ---- Logging doses -------------------------------------------------------
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

router.get('/doses/take', (req, res) => {
  const ctx = resolveContext(req, req.query);
  const today = u.today(req.tz);
  const items = stock.activeItems(ctx.med.id).filter((i) => i.remaining > 0 && !stock.isExpired(i, today));
  const disposables = db
    .prepare(
      `SELECT d.*, md.quantity_per_dose FROM disposables d
       LEFT JOIN medication_disposables md ON md.disposable_id = d.id AND md.medication_id = ?
       WHERE d.user_id = ? AND d.archived = 0 ORDER BY md.quantity_per_dose IS NULL, d.name`
    )
    .all(ctx.med.id, req.user.id);
  res.render('take', {
    title: `Log ${ctx.med.name}`,
    ...ctx,
    items,
    disposables,
    takenAtLocal: DateTime.now().setZone(req.tz).toFormat("yyyy-LL-dd'T'HH:mm"),
    returnTo: u.safeReturn(req.query.return_to),
  });
});

router.post('/doses/take', (req, res) => {
  const b = req.body;
  const ctx = resolveContext(req, b);
  const back = u.safeReturn(b.return_to);
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
      req.flash('warn', `${ctx.med.name} logged, but stock only covered part of it — ${u.fmtNum(shortfall, 3)} ${ctx.med.strength_unit} short. Add a new box/vial or check your stock.`);
    } else {
      req.flash('success', `${ctx.med.name} logged.`);
    }
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') req.flash('warn', 'That dose was already logged.');
    else throw e;
  }
  res.redirect(back);
});

router.post('/doses/skip', (req, res) => {
  const ctx = resolveContext(req, req.body);
  if (!ctx.schedule || !ctx.scheduledFor) throw new u.HttpError(400, 'Only scheduled doses can be skipped.');
  try {
    stock.recordSkip({ userId: req.user.id, med: ctx.med, scheduleId: ctx.schedule.id, scheduledFor: ctx.scheduledFor });
    req.flash('info', `${ctx.med.name} dose skipped.`);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') req.flash('warn', 'That dose was already logged.');
    else throw e;
  }
  res.redirect(u.safeReturn(req.body.return_to));
});

router.post('/doses/:id/undo', (req, res) => {
  const log = stock.undoDose(Number(req.params.id), req.user.id);
  if (!log) throw u.notFound('Dose');
  req.flash('info', log.status === 'taken' ? 'Dose removed and stock restored.' : 'Skip removed.');
  res.redirect(u.safeReturn(req.body.return_to));
});

// ---- History -------------------------------------------------------------
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
       ORDER BY dl.taken_at DESC LIMIT 200`
    )
    .all(req.user.id, medId, medId);
  const meds = db.prepare('SELECT id, name FROM medications WHERE user_id = ? ORDER BY name').all(req.user.id);
  res.render('history', { title: 'History', logs, meds, medId });
});

module.exports = router;
