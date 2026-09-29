import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// The override also verifies a release snapshot without changing this checkout.
const source = readFileSync(process.env.GARMIN_ROUTE_SOURCE || new URL('../routes/garmin-training.js', import.meta.url), 'utf8');
const exportHelpers = source.includes('import { reserveWorkoutExport')
  ? await import('../lib/garmin/workoutExport.js') : {};

function harness(initialLog, { integrationKey = 'garminTraining', integration = {}, env = {}, onRefresh = () => {}, tokenReply = { status: 200, access_token: 'test-token', refresh_token: 'rotated-token', expires_in: 86400, refresh_token_expires_in: 7775998 } } = {}) {
  const rows = new Map([['users/u', { integrations: { [integrationKey]: {
    connected: true, accessToken: 'test-token', expiresAtMs: Date.now() + 3600000, ...integration,
  }, ...(integrationKey === 'garminTraining' ? { garmin: { connected: true, accessToken: 'health-token' } } : {}) } }]]);
  const logPath = 'users/u/sessionLogs/plan_2_1_0';
  if (initialLog !== undefined) rows.set(logPath, structuredClone(initialLog));
  function ref(path) {
    return {
      path, collection: name => ref(`${path}/${name}`), doc: id => ref(`${path}/${id}`),
      get: async () => ({ exists: rows.has(path), data: () => structuredClone(rows.get(path)) }),
      add: async patch => rows.set(`${path}/audit`, structuredClone(patch)),
      set: async patch => {
        const before = rows.get(path) || {};
        const after = { ...before, ...structuredClone(patch) };
        if (patch.integrations) after.integrations = { ...before.integrations, ...Object.fromEntries(Object.entries(patch.integrations).map(([key, value]) => [key, { ...before.integrations?.[key], ...value }])) };
        rows.set(path, after);
      },
    };
  }
  const db = {
    collection: ref,
    batch() {
      const writes = [];
      return { set: (doc, patch) => writes.push([doc, patch]),
        commit: async () => { for (const [doc, patch] of writes) await doc.set(patch); } };
    },
    async runTransaction(fn) {
      const writes = [];
      const result = await fn({ get: doc => doc.get(), set: (doc, patch) => writes.push([doc, patch]) });
      for (const [doc, patch] of writes) await doc.set(patch);
      return result;
    },
  };
  const firestore = Object.assign(() => db, { FieldValue: { serverTimestamp: () => 12345 } });
  const routes = new Map(), uploads = [], errors = [], refreshes = [];
  vm.runInNewContext(source.replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/export function /g, 'function ').replace('export default router;', ''), {
    express: { Router: () => ({ post: (path, _auth, handler) => routes.set(path, handler) }) },
    admin: { firestore }, requireUser() {}, ...exportHelpers, Buffer, AbortSignal,
    URLSearchParams, process: { env }, console: { log() {}, warn() {}, error: (...args) => errors.push(args.join(' ')) },
    fetch: async (url, options) => {
      if (url === 'https://diauth.garmin.com/di-oauth2-service/oauth/token') {
        refreshes.push(Object.fromEntries(new URLSearchParams(options.body)));
        onRefresh(rows);
        return { ok: tokenReply.status === 200, status: tokenReply.status, json: async () => tokenReply };
      }
      assert.equal(url, 'https://apis.garmin.com/training-api/workout');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      uploads.push(JSON.parse(options.body));
      return { ok: true, status: 200, text: async () => '{"workoutId":"garmin-123"}' };
    },
  });
  const body = { userId: 'u', sessionKey: 'plan_2_1_0', title: 'Upper A', workout: {
    sport: 'STRENGTH_TRAINING', steps: [
      { type: 'Flat dumbbell press', stepType: 'work', durationType: 'open', notes: '3 sets · 6–10 reps · Rest 180 sec' },
      { type: 'Weighted pull-up', stepType: 'work', durationType: 'open', notes: '3 sets · 6–10 reps · Rest 180 sec' },
    ],
  } };
  return { rows, uploads, errors, refreshes, logPath, async send(overrides = {}) {
    let status = 200, data;
    await routes.get('/send-workout')({ user: { uid: 'u' }, body: { ...body, ...overrides } }, {
      status(value) { status = value; return this; }, json(value) { data = value; return this; },
    });
    return { status, data };
  } };
}

for (const [name, initialLog] of [['existing', { notes: 'Preserve this' }], ['missing', undefined]]) {
  test(`strength send handles ${name} Admin SDK snapshot and persists Garmin identity`, async () => {
    const h = harness(initialLog);
    const result = await h.send();
    assert.equal(result.status, 200, JSON.stringify({ response: result.data, errors: h.errors }));
    assert.equal(result.data.createdWorkoutId, 'garmin-123');
    assert.equal(h.uploads.length, 1);
    assert.equal(h.uploads[0].sport, 'STRENGTH_TRAINING');
    assert.equal(h.uploads[0].steps.length, 2);
    assert.equal(h.uploads[0].steps[0].durationType, 'OPEN');
    assert.match(h.uploads[0].steps[0].description, /6–10 reps/);
    assert.equal(h.rows.get(h.logPath).garminSync.workoutId, 'garmin-123');
    assert.equal(h.rows.get(h.logPath).garminSync.status, 'sent');
    if (initialLog) assert.equal(h.rows.get(h.logPath).notes, 'Preserve this');
    else assert.equal(h.rows.get(h.logPath).createdAt, 12345);
    assert.equal((await h.send()).data.alreadySynced, true);
    assert.equal(h.uploads.length, 1);
  });
}

test('already sent snapshot returns the stored workout without uploading', async () => {
  const h = harness({ garminSync: { status: 'sent', workoutId: 'existing-123' } });
  const result = await h.send();
  assert.equal(result.status, 200);
  assert.equal(result.data.createdWorkoutId, 'existing-123');
  assert.equal(result.data.alreadySynced, true);
  assert.equal(h.uploads.length, 0);
});

test('send rejects a different user before touching Garmin', async () => {
  const h = harness({});
  assert.equal((await h.send({ userId: 'other' })).status, 403);
  assert.equal(h.uploads.length, 0);
});

const trainingEnv = { GARMIN_TRAINING_CLIENT_ID: 'training-client', GARMIN_TRAINING_CLIENT_SECRET: 'training-secret' };
const expiredAccess = { credentialProfile: 'training', accessToken: 'old-token', refreshToken: 'old-refresh', expiresAtMs: 1 };

test('expired 90-day Training grant enables reconnect without retrying an expired token', async () => {
  const h = harness(undefined, { env: trainingEnv, integration: { ...expiredAccess, linkedAtMs: Date.now() - 100 * 86400000, refreshTokenExpiresIn: 7775998 } });
  const result = await h.send();
  assert.equal(result.status, 401);
  assert.equal(result.data.code, 'GARMIN_RECONNECT_REQUIRED');
  assert.match(result.data.error, /Training sync.*Settings/);
  assert.equal(h.refreshes.length, 0);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.rows.get('users/u').integrations.garminTraining.connected, false);
  assert.equal(h.rows.get('users/u').integrations.garminTraining.reconnectRequired, true);
  assert.equal(h.rows.get('users/u').integrations.garmin.connected, true);
  assert.equal(h.rows.get('users/u').integrations.garmin.accessToken, 'health-token');
});

test('invalid_grant enables reconnect and never exposes Garmin token-bearing error text', async () => {
  const h = harness(undefined, { env: trainingEnv, integration: expiredAccess, tokenReply: { status: 400, error: 'invalid_grant', error_description: 'Invalid refresh token: secret-refresh-token' } });
  const result = await h.send();
  assert.equal(result.data.code, 'GARMIN_RECONNECT_REQUIRED');
  assert.equal(h.rows.get('users/u').integrations.garminTraining.connected, false);
  assert.equal(JSON.stringify(result).includes('secret-refresh-token'), false);
  assert.equal(h.uploads.length, 0);
});

test('invalid client credentials are a server error and do not disconnect the user', async () => {
  const h = harness(undefined, { env: trainingEnv, integration: expiredAccess, tokenReply: { status: 401, error: 'invalid_client' } });
  const result = await h.send();
  assert.equal(result.status, 503);
  assert.equal(result.data.code, 'GARMIN_TOKEN_REFRESH_FAILED');
  assert.equal(h.rows.get('users/u').integrations.garminTraining.connected, true);
  assert.equal(h.uploads.length, 0);
});

test('successful Training refresh rotates both tokens and renews the refresh lifetime before sending', async () => {
  const h = harness(undefined, { env: trainingEnv, integration: { ...expiredAccess, linkedAtMs: 1 } });
  const result = await h.send();
  assert.equal(result.status, 200, JSON.stringify(result));
  const g = h.rows.get('users/u').integrations.garminTraining;
  assert.equal(g.refreshToken, 'rotated-token');
  assert.ok(g.refreshTokenExpiresAtMs > Date.now() + 89 * 86400000);
  assert.equal(g.reconnectRequired, false);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.refreshes[0].client_id, 'training-client');
});

test('legacy Health connection refresh uses its issuer credentials and persists to its original key', async () => {
  const h = harness(undefined, { integrationKey: 'garmin', env: { ...trainingEnv, GARMIN_HEALTH_CLIENT_ID: 'health-client', GARMIN_HEALTH_CLIENT_SECRET: 'health-secret' }, integration: { ...expiredAccess, credentialProfile: 'health' } });
  const result = await h.send();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(h.refreshes[0].client_id, 'health-client');
  assert.equal(h.rows.get('users/u').integrations.garmin.refreshToken, 'rotated-token');
  assert.equal(h.rows.get('users/u').integrations.garminTraining, undefined);
});

test('a failed stale refresh cannot disable a concurrently reconnected account', async () => {
  const h = harness(undefined, { env: trainingEnv, integration: expiredAccess, tokenReply: { status: 400, error: 'invalid_grant' }, onRefresh: rows => {
    const user = rows.get('users/u');
    user.integrations.garminTraining = { ...user.integrations.garminTraining, accessToken: 'reconnected-access', refreshToken: 'reconnected-refresh', expiresAtMs: Date.now() + 86400000 };
  } });
  const result = await h.send();
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'GARMIN_CONNECTION_CHANGED');
  assert.equal(h.rows.get('users/u').integrations.garminTraining.connected, true);
  assert.equal(h.rows.get('users/u').integrations.garminTraining.refreshToken, 'reconnected-refresh');
  assert.equal(h.uploads.length, 0);
});
