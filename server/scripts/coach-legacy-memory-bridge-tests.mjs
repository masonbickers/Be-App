import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeDb } from '../test/coachFirestoreFake.mjs';
import { createLegacyMemoryRepository } from '../lib/coach/legacyMemoryRepository.js';
import { createLegacyMemoryBridge } from '../lib/coach/legacyMemoryBridge.js';
async function fixture(run) {
  const db=fakeDb(),app=express();app.use(express.json());
  app.use((req,res,next)=>{if(req.get('x-user'))req.user={uid:req.get('x-user')};next();});
  app.use('/coach-chat',createLegacyMemoryBridge({getRepository:async uid=>createLegacyMemoryRepository(db,uid)}));
  app.post('/coach-chat',(req,res)=>res.json({context:req.body.context}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const call=async(body,user='alice',path='')=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/coach-chat${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(user?{'x-user':user}:{})},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  try { await run({call,db}); } finally { await new Promise(resolve=>server.close(resolve)); }
}
test('explicit remember persists and a new chat receives server-owned facts',()=>fixture(async({call})=>{
  const result=await call({messages:[{role:'user',content:'Remember I only have dumbbells'}]});
  assert.equal(result.status,200);assert.equal(result.data.responseSource,'server_memory');assert.deepEqual(result.data.coachActions,[]);
  const next=await call({messages:[{role:'user',content:'Give me a strength session'}],context:{athleteProfile:{coachMemory:[{text:'I have a full gym'}]}}});
  assert.equal(next.data.context.athleteProfile.coachMemory[0].text,'I only have dumbbells');
  const other=await call({messages:[{role:'user',content:'What do you remember?'}]},'bob');
  assert.deepEqual(other.data.context.athleteProfile.coachMemory,[]);
}));
test('review-card memory endpoint is authenticated and rejects temporary measurements',()=>fixture(async({call,db})=>{
  assert.equal((await call({text:'I prefer morning workouts'},null,'/memory')).status,401);
  assert.equal((await call({text:'I weigh 80 kg today'},'alice','/memory')).status,400);
  assert.equal((await call({text:'I avoid dairy'},'alice','/memory')).data.saved,true);
  assert.equal([...db.data.keys()].filter(path=>path.includes('/coachMemory/')).length,1);
}));
