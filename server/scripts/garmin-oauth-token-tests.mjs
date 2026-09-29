import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import crypto from 'node:crypto';

const source = readFileSync(process.env.GARMIN_AUTH_ROUTE_SOURCE || new URL('../routes/garmin.js', import.meta.url), 'utf8');

test('Garmin Training reconnect clears the expired state and records the new refresh deadline', async () => {
  const routes = new Map(), writes = [], redirects = [];
  let deleted = false;
  const state = { uid: 'u', codeVerifier: 'verifier', credentialProfile: 'training', integrationKey: 'garminTraining', expiresAtMs: Date.now() + 60000, redirectToApp: 'version10app://garmin-linked' };
  const ref = path => ({
    collection: name => ref(`${path}/${name}`), doc: id => ref(`${path}/${id}`),
    get: async () => ({ exists: true, data: () => state }),
    set: async (data, options) => writes.push({ path, data, options }),
    delete: async () => { deleted = true; },
  });
  const firestore = Object.assign(() => ({ collection: ref }), { FieldValue: { serverTimestamp: () => 1 } });
  vm.runInNewContext(source.replace(/^import[\s\S]*?;\n/gm, '').replace('export default router;', ''), {
    crypto, URLSearchParams, AbortController, setTimeout, clearTimeout,
    express: { Router: () => ({ get: (path, fn) => routes.set(path, fn), post() {} }) },
    admin: { firestore }, requireUser() {},
    console: { log() {}, warn() {}, error() {} },
    process: { env: { GARMIN_TRAINING_CLIENT_ID: 'client', GARMIN_TRAINING_CLIENT_SECRET: 'secret', GARMIN_TRAINING_REDIRECT_URI: 'https://example.test/callback' } },
    fetch: async url => ({ ok: true, status: 200, json: async () => url.includes('/oauth/token')
      ? { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 86400, refresh_token_expires_in: 7775998 }
      : { userId: 'garmin-user' } }),
  });
  await routes.get('/callback')({ query: { code: 'code', state: 'state' } }, { redirect: url => redirects.push(url) });
  assert.equal(writes.length, 1);
  const g = writes[0].data.integrations.garminTraining;
  assert.equal(g.connected, true);
  assert.equal(g.reconnectRequired, false);
  assert.equal(g.connectionError, null);
  assert.equal(g.refreshToken, 'new-refresh');
  assert.equal(g.refreshTokenExpiresAtMs, g.linkedAtMs + 7775998 * 1000);
  assert.equal(writes[0].options.merge, true);
  assert.equal(deleted, true);
  assert.match(redirects[0], /success=1/);
});
