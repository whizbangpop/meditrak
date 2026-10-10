/* Meditrak service worker: offline shell, caching of static assets, push reminders */
const CACHE = 'meditrak-v2';
const ASSETS = [
  '/offline.html',
  '/css/app.css',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/badge-72.png',
  '/fonts/outfit-latin-wght-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Pages: always fresh from the server (health data shouldn't be stale); offline page as fallback
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // Static assets: stale-while-revalidate
  if (/^\/(css|js|icons|fonts)\//.test(url.pathname) || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'Meditrak', body: event.data && event.data.text() };
  }
  const options = {
    body: data.body || '',
    tag: data.tag,
    renotify: !!data.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: { url: data.url || '/', token: data.token },
    requireInteraction: !!data.token,
    actions: data.token
      ? [
          { action: 'take', title: 'Mark taken' },
          { action: 'open', title: 'Open' },
        ]
      : [],
  };
  event.waitUntil(self.registration.showNotification(data.title || 'Meditrak', options));
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();

  if (event.action === 'take' && data.token) {
    event.waitUntil(
      fetch('/api/push-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: data.token, action: 'take' }),
        credentials: 'same-origin',
      })
        .then((r) => r.json())
        .catch(() => ({ ok: false, message: 'Could not reach Meditrak. Open the app to log it.' }))
        .then((j) =>
          self.registration.showNotification(j.ok ? 'Dose logged' : 'Not logged', {
            body: j.message || '',
            tag: 'meditrak-ack',
            icon: '/icons/icon-192.png',
            badge: '/icons/badge-72.png',
          })
        )
    );
    return;
  }

  const target = new URL(data.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.location.origin) && 'focus' in w) {
          w.navigate(target);
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
