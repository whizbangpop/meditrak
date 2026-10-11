const { DateTime } = require('luxon');
const db = require('./db');
const { dosesPerDay } = require('./schedule');

const round = (n) => Math.round(n * 10000) / 10000;

/** Amount of medicine (strength unit) in one stock unit: per tablet, or per ml for vials */
function perUnit(med, item) {
  return med.form === 'vial' ? item.concentration || 0 : med.strength;
}
const isExpired = (item, today) => !!item.expiry_date && item.expiry_date < today;

/** Active stock, in the order it will be used: opened items first, then earliest expiry */
function activeItems(medId) {
  return db
    .prepare(
      `SELECT * FROM stock_items WHERE medication_id = ? AND status = 'active'
       ORDER BY (opened_at IS NULL), (expiry_date IS NULL), expiry_date, id`
    )
    .all(medId);
}

function stockSummary(med, schedules, today, warnDays = 30) {
  const items = activeItems(med.id);
  const usable = items.filter((i) => !isExpired(i, today) && i.remaining > 0);
  const units = usable.reduce((a, i) => a + i.remaining, 0);
  const amount = usable.reduce((a, i) => a + i.remaining * perUnit(med, i), 0);
  const perDay = schedules.reduce((a, s) => a + dosesPerDay(s, today) * s.dose, 0);
  const daysLeft = perDay > 0 ? amount / perDay : null;
  const expired = items.filter((i) => isExpired(i, today));
  const warnDate = DateTime.fromISO(today).plus({ days: warnDays }).toISODate();
  const expiringSoon = usable.filter((i) => i.expiry_date && i.expiry_date <= warnDate);
  const nextExpiry = usable.map((i) => i.expiry_date).filter(Boolean).sort()[0] || null;
  const low = med.low_stock_threshold != null && units <= med.low_stock_threshold;
  const currentConcentration = med.form === 'vial' ? usable[0]?.concentration || med.strength : null;
  return { items, usable, units, amount, perDay, daysLeft, expired, expiringSoon, nextExpiry, low, currentConcentration };
}

function linkedDisposables(medId) {
  return db
    .prepare(
      `SELECT d.*, md.quantity_per_dose FROM medication_disposables md
       JOIN disposables d ON d.id = md.disposable_id
       WHERE md.medication_id = ? ORDER BY d.name`
    )
    .all(medId);
}

/**
 * Log a dose as taken and deduct it from stock (spilling across boxes/vials if needed)
 * and from any disposables passed in. Returns { logId, shortfall } where shortfall is the
 * amount (in strength units) that could not be covered by usable stock.
 */
function recordDose({ userId, med, scheduleId = null, scheduledFor = null, dose, takenAt, stockItemId = null, disposables = [], notes = null, today }) {
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO dose_logs (user_id, medication_id, schedule_id, scheduled_for, status, dose, taken_at, notes, created_at)
         VALUES (?, ?, ?, ?, 'taken', ?, ?, ?, ?)`
      )
      .run(userId, med.id, scheduleId, scheduledFor, dose, takenAt, notes, new Date().toISOString());
    const logId = info.lastInsertRowid;

    let items = activeItems(med.id).filter((i) => i.remaining > 0 && !isExpired(i, today) && perUnit(med, i) > 0);
    if (stockItemId) items.sort((a, b) => (b.id === stockItemId) - (a.id === stockItemId));

    const upd = db.prepare(
      `UPDATE stock_items SET remaining = ?, status = ?, opened_at = COALESCE(opened_at, ?) WHERE id = ?`
    );
    const use = db.prepare(`INSERT INTO dose_stock_usage (dose_log_id, stock_item_id, amount) VALUES (?, ?, ?)`);

    let left = dose;
    for (const it of items) {
      if (left <= 1e-9) break;
      const per = perUnit(med, it);
      const take = Math.min(it.remaining * per, left);
      const units = take / per;
      const rem = Math.max(0, round(it.remaining - units));
      upd.run(rem, rem <= 1e-6 ? 'finished' : 'active', takenAt, it.id);
      use.run(logId, it.id, units);
      left -= take;
    }
    const shortfall = left > 1e-6 ? round(left) : 0;
    if (shortfall) db.prepare('UPDATE dose_logs SET shortfall = ? WHERE id = ?').run(shortfall, logId);

    const decDisp = db.prepare('UPDATE disposables SET quantity = quantity - ? WHERE id = ? AND user_id = ?');
    const txn = db.prepare(
      `INSERT INTO disposable_transactions (disposable_id, change, reason, dose_log_id, note, created_at)
       VALUES (?, ?, 'dose', ?, ?, ?)`
    );
    for (const d of disposables) {
      if (!(d.quantity > 0)) continue;
      const r = decDisp.run(d.quantity, d.id, userId);
      if (r.changes) txn.run(d.id, -d.quantity, logId, `Used with ${med.name}`, takenAt);
    }
    return { logId, shortfall };
  })();
}

function recordSkip({ userId, med, scheduleId, scheduledFor, reason = null, notes = null }) {
  const now = new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO dose_logs (user_id, medication_id, schedule_id, scheduled_for, status, dose, taken_at, reason, notes, created_at)
       VALUES (?, ?, ?, ?, 'skipped', NULL, ?, ?, ?, ?)`
    )
    .run(userId, med.id, scheduleId, scheduledFor, now, reason, notes, now).lastInsertRowid;
}

/** Remove a log entry and put back any stock / disposables it used */
function undoDose(logId, userId) {
  return db.transaction(() => {
    const log = db.prepare('SELECT * FROM dose_logs WHERE id = ? AND user_id = ?').get(logId, userId);
    if (!log) return null;
    for (const u of db.prepare('SELECT * FROM dose_stock_usage WHERE dose_log_id = ?').all(logId)) {
      db.prepare(
        `UPDATE stock_items SET remaining = remaining + ?,
           status = CASE WHEN status = 'finished' THEN 'active' ELSE status END WHERE id = ?`
      ).run(u.amount, u.stock_item_id);
    }
    for (const t of db
      .prepare(`SELECT * FROM disposable_transactions WHERE dose_log_id = ? AND reason = 'dose'`)
      .all(logId)) {
      db.prepare('UPDATE disposables SET quantity = quantity - ? WHERE id = ?').run(t.change, t.disposable_id);
      db.prepare('DELETE FROM disposable_transactions WHERE id = ?').run(t.id);
    }
    db.prepare('DELETE FROM dose_logs WHERE id = ?').run(logId);
    return log;
  })();
}

module.exports = { perUnit, isExpired, activeItems, stockSummary, linkedDisposables, recordDose, recordSkip, undoDose };
