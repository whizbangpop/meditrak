const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { DateTime } = require('luxon');
const db = require('./db');
const config = require('./config');
const { occurrencesBetween } = require('./schedule');
const { doseText } = require('./util');

// VAPID keys: from env, or generated once and stored in the data folder
function loadVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const file = path.join(config.dataDir, 'vapid.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}
const vapid = loadVapid();
webpush.setVapidDetails(config.vapidSubject, vapid.publicKey, vapid.privateKey);

const publicKey = () => vapid.publicKey;

// Signed tokens let the "Mark taken" notification button log a dose without a CSRF token
function signAction(data) {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyAction(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

async function sendToUser(userId, payload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 6, urgency: 'high' }
      );
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      } else {
        console.warn(`[push] send failed (${err.statusCode || err.message})`);
      }
    }
  }
  return sent;
}

const dueStmt = () =>
  db.prepare(`
    SELECT s.*, m.name AS med_name, m.form, m.strength, m.strength_unit, m.id AS med_id,
           m.user_id, p.timezone, p.reminder_followup_minutes
    FROM schedules s
    JOIN medications m ON m.id = s.medication_id
    JOIN profiles p ON p.user_id = m.user_id
    WHERE s.active = 1 AND s.notify = 1 AND m.archived = 0 AND s.frequency != 'as_needed'
      AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = m.user_id)`);

let lastRun = DateTime.utc().minus({ minutes: 1 });

async function tick() {
  const now = DateTime.utc();
  const from = DateTime.max(lastRun, now.minus({ minutes: 10 }));
  lastRun = now;
  const logged = db.prepare('SELECT 1 FROM dose_logs WHERE schedule_id = ? AND scheduled_for = ?');
  const mark = db.prepare(
    'INSERT OR IGNORE INTO notification_log (schedule_id, scheduled_for, kind, sent_at) VALUES (?, ?, ?, ?)'
  );

  for (const s of dueStmt().all()) {
    const tz = s.timezone || 'UTC';
    const med = { id: s.med_id, name: s.med_name, form: s.form, strength: s.strength, strength_unit: s.strength_unit };
    const jobs = occurrencesBetween(s, from, now, tz).map((at) => ({ at, kind: 'due' }));
    const fu = s.reminder_followup_minutes;
    if (fu > 0) {
      for (const at of occurrencesBetween(s, from.minus({ minutes: fu }), now.minus({ minutes: fu }), tz)) {
        jobs.push({ at, kind: 'followup' });
      }
    }
    for (const { at, kind } of jobs) {
      const key = at.toUTC().toISO();
      if (logged.get(s.id, key)) continue;
      if (!mark.run(s.id, key, kind, now.toISO()).changes) continue;
      const token = signAction({ u: s.user_id, s: s.id, t: key, exp: Date.now() + 3 * 24 * 3600 * 1000 });
      await sendToUser(s.user_id, {
        title: kind === 'followup' ? `Reminder: ${med.name} not logged yet` : `Time for ${med.name}`,
        body: `${doseText(med, s.dose)} · due ${at.toFormat('HH:mm')}`,
        tag: `dose-${s.id}-${key}`,
        url: '/',
        token,
      });
    }
  }
}

function startScheduler() {
  const run = () => tick().catch((e) => console.error('[push] scheduler error', e));
  setInterval(run, 30 * 1000);
  run();
}

module.exports = { publicKey, sendToUser, signAction, verifyAction, startScheduler };
