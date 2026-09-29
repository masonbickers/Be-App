import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// The override also verifies a release snapshot without changing this checkout.
const source = readFileSync(process.env.GARMIN_ROUTE_SOURCE || new URL('../routes/garmin-training.js', import.meta.url), 'utf8');
const exportHelpers = source.includes('import { reserveWorkoutExport')
  ? await import('../lib/garmin/workoutExport.js') : {};

function harness(initialLog) {
  const rows = new Map([['users/u', { integrations: { garminTraining: {
    connected: true, accessToken: 'test-token', expiresAtMs: Date.now() + 3600000,
  } } }]]);
  const logPath = 'users/u/sessionLogs/plan_2_1_0';
  if (initialLog !== undefined) rows.set(logPath, structuredClone(initialLog));
  function ref(path) {
    return {
      path, collection: name => ref(`${path}/${name}`), doc: id => ref(`${path}/${id}`),
      get: async () => ({ exists: rows.has(path), data: () => structuredClone(rows.get(path)) }),
      add: async patch => rows.set(`${path}/audit`, structuredClone(patch)),
      set: async patch => rows.set(path, { ...rows.get(path), ...structuredClone(patch) }),
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
  const routes = new Map(), uploads = [], errors = [];
  vm.runInNewContext(source.replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/export function /g, 'function ').replace('export default router;', ''), {
    express: { Router: () => ({ post: (path, _auth, handler) => routes.set(path, handler) }) },
    admin: { firestore }, requireUser() {}, ...exportHelpers, Buffer, AbortSignal,
    process: { env: {} }, console: { log() {}, error: (...args) => errors.push(args.join(' ')) },
    fetch: async (url, options) => {
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
  return { rows, uploads, errors, logPath, async send(overrides = {}) {
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
