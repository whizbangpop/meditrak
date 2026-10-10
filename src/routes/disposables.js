const router = require('express').Router();
const db = require('../db');
const u = require('../util');

const getDisp = (req, id) => {
  const d = db.prepare('SELECT * FROM disposables WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  if (!d) throw u.notFound('Supply');
  return d;
};

function parseDisp(b) {
  const v = {
    name: u.str(b.name),
    category: u.str(b.category),
    unit: u.str(b.unit) || 'items',
    low_stock_threshold: u.num(b.low_stock_threshold),
    notes: u.str(b.notes),
    quantity: u.num(b.quantity) ?? 0,
  };
  const e = [];
  if (!v.name) e.push('Enter a name.');
  if (v.low_stock_threshold !== null && !(v.low_stock_threshold >= 0)) e.push('Low stock level must be zero or more.');
  if (!(v.quantity >= 0)) e.push('Starting quantity must be zero or more.');
  return { v, errors: e };
}

const txn = (id, change, reason, extra = {}) =>
  db
    .prepare(
      `INSERT INTO disposable_transactions (disposable_id, change, reason, batch, expiry_date, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, change, reason, extra.batch || null, extra.expiry_date || null, extra.note || null, new Date().toISOString());

router.get('/disposables', (req, res) => {
  const showArchived = req.query.archived === '1';
  const items = db
    .prepare(
      `SELECT d.*, (SELECT GROUP_CONCAT(m.name, ', ') FROM medication_disposables md JOIN medications m ON m.id = md.medication_id
         WHERE md.disposable_id = d.id) AS used_with
       FROM disposables d WHERE d.user_id = ? AND d.archived = ? ORDER BY d.category, d.name`
    )
    .all(req.user.id, showArchived ? 1 : 0);
  res.render('disposables/index', { title: 'Supplies', items, showArchived });
});

router.get('/disposables/new', (req, res) =>
  res.render('disposables/form', { title: 'Add supply', isNew: true, values: { unit: 'items', quantity: 0 } })
);

router.post('/disposables', (req, res) => {
  const { v, errors } = parseDisp(req.body);
  if (errors.length) return res.status(400).render('disposables/form', { title: 'Add supply', isNew: true, values: req.body, error: errors.join(' ') });
  const id = db.transaction(() => {
    const id = db
      .prepare(
        `INSERT INTO disposables (user_id, name, category, unit, quantity, low_stock_threshold, notes)
         VALUES (@user_id, @name, @category, @unit, @quantity, @low_stock_threshold, @notes)`
      )
      .run({ ...v, user_id: req.user.id }).lastInsertRowid;
    if (v.quantity > 0) txn(id, v.quantity, 'restock', { note: 'Opening stock' });
    return id;
  })();
  req.flash('success', `${v.name} added. Link it to a medication to have it used automatically.`);
  res.redirect(`/disposables/${id}`);
});

router.get('/disposables/:id', (req, res) => {
  const d = getDisp(req, req.params.id);
  const txns = db
    .prepare(
      `SELECT t.*, m.name AS med_name FROM disposable_transactions t
       LEFT JOIN dose_logs dl ON dl.id = t.dose_log_id LEFT JOIN medications m ON m.id = dl.medication_id
       WHERE t.disposable_id = ? ORDER BY t.created_at DESC LIMIT 100`
    )
    .all(d.id);
  const links = db
    .prepare(
      `SELECT m.id, m.name, md.quantity_per_dose FROM medication_disposables md JOIN medications m ON m.id = md.medication_id
       WHERE md.disposable_id = ? ORDER BY m.name`
    )
    .all(d.id);
  res.render('disposables/show', { title: d.name, d, txns, links, today: u.today(req.tz) });
});

router.get('/disposables/:id/edit', (req, res) => {
  const d = getDisp(req, req.params.id);
  res.render('disposables/form', { title: `Edit ${d.name}`, isNew: false, values: d, d });
});

router.post('/disposables/:id', (req, res) => {
  const d = getDisp(req, req.params.id);
  const { v, errors } = parseDisp({ ...req.body, quantity: d.quantity });
  if (errors.length)
    return res.status(400).render('disposables/form', { title: `Edit ${d.name}`, isNew: false, d, values: { ...req.body, id: d.id }, error: errors.join(' ') });
  db.prepare('UPDATE disposables SET name=@name, category=@category, unit=@unit, low_stock_threshold=@low_stock_threshold, notes=@notes WHERE id=@id').run({
    ...v,
    id: d.id,
  });
  req.flash('success', 'Supply saved.');
  res.redirect(`/disposables/${d.id}`);
});

router.post('/disposables/:id/restock', (req, res) => {
  const d = getDisp(req, req.params.id);
  const qty = u.num(req.body.quantity);
  const expiry = u.str(req.body.expiry_date);
  if (!(qty > 0) || (expiry && !u.isDate(expiry))) {
    req.flash('error', 'Enter a quantity above zero and a valid expiry date (if any).');
    return res.redirect(`/disposables/${d.id}`);
  }
  db.transaction(() => {
    db.prepare('UPDATE disposables SET quantity = quantity + ? WHERE id = ?').run(qty, d.id);
    txn(d.id, qty, 'restock', { batch: u.str(req.body.batch), expiry_date: expiry, note: u.str(req.body.note) });
  })();
  req.flash('success', `Added ${u.fmtNum(qty)} ${d.unit} of ${d.name}.`);
  res.redirect(`/disposables/${d.id}`);
});

router.post('/disposables/:id/use', (req, res) => {
  const d = getDisp(req, req.params.id);
  const qty = u.num(req.body.quantity) ?? 1;
  if (!(qty > 0)) {
    req.flash('error', 'Enter a quantity above zero.');
    return res.redirect(u.safeReturn(req.body.return_to, `/disposables/${d.id}`));
  }
  db.transaction(() => {
    db.prepare('UPDATE disposables SET quantity = quantity - ? WHERE id = ?').run(qty, d.id);
    txn(d.id, -qty, 'manual', { note: u.str(req.body.note) });
  })();
  req.flash('success', `Used ${u.fmtNum(qty)} ${d.unit} of ${d.name}.`);
  res.redirect(u.safeReturn(req.body.return_to, `/disposables/${d.id}`));
});

router.post('/disposables/:id/adjust', (req, res) => {
  const d = getDisp(req, req.params.id);
  const count = u.num(req.body.quantity);
  if (!(count >= 0)) {
    req.flash('error', 'Enter the actual count (zero or more).');
    return res.redirect(`/disposables/${d.id}`);
  }
  const change = count - d.quantity;
  if (change !== 0)
    db.transaction(() => {
      db.prepare('UPDATE disposables SET quantity = ? WHERE id = ?').run(count, d.id);
      txn(d.id, change, 'adjustment', { note: u.str(req.body.note) || 'Stock count correction' });
    })();
  req.flash('success', `Count set to ${u.fmtNum(count)}.`);
  res.redirect(`/disposables/${d.id}`);
});

router.post('/disposables/:id/archive', (req, res) => {
  const d = getDisp(req, req.params.id);
  db.prepare('UPDATE disposables SET archived = ? WHERE id = ?').run(d.archived ? 0 : 1, d.id);
  req.flash('info', d.archived ? `${d.name} restored.` : `${d.name} archived.`);
  res.redirect(`/disposables/${d.id}`);
});

router.post('/disposables/:id/delete', (req, res) => {
  const d = getDisp(req, req.params.id);
  db.prepare('DELETE FROM disposables WHERE id = ?').run(d.id);
  req.flash('info', `${d.name} deleted.`);
  res.redirect('/disposables');
});

module.exports = router;
