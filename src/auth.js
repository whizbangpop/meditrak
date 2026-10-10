const router = require('express').Router();
const { Issuer, generators } = require('openid-client');
const config = require('./config');
const db = require('./db');
const { asyncHandler } = require('./util');

const oidcConfigured = !!(config.oidc.issuer && config.oidc.clientId);
const redirectUri = `${config.baseUrl}/auth/callback`;

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = Issuer.discover(config.oidc.issuer)
      .then(
        (issuer) =>
          new issuer.Client({
            client_id: config.oidc.clientId,
            client_secret: config.oidc.clientSecret,
            redirect_uris: [redirectUri],
            post_logout_redirect_uris: [`${config.baseUrl}/login`],
            response_types: ['code'],
            token_endpoint_auth_method: config.oidc.clientSecret ? 'client_secret_basic' : 'none',
          })
      )
      .catch((e) => {
        clientPromise = null; // retry discovery next time
        throw e;
      });
  }
  return clientPromise;
}

function upsertUser(issuer, subject, email, name) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (issuer, subject, email, name, last_login_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (issuer, subject) DO UPDATE SET email = excluded.email, name = excluded.name, last_login_at = excluded.last_login_at`
  ).run(issuer, subject, email, name, now);
  return db.prepare('SELECT * FROM users WHERE issuer = ? AND subject = ?').get(issuer, subject);
}

function signIn(req, res, user) {
  req.session.userId = user.id;
  const hasProfile = db.prepare('SELECT 1 FROM profiles WHERE user_id = ?').get(user.id);
  const next = req.session.returnTo;
  req.session.returnTo = null;
  res.redirect(hasProfile ? next || '/' : '/profile/setup');
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', {
    title: 'Sign in',
    oidcConfigured,
    providerName: config.oidc.providerName,
    devLogin: config.devLogin,
  });
});

router.get(
  '/auth/login',
  asyncHandler(async (req, res) => {
    if (!oidcConfigured) return res.redirect('/login');
    const client = await getClient();
    const code_verifier = generators.codeVerifier();
    const state = generators.state();
    const nonce = generators.nonce();
    req.session.oidc = { code_verifier, state, nonce };
    res.redirect(
      client.authorizationUrl({
        scope: config.oidc.scopes,
        code_challenge: generators.codeChallenge(code_verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      })
    );
  })
);

router.get(
  '/auth/callback',
  asyncHandler(async (req, res) => {
    const client = await getClient();
    const pending = req.session.oidc;
    if (!pending) return res.redirect('/login');
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(redirectUri, params, pending);
    const claims = tokenSet.claims();
    req.session.oidc = null;
    req.session.idToken = tokenSet.id_token;
    const user = upsertUser(
      claims.iss,
      claims.sub,
      claims.email || null,
      claims.name || claims.preferred_username || claims.email || null
    );
    signIn(req, res, user);
  })
);

router.post('/auth/dev', (req, res) => {
  if (!config.devLogin) return res.status(404).end();
  const name = String(req.body.name || 'Test User').trim().slice(0, 80) || 'Test User';
  const user = upsertUser('dev', name.toLowerCase(), null, name);
  signIn(req, res, user);
});

router.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    const idToken = req.session.idToken;
    req.session = null;
    if (oidcConfigured && idToken) {
      try {
        const client = await getClient();
        if (client.issuer.metadata.end_session_endpoint) {
          return res.redirect(
            client.endSessionUrl({ id_token_hint: idToken, post_logout_redirect_uri: `${config.baseUrl}/login` })
          );
        }
      } catch (e) {
        console.warn('[auth] logout redirect failed', e.message);
      }
    }
    res.redirect('/login');
  })
);

module.exports = router;
