const router = require('express').Router();
const { DateTime } = require('luxon');
const db = require('../db');
const { str, num, isDate } = require('../util');

const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/London'];
  }
})();

function render(res, { isSetup, values, error }) {
  const subs = res.locals.user
    ? db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(res.locals.user.id).n
    : 0;
  res.render('profile', { title: isSetup ? 'Create your profile' : 'Profile', isSetup, values, error, timezones: TIMEZONES, subs });
}

router.get('/profile/setup', (req, res) => {
  if (req.profile) return res.redirect('/profile');
  render(res, {
    isSetup: true,
    values: { display_name: req.user.name || '', timezone: 'UTC', expiry_warning_days: 30, reminder_followup_minutes: 30 },
  });
});

router.get('/profile', (req, res) => render(res, { isSetup: false, values: req.profile }));

router.post('/profile', (req, res) => {
  const b = req.body;
  const v = {
    display_name: str(b.display_name),
    timezone: str(b.timezone) || 'UTC',
    date_of_birth: str(b.date_of_birth),
    notes: str(b.notes),
    expiry_warning_days: num(b.expiry_warning_days) ?? 30,
    reminder_followup_minutes: num(b.reminder_followup_minutes) ?? 0,
    nhs_number: str(b.nhs_number),
    weight_kg: num(b.weight_kg),
    gp_practice: str(b.gp_practice),
    allergies: str(b.allergies),
  };
  const errors = [];
  if (!v.display_name) errors.push('Enter a display name.');
  if (v.nhs_number && !/^[0-9 ]{6,14}$/.test(v.nhs_number)) errors.push('NHS / CHI number should be digits only.');
  if (v.weight_kg !== null && !(v.weight_kg > 0 && v.weight_kg < 500)) errors.push('Weight must be in kg, between 0 and 500.');
  if (v.allergies && v.allergies.length > 500) errors.push('Allergies must be under 500 characters.');
  if (!DateTime.now().setZone(v.timezone).isValid) errors.push('Choose a valid time zone.');
  if (v.date_of_birth && !isDate(v.date_of_birth)) errors.push('Date of birth is not a valid date.');
  if (!Number.isInteger(v.expiry_warning_days) || v.expiry_warning_days < 0 || v.expiry_warning_days > 365)
    errors.push('Expiry warning must be 0–365 days.');
  if (!Number.isInteger(v.reminder_followup_minutes) || v.reminder_followup_minutes < 0 || v.reminder_followup_minutes > 1440)
    errors.push('Follow-up reminder must be 0–1440 minutes.');
  const isSetup = !req.profile;
  if (errors.length) return render(res.status(400), { isSetup, values: v, error: errors.join(' ') });

  db.prepare(
    `INSERT INTO profiles (user_id, display_name, timezone, date_of_birth, notes, expiry_warning_days, reminder_followup_minutes,
       nhs_number, weight_kg, gp_practice, allergies, updated_at)
     VALUES (@user_id, @display_name, @timezone, @date_of_birth, @notes, @expiry_warning_days, @reminder_followup_minutes,
       @nhs_number, @weight_kg, @gp_practice, @allergies, @now)
     ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name, timezone = excluded.timezone,
       date_of_birth = excluded.date_of_birth, notes = excluded.notes, expiry_warning_days = excluded.expiry_warning_days,
       reminder_followup_minutes = excluded.reminder_followup_minutes, nhs_number = excluded.nhs_number,
       weight_kg = excluded.weight_kg, gp_practice = excluded.gp_practice, allergies = excluded.allergies,
       updated_at = excluded.updated_at`
  ).run({ ...v, user_id: req.user.id, now: new Date().toISOString() });

  req.flash('success', isSetup ? 'Profile created. Add your first medication to get started.' : 'Profile saved.');
  res.redirect(isSetup ? '/medications/new' : '/profile');
});

router.get('/profile/export', (req, res) => {
  const uid = req.user.id;
  const meds = db.prepare('SELECT * FROM medications WHERE user_id = ?').all(uid);
  const data = {
    exported_at: new Date().toISOString(),
    profile: req.profile,
    medications: meds.map((m) => ({
      ...m,
      stock_items: db.prepare('SELECT * FROM stock_items WHERE medication_id = ?').all(m.id),
      schedules: db.prepare('SELECT * FROM schedules WHERE medication_id = ?').all(m.id),
      linked_disposables: db.prepare('SELECT * FROM medication_disposables WHERE medication_id = ?').all(m.id),
    })),
    disposables: db.prepare('SELECT * FROM disposables WHERE user_id = ?').all(uid).map((d) => ({
      ...d,
      transactions: db.prepare('SELECT * FROM disposable_transactions WHERE disposable_id = ?').all(d.id),
    })),
    dose_logs: db.prepare('SELECT * FROM dose_logs WHERE user_id = ? ORDER BY taken_at').all(uid),
  };
  res.setHeader('Content-Disposition', `attachment; filename="meditrak-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
});

router.post('/profile/delete', (req, res) => {
  if (req.body.confirm !== 'DELETE') {
    req.flash('error', 'Type DELETE to confirm account deletion.');
    return res.redirect('/profile');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  req.session = null;
  res.redirect('/login');
});

module.exports = router;
