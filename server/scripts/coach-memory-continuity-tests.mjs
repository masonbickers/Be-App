import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMemories } from '../lib/coach/memory.js';
import { recentConversation } from '../lib/coach/context.js';
import { __coachChatLatestPriorityForTest, __coachChatContextForLatestMessageForTest } from '../routes/coach-chat.js';

const facts = [
  {text:'I prefer morning workouts', category:'preference'},
  {text:'I only have dumbbells', category:'equipment'},
  {text:'I avoid dairy', category:'dietary_preference'},
  {text:'I have a chronic knee injury', category:'injury'},
];
for (const [question, expected] of [
  ['When should I do my hard session?', facts[0].text],
  ['Give me a strength session', facts[1].text],
  ['Suggest breakfast', facts[2].text],
  ['Can I do squats?', facts[3].text],
]) test(`retrieves durable constraint for ${question}`, () => {
  assert.ok(selectMemories(facts, question).some(row => row.text === expected));
});
test('greeting does not pull an unrelated injury into the answer', () => {
  assert.deepEqual(selectMemories(facts, 'Hi'), []);
});
test('explicit memory recall exposes active facts without matching their wording', () => {
  const result = selectMemories([...facts, {text:'I prefer evening workouts',active:false}, {text:'I avoid peanuts',archivedAt:'2026-09-28'}, {text:'I prefer cycling',status:'pending_approval'}], 'What do you remember about me?');
  assert.deepEqual(new Set(result.map(row => row.text)), new Set(facts.map(row => row.text)));
});
test('short turns retain an earlier decision beyond ten messages', () => {
  const messages = [{role:'user', content:'I chose the dumbbell plan and rejected the gym plan.'}, ...Array.from({length:24}, (_, i) => ({role:i%2?'user':'assistant',content:`Discussion ${i}`})), {role:'user',content:'Which plan did I choose?'}];
  assert.equal(recentConversation(messages)[0].content, messages[0].content);
});
test('legacy prompt retains general facts and the meaning of a short follow-up', () => {
  const result = __coachChatLatestPriorityForTest([{role:'user',content:'My dog is named Luna.'},{role:'assistant',content:'Thanks for telling me.'},{role:'user',content:'What is her name?'}]);
  assert.ok(result.previousConversationContext.some(row => row.content === 'My dog is named Luna.'));
});
test('legacy context retains dietary facts for a food request', () => {
  const result = __coachChatContextForLatestMessageForTest({athleteProfile:{coachMemory:[facts[2]]}}, 'Suggest breakfast');
  assert.ok(JSON.stringify(result).includes('I avoid dairy'));
});

test('explicit recurring soreness is a lasting constraint, not a one-off daily log', async () => {
  const { memoryCandidate } = await import('../lib/coach/memory.js');
  assert.equal(memoryCandidate('Remember that my knee gets sore after hills')?.category, 'injury');
  assert.equal(memoryCandidate('My knee is sore today'), null);
});
