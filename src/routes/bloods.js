const router = require('express').Router();
const db = require('../db');
const u = require('../util');

const getType = (req, id) => {
  const t = db.prepare('SELECT * FROM blood_test_types WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  if (!t) throw u.notFound('Blood test type');
  return t;
};
const getTest = (req, id) => {
  const t = db.prepare('SELECT * FROM blood_tests WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  if (!t) throw u.notFound('Blood test');
  return t;
};
const activeTypes = (uid) => db.prepare('SELECT * FROM blood_test_types WHERE user_id = ? AND archived = 0 ORDER BY name COLLATE NOCASE').all(uid);

/** Results for one type, oldest first, in the shape the client chart reads */
const series = (typeId) =>
  db
    .prepare(
      `SELECT r.value, b.taken_on AS date, b.id AS test_id FROM blood_test_results r
       JOIN blood_tests b ON b.id = r.blood_test_id WHERE r.type_id = ? ORDER BY b.taken_on, b.id`
    )
    .all(typeId);

const chartData = (t, points) => ({ unit: t.unit || '', min: t.range_min, max: t.range_max, points: points.map((p) => [p.date, p.value]) });

/** 'low' / 'high' / '' against the type's reference range */
const flag = (t, v) => (t.range_min !== null && v < t.range_min ? 'low' : t.range_max !== null && v > t.range_max ? 'high' : '');

function parseType(b) {
  const v = {
    name: u.str(b.name),
    unit: u.str(b.unit),
    range_min: u.num(b.range_min),
    range_max: u.num(b.range_max),
    notes: u.str(b.notes),
  };
  const e = [];
  if (!v.name) e.push('Enter a name.');
  if (Number.isNaN(v.range_min)) e.push('Minimum must be a number.');
  if (Number.isNaN(v.range_max)) e.push('Maximum must be a number.');
  if (v.range_min !== null && v.range_max !== null && !(v.range_min < v.range_max)) e.push('Minimum must be below the maximum.');
  return { v, errors: e };
}

/** Form rows arrive as parallel type_id[] / value[] lists; blank rows are ignored */
function parseTest(req) {
  const b = req.body;
  const typeIds = [].concat(b.type_id ?? []);
  const values = [].concat(b.value ?? []);
  const owned = new Map(db.prepare('SELECT id, name FROM blood_test_types WHERE user_id = ?').all(req.user.id).map((t) => [t.id, t]));
  const rows = typeIds.map((id, i) => ({ type_id: u.str(id), value: u.str(values[i]) })).filter((r) => r.type_id || r.value);
  const v = { taken_on: u.str(b.taken_on), notes: u.str(b.notes), results: [] };
  const e = [];
  if (!u.isDate(v.taken_on)) e.push('Enter the date the blood was taken.');
  const seen = new Set();
  for (const r of rows) {
    const t = owned.get(Number(r.type_id));
    const n = u.num(r.value);
    if (!t) e.push('Choose a test for every result.');
    else if (seen.has(t.id)) e.push(`${t.name} is entered more than once.`);
    else if (n === null || Number.isNaN(n)) e.push(`Enter a number for ${t.name}.`);
    else v.results.push({ type_id: t.id, value: n });
    if (t) seen.add(t.id);
  }
  if (!rows.length) e.push('Add at least one result.');
  return { v, rows, errors: [...new Set(e)] };
}

function saveResults(testId, results) {
  db.prepare('DELETE FROM blood_test_results WHERE blood_test_id = ?').run(testId);
  const ins = db.prepare('INSERT INTO blood_test_results (blood_test_id, type_id, value) VALUES (?, ?, ?)');
  results.forEach((r) => ins.run(testId, r.type_id, r.value));
}

// ---- Overview: one chart per test type ------------------------------------
router.get('/bloods', (req, res) => {
  const types = activeTypes(req.user.id).map((t) => {
    const points = series(t.id);
    const latest = points[points.length - 1] || null;
    return { ...t, points, latest, latestFlag: latest ? flag(t, latest.value) : '', chart: chartData(t, points) };
  });
  const tests = db
    .prepare(
      `SELECT b.*, COUNT(r.id) AS n FROM blood_tests b LEFT JOIN blood_test_results r ON r.blood_test_id = b.id
       WHERE b.user_id = ? GROUP BY b.id ORDER BY b.taken_on DESC, b.id DESC LIMIT 20`
    )
    .all(req.user.id);
  res.render('bloods/index', { title: 'Blood tests', types, tests });
});

// ---- Recording a test (several results at once) ---------------------------
function renderTestForm(req, res, opts) {
  res.status(opts.error ? 400 : 200).render('bloods/form', { types: activeTypes(req.user.id), error: null, ...opts });
}

router.get('/bloods/new', (req, res) => {
  if (!activeTypes(req.user.id).length) {
    req.flash('info', 'Add the tests you have done first (e.g. Haemoglobin, g/L), then you can record results.');
    return res.redirect('/bloods/types/new?return_to=/bloods/new');
  }
  renderTestForm(req, res, { title: 'Record blood test', isNew: true, values: { taken_on: u.today(req.tz) }, rows: [{}] });
});

router.post('/bloods', (req, res) => {
  const { v, rows, errors } = parseTest(req);
  if (errors.length) return renderTestForm(req, res, { title: 'Record blood test', isNew: true, values: req.body, rows, error: errors.join(' ') });
  const id = db.transaction(() => {
    const id = db.prepare('INSERT INTO blood_tests (user_id, taken_on, notes) VALUES (?, ?, ?)').run(req.user.id, v.taken_on, v.notes).lastInsertRowid;
    saveResults(id, v.results);
    return id;
  })();
  req.flash('success', `${v.results.length} result${v.results.length === 1 ? '' : 's'} recorded for ${u.fmtDate(v.taken_on)}.`);
  res.redirect(`/bloods/${id}`);
});

router.get('/bloods/:id(\\d+)', (req, res) => {
  const test = getTest(req, req.params.id);
  const results = db
    .prepare(
      `SELECT r.value, t.* FROM blood_test_results r JOIN blood_test_types t ON t.id = r.type_id
       WHERE r.blood_test_id = ? ORDER BY t.name COLLATE NOCASE`
    )
    .all(test.id)
    .map((r) => ({ ...r, flag: flag(r, r.value) }));
  res.render('bloods/show', { title: `Bloods ${u.fmtDate(test.taken_on)}`, test, results });
});

router.get('/bloods/:id(\\d+)/edit', (req, res) => {
  const test = getTest(req, req.params.id);
  const rows = db.prepare('SELECT type_id, value FROM blood_test_results WHERE blood_test_id = ?').all(test.id);
  // Archived types already on this test stay selectable
  const types = db
    .prepare(
      `SELECT * FROM blood_test_types WHERE user_id = ? AND (archived = 0 OR id IN (SELECT type_id FROM blood_test_results WHERE blood_test_id = ?))
       ORDER BY name COLLATE NOCASE`
    )
    .all(req.user.id, test.id);
  renderTestForm(req, res, { title: 'Edit blood test', isNew: false, test, values: test, rows: rows.length ? rows : [{}], types });
});

router.post('/bloods/:id(\\d+)', (req, res) => {
  const test = getTest(req, req.params.id);
  const { v, rows, errors } = parseTest(req);
  if (errors.length) return renderTestForm(req, res, { title: 'Edit blood test', isNew: false, test, values: req.body, rows, error: errors.join(' ') });
  db.transaction(() => {
    db.prepare('UPDATE blood_tests SET taken_on = ?, notes = ? WHERE id = ?').run(v.taken_on, v.notes, test.id);
    saveResults(test.id, v.results);
  })();
  req.flash('success', 'Blood test saved.');
  res.redirect(`/bloods/${test.id}`);
});

router.post('/bloods/:id(\\d+)/delete', (req, res) => {
  const test = getTest(req, req.params.id);
  db.prepare('DELETE FROM blood_tests WHERE id = ?').run(test.id);
  req.flash('info', `Blood test from ${u.fmtDate(test.taken_on)} deleted.`);
  res.redirect('/bloods');
});

// ---- Test types -----------------------------------------------------------
router.get('/bloods/types', (req, res) => {
  const showArchived = req.query.archived === '1';
  const types = db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM blood_test_results r WHERE r.type_id = t.id) AS n
       FROM blood_test_types t WHERE t.user_id = ? AND t.archived = ? ORDER BY t.name COLLATE NOCASE`
    )
    .all(req.user.id, showArchived ? 1 : 0);
  res.render('bloods/types', { title: 'Blood test types', types, showArchived });
});

router.get('/bloods/types/new', (req, res) =>
  res.render('bloods/type_form', { title: 'Add blood test type', isNew: true, values: {}, returnTo: u.safeReturn(req.query.return_to, '') })
);

router.post('/bloods/types', (req, res) => {
  const { v, errors } = parseType(req.body);
  const returnTo = u.safeReturn(req.body.return_to, '');
  if (errors.length)
    return res.status(400).render('bloods/type_form', { title: 'Add blood test type', isNew: true, values: req.body, returnTo, error: errors.join(' ') });
  const id = db
    .prepare(
      `INSERT INTO blood_test_types (user_id, name, unit, range_min, range_max, notes)
       VALUES (@user_id, @name, @unit, @range_min, @range_max, @notes)`
    )
    .run({ ...v, user_id: req.user.id }).lastInsertRowid;
  req.flash('success', `${v.name} added.`);
  res.redirect(returnTo || `/bloods/types/${id}`);
});

router.get('/bloods/types/:id(\\d+)', (req, res) => {
  const t = getType(req, req.params.id);
  const points = series(t.id).map((p) => ({ ...p, flag: flag(t, p.value) }));
  res.render('bloods/type_show', { title: t.name, t, points, chart: chartData(t, points) });
});

router.get('/bloods/types/:id(\\d+)/edit', (req, res) => {
  const t = getType(req, req.params.id);
  res.render('bloods/type_form', { title: `Edit ${t.name}`, isNew: false, values: t, t, returnTo: '' });
});

router.post('/bloods/types/:id(\\d+)', (req, res) => {
  const t = getType(req, req.params.id);
  const { v, errors } = parseType(req.body);
  if (errors.length)
    return res.status(400).render('bloods/type_form', { title: `Edit ${t.name}`, isNew: false, t, values: req.body, returnTo: '', error: errors.join(' ') });
  db.prepare('UPDATE blood_test_types SET name=@name, unit=@unit, range_min=@range_min, range_max=@range_max, notes=@notes WHERE id=@id').run({ ...v, id: t.id });
  req.flash('success', 'Blood test type saved.');
  res.redirect(`/bloods/types/${t.id}`);
});

router.post('/bloods/types/:id(\\d+)/archive', (req, res) => {
  const t = getType(req, req.params.id);
  db.prepare('UPDATE blood_test_types SET archived = ? WHERE id = ?').run(t.archived ? 0 : 1, t.id);
  req.flash('info', t.archived ? `${t.name} restored.` : `${t.name} archived. Its results are kept.`);
  res.redirect(`/bloods/types/${t.id}`);
});

router.post('/bloods/types/:id(\\d+)/delete', (req, res) => {
  const t = getType(req, req.params.id);
  db.transaction(() => {
    db.prepare('DELETE FROM blood_test_types WHERE id = ?').run(t.id);
    // Drop any blood test left with no results
    db.prepare('DELETE FROM blood_tests WHERE user_id = ? AND id NOT IN (SELECT blood_test_id FROM blood_test_results)').run(req.user.id);
  })();
  req.flash('info', `${t.name} and its results deleted.`);
  res.redirect('/bloods/types');
});

module.exports = router;
