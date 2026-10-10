const config = require('./config');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const db = require('./db');
const util = require('./util');
const push = require('./push');

const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        'script-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'form-action': null, // logout redirects to the identity provider
        'upgrade-insecure-requests': null,
      },
    },
    strictTransportSecurity: config.secureCookies,
  })
);

app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res, p) {
      if (p.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Service-Worker-Allowed', '/');
      }
      if (p.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
    },
  })
);
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(express.json({ limit: '50kb' }));
app.use(
  cookieSession({
    name: 'medtrack.sid',
    keys: [config.sessionSecret],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: config.secureCookies,
    httpOnly: true,
  })
);

// Load user/profile, CSRF token, flash messages and view helpers
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  res.locals.csrf = `<input type="hidden" name="_csrf" value="${req.session.csrf}">`;
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) req.session.flash = null;
  req.flash = (type, message) => {
    req.session.flash = { type, message };
  };
  Object.assign(res.locals, { user: null, profile: null, title: null, currentPath: req.path, u: util, tz: 'UTC' });
  req.tz = 'UTC';

  if (req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      req.user = res.locals.user = user;
      const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(user.id);
      req.profile = res.locals.profile = profile || null;
      if (profile) req.tz = res.locals.tz = profile.timezone || 'UTC';
    } else {
      req.session.userId = null;
    }
  }
  next();
});

// CSRF protection for all form/API posts (notification actions use a signed token instead)
app.use((req, res, next) => {
  if (req.method !== 'POST' || req.path === '/api/push-action') return next();
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!util.safeEqual(token, req.session.csrf)) {
    return res.status(403).render('error', {
      title: 'Session expired',
      message: 'This form was stale or your session expired. Go back, refresh the page and try again.',
    });
  }
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(require('./auth'));
app.use('/api', require('./routes/push'));

// Everything below needs a signed-in user with a profile
app.use((req, res, next) => {
  if (req.user) return next();
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  res.redirect('/login');
});
app.use((req, res, next) => {
  if (req.profile) return next();
  if (req.path === '/profile/setup' || (req.path === '/profile' && req.method === 'POST')) return next();
  res.redirect('/profile/setup');
});

app.use(require('./routes/profile'));
app.use(require('./routes/doses'));
app.use(require('./routes/medications'));
app.use(require('./routes/disposables'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).render('error', {
    title: status === 404 ? 'Not found' : 'Something went wrong',
    message: status >= 500 ? 'An unexpected error occurred. Please try again.' : err.message,
  });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Meditrak listening on ${config.baseUrl} (port ${config.port})`);
    if (config.devLogin) console.warn('DEV_LOGIN is enabled — do not use this in production.');
    push.startScheduler();
  });
}

module.exports = app;
