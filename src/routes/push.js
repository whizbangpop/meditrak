const router = require('express').Router();
const db = require('../db');
const push = require('../push');
const stock = require('../stock');
const { asyncHandler, today, doseText } = require('../util');

const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Not signed in' }));

router.get('/push/key', (req, res) => res.json({ key: push.publicKey() }));

router.post('/push/subscribe', requireUser, (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(req.user.id, endpoint, keys.p256dh, keys.auth, (req.get('user-agent') || '').slice(0, 300));
  res.json({ ok: true });
});

router.post('/push/unsubscribe', requireUser, (req, res) => {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(req.body?.endpoint, req.user.id);
  res.json({ ok: true });
});

router.post(
  '/push/test',
  requireUser,
  asyncHandler(async (req, res) => {
    const sent = await push.sendToUser(req.user.id, {
      title: 'Meditrak test',
      body: 'Notifications are working on this device.',
      tag: 'test',
      url: '/profile',
    });
    res.json({ ok: sent > 0, sent });
  })
);

// Called by the service worker when "Mark taken" is pressed on a notification
router.post('/push-action', (req, res) => {
  const data = push.verifyAction(req.body?.token);
  if (!data) return res.status(400).json({ ok: false, message: 'This reminder has expired. Open Meditrak to log it.' });
  const row = db
    .prepare(
      `SELECT s.*, m.user_id FROM schedules s JOIN medications m ON m.id = s.medication_id WHERE s.id = ? AND m.user_id = ?`
    )
    .get(data.s, data.u);
  if (!row) return res.status(404).json({ ok: false, message: 'Schedule not found.' });
  const med = db.prepare('SELECT * FROM medications WHERE id = ?').get(row.medication_id);
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(data.u);
  if (db.prepare('SELECT 1 FROM dose_logs WHERE schedule_id = ? AND scheduled_for = ?').get(row.id, data.t)) {
    return res.json({ ok: true, message: `${med.name} was already logged.` });
  }
  const disposables = stock.linkedDisposables(med.id).map((d) => ({ id: d.id, quantity: d.quantity_per_dose }));
  const { shortfall } = stock.recordDose({
    userId: data.u,
    med,
    scheduleId: row.id,
    scheduledFor: data.t,
    dose: row.dose,
    takenAt: new Date().toISOString(),
    disposables,
    today: today(profile?.timezone),
  });
  res.json({
    ok: true,
    message: `${med.name} ${doseText(med, row.dose)} logged.` + (shortfall ? ' Warning: not enough stock recorded.' : ''),
  });
});

module.exports = router;
