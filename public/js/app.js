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
