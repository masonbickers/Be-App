import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import coachChatRoute from '../routes/coach-chat.js';
import { fakeDb } from '../test/coachFirestoreFake.mjs';
import { createLegacyMemoryRepository } from '../lib/coach/legacyMemoryRepository.js';

const plan = { id: 'p', sourceCollection: 'trainPlans', ownerId: 'alice', weeks: [{ days: [{ date: '2026-09-29', sessions: [{ name: 'Easy run', durationMin: 17 }] }] }] };
async function ask(answer, check) {
  const requests = [];
  const client = { chat: { completions: { create: async body => { requests.push(body); return { choices: [{ message: { content: JSON.stringify(answer) } }] }; } } } };
  const app = express(); app.use(express.json()); app.use((req,res,next) => {req.user={uid:'alice'};next();});
  app.use('/coach-chat',coachChatRoute(client,{getRepository:async uid=>createLegacyMemoryRepository(fakeDb(),uid)}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/coach-chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan,messages:[{role:'user',content:'Change my run today from 17 to 40 minutes'}]})});
    assert.equal(response.status,200); await check(await response.json(),requests);
  } finally {await new Promise(resolve=>server.close(resolve));}
}
test('production route rejects the screenshot’s descriptive card with no plan payload',async()=>{
  await ask({reply:'Review the changes.',updatedPlan:null,coachActions:[{type:'plan_update',title:'Increase today’s easy run to 40 minutes',payload:{dateKey:'2026-09-29'}}]}, result=>{
    assert.equal(result.coachActions.length,0,'Incomplete cards must not reach Apply');
    assert.match(result.reply,/couldn't prepare a valid plan change/);
  });
});
test('production route supplies exact fields and returns a saveable 40 minute plan',async()=>{
  await ask({reply:'Review the changes.',updatedPlan:null,planEdits:[{path:'/weeks/0/days/0/sessions/0/durationMin',valueJson:'40'}],coachActions:[{type:'plan_update',title:'Increase today’s easy run to 40 minutes',payload:{}}]},(result,requests)=>{
    const action=result.coachActions[0];
    assert.equal(action.payload.planId,'p'); assert.equal(action.payload.planCollection,'trainPlans');
    assert.equal(action.payload.updatedPlan.weeks[0].days[0].sessions[0].durationMin,40);
    assert.equal(action.payload.updatedPlan.ownerId,'alice');
    assert.ok(JSON.stringify(requests[0]).includes('/weeks/0/days/0/sessions/0/durationMin'));
  });
});
