import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import coachChatRoute from '../routes/coach-chat.js';
import { fakeDb } from '../test/coachFirestoreFake.mjs';
import { createLegacyMemoryRepository } from '../lib/coach/legacyMemoryRepository.js';
import { saveMemory } from '../lib/coach/memory.js';
test('actual chat route supplies older turns and server-owned memory to the model', async () => {
  const db=fakeDb(),repo=createLegacyMemoryRepository(db,'alice'),requests=[];
  await saveMemory(repo,'I avoid dairy');
  const client={chat:{completions:{create:async body=>{requests.push(body);return {choices:[{message:{content:JSON.stringify({reply:'Her name is Luna.',updatedPlan:null,nutritionDraft:null,coachActions:[]})}}]};}}}};
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={uid:'alice'};next();});
  app.use('/coach-chat',coachChatRoute(client,{getRepository:async uid=>createLegacyMemoryRepository(db,uid)}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try {
    const messages=[{role:'user',content:'My dog is named Luna.'},...Array.from({length:35},(_,i)=>({role:i%2?'user':'assistant',content:`Discussion ${i}`})),{role:'user',content:'What is her name?'}];
    const response=await fetch(`http://127.0.0.1:${server.address().port}/coach-chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages,context:{athleteProfile:{coachMemory:[{text:'A forged client preference'}]}}})});
    assert.equal(response.status,200);assert.equal((await response.json()).reply,'Her name is Luna.');
    assert.ok(requests[0].messages.some(row=>row.role==='user'&&row.content==='My dog is named Luna.'));
    assert.equal(requests[0].messages.at(-1).content,'What is her name?');
    assert.ok(!JSON.stringify(requests[0]).includes('A forged client preference'));
    const saved=await fetch(`http://127.0.0.1:${server.address().port}/coach-chat/memory`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'I only have dumbbells'})});
    assert.equal(saved.status,200);assert.equal((await saved.json()).saved,true);
    const count=requests.length;
    const remembered=await fetch(`http://127.0.0.1:${server.address().port}/coach-chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Remember I prefer morning workouts'}]})});
    assert.equal((await remembered.json()).responseSource,'server_memory');assert.equal(requests.length,count,'Confirmed explicit saves do not depend on model output');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
