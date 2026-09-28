import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from '../test/coachFirestoreFake.mjs';
import { createLegacyMemoryRepository } from '../lib/coach/legacyMemoryRepository.js';
import { saveMemory, selectMemories } from '../lib/coach/memory.js';
test('saved preferences survive a new repository and remain account scoped', async () => {
  const db=fakeDb();
  await saveMemory(createLegacyMemoryRepository(db,'alice'),'Remember I only have dumbbells');
  const rows=await createLegacyMemoryRepository(db,'alice').memories();
  assert.ok(selectMemories(rows,'Give me a strength session').some(row=>row.text==='I only have dumbbells'));
  assert.deepEqual(await createLegacyMemoryRepository(db,'bob').memories(),[]);
});
test('correction replaces the active preference instead of retaining conflicting advice', async () => {
  const db=fakeDb(),repo=createLegacyMemoryRepository(db,'alice');
  await saveMemory(repo,'I prefer morning workouts');
  await saveMemory(repo,'I prefer evening workouts');
  const rows=await repo.memories();
  assert.equal(rows.length,1);assert.equal(rows[0].text,'I prefer evening workouts');assert.equal(rows[0].version,2);
});
test('disabled preferences stay excluded from new-chat retrieval', async () => {
  const db=fakeDb(),repo=createLegacyMemoryRepository(db,'alice');
  await saveMemory(repo,'I avoid dairy');
  const [row]=await repo.memories();
  db.data.get(`users/alice/coachMemory/${row._id}`).active=false;
  assert.deepEqual(await repo.memories(),[]);
});
test('turning saved preferences off prevents both retrieval and new saves', async () => {
  const db=fakeDb(),repo=createLegacyMemoryRepository(db,'alice');
  await saveMemory(repo,'I avoid dairy');
  db.data.set('users/alice/coachSettings/current',{savedPreferences:false});
  assert.deepEqual(await repo.memories(),[]);
  await assert.rejects(saveMemory(repo,'I prefer morning workouts'),{code:'MEMORY_DISABLED'});
});
