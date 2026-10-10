require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Use SESSION_SECRET if given, otherwise generate one and keep it in the data folder
function persistentSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, 'session-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const isProd = process.env.NODE_ENV === 'production';

module.exports = {
  port,
  baseUrl,
  dataDir,
  isProd,
  secureCookies: baseUrl.startsWith('https://'),
  sessionSecret: persistentSecret(),
  oidc: {
    issuer: process.env.OIDC_ISSUER,
    clientId: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    scopes: process.env.OIDC_SCOPES || 'openid profile email',
    providerName: process.env.OIDC_PROVIDER_NAME || 'single sign-on',
  },
  // Local testing only: never enabled when NODE_ENV=production
  devLogin: process.env.DEV_LOGIN === 'true' && !isProd,
  vapidSubject:
    process.env.VAPID_SUBJECT ||
    (baseUrl.startsWith('https://') ? baseUrl : 'mailto:admin@example.com'),
};
