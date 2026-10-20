(function () {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const csrf = $('meta[name="csrf-token"]')?.content;
  const fmt = (n, dp = 3) => String(Number(Number(n).toFixed(dp)));

  // ---- Service worker -------------------------------------------------------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW registration failed', e));
  }

  // ---- Confirmation prompts -----------------------------------------------
  document.addEventListener('submit', (e) => {
    const msg = e.target.dataset.confirm;
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // auto-submit filters
  $$('form[data-autosubmit] select').forEach((s) => s.addEventListener('change', () => s.form.submit()));

  // ---- Profile: detect time zone on first setup ----------------------------
  const tzSel = $('[data-autodetect-tz]');
  if (tzSel) {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if ([...tzSel.options].some((o) => o.value === zone)) tzSel.value = zone;
    } catch (_) {}
  }

  // ---- Medication form ------------------------------------------------------
  const medForm = $('#med-form');
  if (medForm) {
    const strength = medForm.elements.strength;
    const dd = $('[data-default-dose]', medForm);
    let ddTouched = !!dd.value && dd.value !== strength.value;
    dd.addEventListener('input', () => (ddTouched = true));
    const update = () => {
      const form = medForm.querySelector('input[name=form]:checked')?.value || 'tablet';
      const vial = form === 'vial';
      $$('[data-label-vial]', medForm).forEach((el) => (el.hidden = !vial));
      $$('[data-label-solid]', medForm).forEach((el) => (el.hidden = vial));
      $$('[data-form-name]', medForm).forEach((el) => (el.textContent = form));
      $('[data-stock-unit]', medForm).textContent = vial ? 'ml' : form + 's';
      $('[data-unit-label]', medForm).textContent = medForm.elements.strength_unit.value;
      dd.required = vial;
      if (!vial && !ddTouched) dd.value = strength.value;
    };
    medForm.addEventListener('input', update);
    medForm.addEventListener('change', update);
    update();
  }

  // ---- Dose preview (schedule + take forms) ---------------------------------
  function dosePreview(form) {
    const input = $('[data-dose-input]', form);
    const out = $('[data-dose-preview]', form);
    if (!input || !out) return;
    const kind = form.dataset.form;
    const strength = Number(form.dataset.strength);
    const update = () => {
      const dose = Number(input.value);
      if (!(dose > 0)) return (out.textContent = '');
      if (kind === 'vial') {
        const sel = $('[data-stock-select]', form);
        const opt = sel && sel.selectedOptions[0];
        const conc = Number((opt && opt.dataset.conc) || form.dataset.conc || strength);
        out.textContent = conc > 0 ? `≈ ${fmt(dose / conc)} ml at ${fmt(conc)} ${form.dataset.unit}/ml` : '';
      } else {
        const n = dose / strength;
        out.textContent = `= ${fmt(n, 2)} ${kind}${n === 1 ? '' : 's'} of ${fmt(strength)} ${form.dataset.unit}`;
      }
    };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    update();
  }
  $$('#schedule-form, #take-form').forEach(dosePreview);

  // ---- Schedule form --------------------------------------------------------
  const sf = $('#schedule-form');
  if (sf) {
    const freq = $('[data-frequency]', sf);
    const toggle = () => {
      $$('[data-show-for]', sf).forEach((el) => {
        const show = el.dataset.showFor.split(' ').includes(freq.value);
        el.hidden = !show;
        $$('input, select', el).forEach((i) => (i.disabled = !show));
      });
    };
    freq.addEventListener('change', toggle);
    toggle();
    const times = $('[data-times]', sf);
    const tpl = $('#time-row-tpl');
    $('[data-add-time]', sf).addEventListener('click', () => {
      times.appendChild(tpl.content.cloneNode(true));
      times.lastElementChild.querySelector('input').focus();
    });
    times.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove-time]') && times.children.length > 1) e.target.closest('.time-row').remove();
    });
  }

  // ---- Blood test form: rows of test + result -------------------------------
  const bf = $('#blood-form');
  if (bf) {
    const list = $('[data-results]', bf);
    const tpl = $('#result-row-tpl');
    const syncUnit = (row) => {
      const opt = $('[data-result-type]', row).selectedOptions[0];
      $('[data-result-unit]', row).textContent = (opt && opt.dataset.unit) || '';
    };
    $('[data-add-result]', bf).addEventListener('click', () => {
      list.appendChild(tpl.content.cloneNode(true));
      list.lastElementChild.querySelector('select').focus();
    });
    list.addEventListener('change', (e) => {
      if (e.target.matches('[data-result-type]')) {
        syncUnit(e.target.closest('.result-row'));
        e.target.closest('.result-row').querySelector('input').focus();
      }
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-remove-result]')?.closest('.result-row');
      if (!row) return;
      if (list.children.length > 1) row.remove();
      else {
        row.querySelector('select').value = '';
        row.querySelector('input').value = '';
        syncUnit(row);
      }
    });
  }

  // ---- Blood result charts (SVG drawn at the real pixel width) --------------
  const SVGNS = 'http://www.w3.org/2000/svg';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY = 864e5;
  const parseDay = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const fmtDay = (t, year = true) => {
    const d = new Date(t);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ' ' + String(d.getUTCFullYear()).slice(2) : ''}`;
  };
  function el(name, attrs, parent, text) {
    const n = document.createElementNS(SVGNS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  /** ~count "nice" ticks (1/2/5 × 10^n) covering [lo, hi] */
  function niceTicks(lo, hi, count) {
    const raw = (hi - lo) / Math.max(count, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
    return ticks;
  }

  function drawBloodChart(box) {
    const data = JSON.parse(box.dataset.bloodChart);
    const pts = data.points.map(([d, v]) => ({ t: parseDay(d), v, d }));
    const W = Math.max(box.clientWidth, 240);
    const H = box.classList.contains('blood-chart-lg') ? Math.min(Math.max(W * 0.5, 220), 340) : Math.min(Math.max(W * 0.38, 170), 230);
    const hasMin = data.min !== null && data.min !== undefined;
    const hasMax = data.max !== null && data.max !== undefined;

    // Y domain: the results plus any range limits, with some headroom
    const vals = pts.map((p) => p.v).concat(hasMin ? [data.min] : [], hasMax ? [data.max] : []);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = hi === lo ? Math.abs(hi) * 0.2 || 1 : (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
    if (Math.min(...vals) >= 0 && lo < 0) lo = 0;
    const yTicks = niceTicks(lo, hi, H > 220 ? 5 : 4);
    lo = Math.min(lo, yTicks[0]);
    hi = Math.max(hi, yTicks[yTicks.length - 1]);

    // X domain: by date; a lone result sits in the middle of a month-wide window
    let t0 = pts[0].t;
    let t1 = pts[pts.length - 1].t;
    if (t1 - t0 < DAY) {
      t0 -= 15 * DAY;
      t1 += 15 * DAY;
    }
    const tickW = Math.max(...yTicks.map((v) => fmt(v).length)) * 7 + 10;
    // Range limit labels sit in a right-hand gutter so they never cover a point
    const limitLabels = [hasMax && `Max ${fmt(data.max)}`, hasMin && `Min ${fmt(data.min)}`].filter(Boolean);
    const m = { l: tickW, r: limitLabels.length ? Math.max(...limitLabels.map((s) => s.length)) * 6.6 + 12 : 14, t: 14, b: 26 };
    const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'bchart', 'aria-hidden': 'true' });

    if (hasMin && hasMax) el('rect', { x: m.l, y: y(data.max), width: W - m.l - m.r, height: y(data.min) - y(data.max), class: 'bc-band' }, svg);
    yTicks.forEach((v) => {
      el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'bc-grid' }, svg);
      el('text', { x: m.l - 6, y: y(v) + 4, class: 'bc-tick', 'text-anchor': 'end' }, svg, fmt(v));
    });

    const spanYears = new Date(t0).getUTCFullYear() !== new Date(t1).getUTCFullYear();
    const nX = Math.max(2, Math.min(6, Math.floor((W - m.l - m.r) / 90)));
    const xTicks = pts.length <= nX ? pts.map((p) => p.t) : Array.from({ length: nX }, (_, i) => t0 + ((t1 - t0) * i) / (nX - 1));
    xTicks.forEach((t, i) => {
      const anchor = xTicks.length > 1 && i === 0 && x(t) - m.l < 30 ? 'start' : xTicks.length > 1 && i === xTicks.length - 1 && W - m.r - x(t) < 30 ? 'end' : 'middle';
      el('text', { x: x(t), y: H - 8, class: 'bc-tick', 'text-anchor': anchor }, svg, fmtDay(t, spanYears || pts.length === 1));
    });

    // Reference range marker lines
    const marker = (v, label, dy) => {
      el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'bc-limit' }, svg);
      el('text', { x: W - m.r + 6, y: y(v) + 4 + dy, class: 'bc-limit-label' }, svg, label);
    };
    // Nudge the labels apart when the range is narrow on screen
    const gap = hasMin && hasMax ? Math.max(0, 13 - (y(data.min) - y(data.max))) / 2 : 0;
    if (hasMax) marker(data.max, limitLabels[0], -gap);
    if (hasMin) marker(data.min, limitLabels[limitLabels.length - 1], gap);

    if (pts.length > 1) el('polyline', { points: pts.map((p) => `${x(p.t)},${y(p.v)}`).join(' '), class: 'bc-line' }, svg);
    pts.forEach((p) => {
      const out = (hasMin && p.v < data.min) || (hasMax && p.v > data.max);
      const g = el('g', { class: 'bc-pt' + (out ? ' out' : '') }, svg);
      el('circle', { cx: x(p.t), cy: y(p.v), r: 4.5 }, g);
      el('circle', { cx: x(p.t), cy: y(p.v), r: 14, class: 'bc-hit' }, g);
      el('title', {}, g, `${fmt(p.v)} ${data.unit} · ${fmtDay(p.t)}${out ? (hasMin && p.v < data.min ? ' · below range' : ' · above range') : ''}`);
    });

    box.replaceChildren(svg);
  }
  const charts = $$('[data-blood-chart]');
  if (charts.length) {
    charts.forEach(drawBloodChart);
    let lastW = window.innerWidth;
    window.addEventListener('resize', () => {
      if (window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      charts.forEach(drawBloodChart);
    });
  }

  // ---- Install prompt (Android/Chrome) --------------------------------------
  let deferredPrompt = null;
  const installBtn = $('[data-install]');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });
  installBtn?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.hidden = true;
  });

  // ---- Push notifications ---------------------------------------------------
  const box = $('#push-box');
  if (box) setupPush(box);

  function b64ToUint8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  const post = (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
    }).then((r) => r.json());

  async function setupPush(box) {
    const status = $('[data-status]', box);
    const btn = (n) => $(`[data-push="${n}"]`, box);
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      status.textContent = 'Notifications are not supported here. On iPhone/iPad, add Meditrak to your Home Screen and open it from there.';
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const render = () => {
      const denied = Notification.permission === 'denied';
      status.textContent = denied
        ? 'Notifications are blocked for this site. Allow them in your browser/phone settings.'
        : sub
          ? 'Reminders are on for this device.'
          : 'Reminders are off for this device.';
      btn('enable').hidden = !!sub || denied;
      btn('test').hidden = !sub;
      btn('disable').hidden = !sub;
    };
    render();
    btn('enable').addEventListener('click', async () => {
      try {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return render();
        const { key } = await fetch('/api/push/key').then((r) => r.json());
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) });
        await post('/api/push/subscribe', sub.toJSON());
      } catch (e) {
        status.textContent = 'Could not enable notifications: ' + e.message;
        return;
      }
      render();
    });
    btn('disable').addEventListener('click', async () => {
      if (sub) {
        await post('/api/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
        sub = null;
      }
      render();
    });
    btn('test').addEventListener('click', async () => {
      const r = await post('/api/push/test');
      status.textContent = r.ok ? 'Test sent — it should arrive in a few seconds.' : 'Test failed — try turning reminders off and on again.';
    });
  }
})();
