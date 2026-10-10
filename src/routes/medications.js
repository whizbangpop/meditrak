const router = require('express').Router();
const { DateTime } = require('luxon');
const db = require('../db');
const S = require('../schedule');
const stock = require('../stock');
const u = require('../util');

const getMed = (req, id) => {
  const med = db.prepare('SELECT * FROM medications WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  if (!med) throw u.notFound('Medication');
  return med;
};
const getItem = (req, id) => {
  const item = db
    .prepare('SELECT s.* FROM stock_items s JOIN medications m ON m.id = s.medication_id WHERE s.id = ? AND m.user_id = ?')
    .get(Number(id), req.user.id);
  if (!item) throw u.notFound('Stock item');
  return { item, med: getMed(req, item.medication_id) };
};
const getSchedule = (req, id) => {
  const s = db
    .prepare('SELECT s.* FROM schedules s JOIN medications m ON m.id = s.medication_id WHERE s.id = ? AND m.user_id = ?')
    .get(Number(id), req.user.id);
  if (!s) throw u.notFound('Schedule');
  return { schedule: s, med: getMed(req, s.medication_id) };
};

// ---- Medications -----------------------------------------------------------
function parseMed(b) {
  const v = {
    name: u.str(b.name),
    form: b.form,
    strength: u.num(b.strength),
    strength_unit: u.STRENGTH_UNITS.includes(b.strength_unit) ? b.strength_unit : 'mg',
    default_dose: u.num(b.default_dose),
    low_stock_threshold: u.num(b.low_stock_threshold),
    instructions: u.str(b.instructions),
  };
  const e = [];
  if (!v.name) e.push('Enter a name.');
  if (!u.FORMS.includes(v.form)) e.push('Choose tablet, capsule or vial.');
  if (!(v.strength > 0)) e.push(v.form === 'vial' ? 'Enter the typical concentration per ml.' : `Enter the strength per ${v.form || 'tablet'}.`);
  if (v.default_dose === null) {
    if (v.form === 'vial') e.push('Enter a default dose for this vial medication.');
    else v.default_dose = v.strength;
  } else if (!(v.default_dose > 0)) e.push('Default dose must be more than zero.');
  if (v.low_stock_threshold !== null && !(v.low_stock_threshold >= 0)) e.push('Low stock level must be zero or more.');
  return { v, errors: e };
}

router.get('/medications', (req, res) => {
  const showArchived = req.query.archived === '1';
  const today = u.today(req.tz);
  const meds = db
    .prepare('SELECT * FROM medications WHERE user_id = ? AND archived = ? ORDER BY name')
    .all(req.user.id, showArchived ? 1 : 0)
    .map((m) => {
      const scheds = db.prepare('SELECT * FROM schedules WHERE medication_id = ? AND active = 1').all(m.id);
      return { ...m, scheds, sum: stock.stockSummary(m, scheds, today, req.profile.expiry_warning_days) };
    });
  res.render('medications/index', { title: 'Medications', meds, showArchived });
});

router.get('/medications/new', (req, res) =>
  res.render('medications/form', { title: 'Add medication', isNew: true, values: { form: 'tablet', strength_unit: 'mg' } })
);

router.post('/medications', (req, res) => {
  const { v, errors } = parseMed(req.body);
  if (errors.length) return res.status(400).render('medications/form', { title: 'Add medication', isNew: true, values: req.body, error: errors.join(' ') });
  const id = db
    .prepare(
      `INSERT INTO medications (user_id, name, form, strength, strength_unit, default_dose, low_stock_threshold, instructions)
       VALUES (@user_id, @name, @form, @strength, @strength_unit, @default_dose, @low_stock_threshold, @instructions)`
    )
    .run({ ...v, user_id: req.user.id }).lastInsertRowid;
  req.flash('success', `${v.name} added. Now add the ${v.form === 'vial' ? 'vials' : 'boxes'} you have and a schedule.`);
  res.redirect(`/medications/${id}`);
});

router.get('/medications/:id', (req, res) => {
  const med = getMed(req, req.params.id);
  const today = u.today(req.tz);
  const schedules = db.prepare('SELECT * FROM schedules WHERE medication_id = ? ORDER BY active DESC, id').all(med.id);
  const sum = stock.stockSummary(med, schedules.filter((s) => s.active), today, req.profile.expiry_warning_days);
  const showAll = req.query.all === '1';
  const allItems = db
    .prepare(`SELECT * FROM stock_items WHERE medication_id = ? ${showAll ? '' : "AND status = 'active'"} ORDER BY status = 'active' DESC, expiry_date, id`)
    .all(med.id);
  const finishedCount = db.prepare("SELECT COUNT(*) AS n FROM stock_items WHERE medication_id = ? AND status != 'active'").get(med.id).n;
  const links = stock.linkedDisposables(med.id);
  const disposables = db.prepare('SELECT * FROM disposables WHERE user_id = ? AND archived = 0 ORDER BY name').all(req.user.id);
  const logs = db.prepare('SELECT * FROM dose_logs WHERE medication_id = ? ORDER BY taken_at DESC LIMIT 10').all(med.id);
  const now = DateTime.now();
  res.render('medications/show', {
    title: med.name,
    med,
    sum,
    schedules: schedules.map((s) => ({ ...s, next: S.nextOccurrence(s, req.tz, now) })),
    allItems,
    finishedCount,
    showAll,
    links,
    disposables,
    logs,
    today,
  });
});

router.get('/medications/:id/edit', (req, res) => {
  const med = getMed(req, req.params.id);
  res.render('medications/form', { title: `Edit ${med.name}`, isNew: false, values: med, med });
});

router.post('/medications/:id', (req, res) => {
  const med = getMed(req, req.params.id);
  const { v, errors } = parseMed({ ...req.body, form: req.body.form || med.form });
  if (errors.length)
    return res.status(400).render('medications/form', { title: `Edit ${med.name}`, isNew: false, med, values: { ...req.body, id: med.id }, error: errors.join(' ') });
  db.prepare(
    `UPDATE medications SET name=@name, form=@form, strength=@strength, strength_unit=@strength_unit, default_dose=@default_dose,
       low_stock_threshold=@low_stock_threshold, instructions=@instructions WHERE id=@id`
  ).run({ ...v, id: med.id });
  req.flash('success', 'Medication saved.');
  res.redirect(`/medications/${med.id}`);
});

router.post('/medications/:id/archive', (req, res) => {
  const med = getMed(req, req.params.id);
  db.prepare('UPDATE medications SET archived = ? WHERE id = ?').run(med.archived ? 0 : 1, med.id);
  req.flash('info', med.archived ? `${med.name} restored.` : `${med.name} archived — reminders stopped.`);
  res.redirect(`/medications/${med.id}`);
});

router.post('/medications/:id/delete', (req, res) => {
  const med = getMed(req, req.params.id);
  db.prepare('DELETE FROM medications WHERE id = ?').run(med.id);
  req.flash('info', `${med.name} and its history were deleted.`);
  res.redirect('/medications');
});

// ---- Stock: boxes / packets / vials -------------------------------------
function parseStock(med, b, isNew) {
  const v = {
    batch: u.str(b.batch),
    expiry_date: u.str(b.expiry_date),
    received_date: u.str(b.received_date),
    notes: u.str(b.notes),
  };
  const e = [];
  if (v.expiry_date && !u.isDate(v.expiry_date)) e.push('Expiry date is not valid.');
  if (v.received_date && !u.isDate(v.received_date)) e.push('Received date is not valid.');
  if (med.form === 'vial') {
    v.concentration = u.num(b.concentration);
    v.volume_ml = u.num(b.volume_ml);
    v.quantity = null;
    if (!(v.concentration > 0)) e.push(`Enter the strength (${u.concUnit(med)}).`);
    if (!(v.volume_ml > 0)) e.push('Enter the total volume in ml.');
    v.remaining = isNew ? v.volume_ml : u.num(b.remaining);
    if (!(v.remaining >= 0)) e.push('Remaining volume must be zero or more.');
  } else {
    v.quantity = u.num(b.quantity);
    v.concentration = null;
    v.volume_ml = null;
    if (!(v.quantity > 0) || !Number.isInteger(v.quantity)) e.push(`Enter how many ${med.form}s are in the box.`);
    v.remaining = isNew ? v.quantity : u.num(b.remaining);
    if (!(v.remaining >= 0)) e.push('Remaining must be zero or more.');
  }
  v.count = isNew ? u.num(b.count) ?? 1 : 1;
  if (!Number.isInteger(v.count) || v.count < 1 || v.count > 50) e.push('Number of identical items must be 1–50.');
  return { v, errors: e };
}

router.get('/medications/:id/stock/new', (req, res) => {
  const med = getMed(req, req.params.id);
  res.render('stock_form', {
    title: `Add ${med.form === 'vial' ? 'vial' : 'box'}`,
    med,
    isNew: true,
    values: { received_date: u.today(req.tz), concentration: med.form === 'vial' ? med.strength : '', count: 1 },
  });
});

router.post('/medications/:id/stock', (req, res) => {
  const med = getMed(req, req.params.id);
  const { v, errors } = parseStock(med, req.body, true);
  if (errors.length)
    return res.status(400).render('stock_form', { title: 'Add stock', med, isNew: true, values: req.body, error: errors.join(' ') });
  const ins = db.prepare(
    `INSERT INTO stock_items (medication_id, batch, expiry_date, received_date, quantity, concentration, volume_ml, remaining, notes)
     VALUES (@medication_id, @batch, @expiry_date, @received_date, @quantity, @concentration, @volume_ml, @remaining, @notes)`
  );
  db.transaction(() => {
    for (let i = 0; i < v.count; i++) ins.run({ ...v, medication_id: med.id });
  })();
  const label = med.form === 'vial' ? (v.count > 1 ? 'vials' : 'vial') : v.count > 1 ? 'boxes' : 'box';
  req.flash('success', `${v.count} ${label} added to ${med.name}.`);
  res.redirect(`/medications/${med.id}`);
});

router.get('/stock/:id/edit', (req, res) => {
  const { item, med } = getItem(req, req.params.id);
  res.render('stock_form', { title: 'Edit stock item', med, item, isNew: false, values: item });
});

router.post('/stock/:id', (req, res) => {
  const { item, med } = getItem(req, req.params.id);
  const { v, errors } = parseStock(med, req.body, false);
  if (errors.length)
    return res.status(400).render('stock_form', { title: 'Edit stock item', med, item, isNew: false, values: req.body, error: errors.join(' ') });
  let status = item.status;
  if (status === 'finished' && v.remaining > 0) status = 'active';
  if (status === 'active' && v.remaining <= 0) status = 'finished';
  db.prepare(
    `UPDATE stock_items SET batch=@batch, expiry_date=@expiry_date, received_date=@received_date, quantity=@quantity,
       concentration=@concentration, volume_ml=@volume_ml, remaining=@remaining, notes=@notes, status=@status WHERE id=@id`
  ).run({ ...v, status, id: item.id });
  req.flash('success', 'Stock item saved.');
  res.redirect(`/medications/${med.id}`);
});

router.post('/stock/:id/status', (req, res) => {
  const { item, med } = getItem(req, req.params.id);
  const status = req.body.status;
  if (!['active', 'finished', 'disposed'].includes(status)) throw new u.HttpError(400, 'Invalid status.');
  db.prepare('UPDATE stock_items SET status = ? WHERE id = ?').run(status, item.id);
  req.flash('info', { active: 'Marked as in use.', finished: 'Marked as finished.', disposed: 'Marked as disposed.' }[status]);
  res.redirect(`/medications/${med.id}`);
});

router.post('/stock/:id/delete', (req, res) => {
  const { item, med } = getItem(req, req.params.id);
  db.prepare('DELETE FROM stock_items WHERE id = ?').run(item.id);
  req.flash('info', 'Stock item deleted.');
  res.redirect(`/medications/${med.id}`);
});

// ---- Schedules -------------------------------------------------------------
function parseSchedule(b, tz) {
  const times = [...new Set([].concat(b.times || []).map((t) => String(t).trim()).filter(Boolean))].sort();
  const days = [...new Set([].concat(b.days_of_week || []).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
  const v = {
    dose: u.num(b.dose),
    frequency: b.frequency,
    interval_days: b.frequency === 'every_n_days' ? u.num(b.interval_days) : null,
    days_of_week: JSON.stringify(b.frequency === 'weekly' ? days : []),
    times: JSON.stringify(b.frequency === 'as_needed' ? [] : times),
    start_date: u.str(b.start_date) || u.today(tz),
    end_date: u.str(b.end_date),
    notify: b.notify ? 1 : 0,
    notes: u.str(b.notes),
  };
  const e = [];
  if (!(v.dose > 0)) e.push('Dose must be more than zero.');
  if (!S.FREQUENCIES[v.frequency]) e.push('Choose how often.');
  if (v.frequency === 'every_n_days' && !(Number.isInteger(v.interval_days) && v.interval_days >= 1 && v.interval_days <= 365))
    e.push('Enter the number of days between doses (1–365).');
  if (v.frequency === 'weekly' && !days.length) e.push('Pick at least one day of the week.');
  if (v.frequency !== 'as_needed') {
    if (!times.length) e.push('Add at least one time.');
    if (times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) e.push('Times must be HH:MM.');
  }
  if (!u.isDate(v.start_date)) e.push('Start date is not valid.');
  if (v.end_date && (!u.isDate(v.end_date) || v.end_date < v.start_date)) e.push('End date must be on or after the start date.');
  return { v, errors: e };
}

function renderScheduleForm(res, req, med, extra) {
  const today = u.today(req.tz);
  const sum = stock.stockSummary(med, [], today);
  res.render('schedule_form', { med, frequencies: S.FREQUENCIES, dayNames: S.DAY_NAMES, concentration: sum.currentConcentration, ...extra });
}

router.get('/medications/:id/schedules/new', (req, res) => {
  const med = getMed(req, req.params.id);
  renderScheduleForm(res, req, med, {
    title: 'Add schedule',
    isNew: true,
    values: { dose: med.default_dose, frequency: 'daily', times: ['09:00'], days_of_week: [], start_date: u.today(req.tz), notify: 1 },
  });
});

const formValues = (b) => ({
  ...b,
  times: [].concat(b.times || []),
  days_of_week: [].concat(b.days_of_week || []).map(Number),
  notify: b.notify ? 1 : 0,
});

router.post('/medications/:id/schedules', (req, res) => {
  const med = getMed(req, req.params.id);
  const { v, errors } = parseSchedule(req.body, req.tz);
  if (errors.length)
    return renderScheduleForm(res.status(400), req, med, { title: 'Add schedule', isNew: true, values: formValues(req.body), error: errors.join(' ') });
  db.prepare(
    `INSERT INTO schedules (medication_id, dose, frequency, interval_days, days_of_week, times, start_date, end_date, notify, notes)
     VALUES (@medication_id, @dose, @frequency, @interval_days, @days_of_week, @times, @start_date, @end_date, @notify, @notes)`
  ).run({ ...v, medication_id: med.id });
  req.flash('success', 'Schedule added.');
  res.redirect(`/medications/${med.id}`);
});

router.get('/schedules/:id/edit', (req, res) => {
  const { schedule, med } = getSchedule(req, req.params.id);
  renderScheduleForm(res, req, med, {
    title: 'Edit schedule',
    isNew: false,
    schedule,
    values: { ...schedule, times: S.scheduleTimes(schedule), days_of_week: S.scheduleDays(schedule) },
  });
});

router.post('/schedules/:id', (req, res) => {
  const { schedule, med } = getSchedule(req, req.params.id);
  const { v, errors } = parseSchedule(req.body, req.tz);
  if (errors.length)
    return renderScheduleForm(res.status(400), req, med, { title: 'Edit schedule', isNew: false, schedule, values: formValues(req.body), error: errors.join(' ') });
  db.prepare(
    `UPDATE schedules SET dose=@dose, frequency=@frequency, interval_days=@interval_days, days_of_week=@days_of_week, times=@times,
       start_date=@start_date, end_date=@end_date, notify=@notify, notes=@notes WHERE id=@id`
  ).run({ ...v, id: schedule.id });
  req.flash('success', 'Schedule saved.');
  res.redirect(`/medications/${med.id}`);
});

router.post('/schedules/:id/toggle', (req, res) => {
  const { schedule, med } = getSchedule(req, req.params.id);
  db.prepare('UPDATE schedules SET active = ? WHERE id = ?').run(schedule.active ? 0 : 1, schedule.id);
  req.flash('info', schedule.active ? 'Schedule paused.' : 'Schedule resumed.');
  res.redirect(`/medications/${med.id}`);
});

router.post('/schedules/:id/delete', (req, res) => {
  const { schedule, med } = getSchedule(req, req.params.id);
  db.prepare('DELETE FROM schedules WHERE id = ?').run(schedule.id);
  req.flash('info', 'Schedule deleted. Past doses stay in your history.');
  res.redirect(`/medications/${med.id}`);
});

// ---- Disposables linked to a medication ---------------------------------
router.post('/medications/:id/disposables', (req, res) => {
  const med = getMed(req, req.params.id);
  const d = db.prepare('SELECT * FROM disposables WHERE id = ? AND user_id = ?').get(Number(req.body.disposable_id), req.user.id);
  const qty = u.num(req.body.quantity_per_dose) ?? 1;
  if (!d || !(qty > 0)) {
    req.flash('error', 'Choose a supply and a quantity above zero.');
    return res.redirect(`/medications/${med.id}`);
  }
  db.prepare(
    `INSERT INTO medication_disposables (medication_id, disposable_id, quantity_per_dose) VALUES (?, ?, ?)
     ON CONFLICT (medication_id, disposable_id) DO UPDATE SET quantity_per_dose = excluded.quantity_per_dose`
  ).run(med.id, d.id, qty);
  req.flash('success', `${d.name} will be used automatically with each dose.`);
  res.redirect(`/medications/${med.id}`);
});

router.post('/medications/:id/disposables/:did/delete', (req, res) => {
  const med = getMed(req, req.params.id);
  db.prepare('DELETE FROM medication_disposables WHERE medication_id = ? AND disposable_id = ?').run(med.id, Number(req.params.did));
  req.flash('info', 'Supply unlinked.');
  res.redirect(`/medications/${med.id}`);
});

module.exports = router;
