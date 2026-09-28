import express from 'express';
import { memoryCandidate, saveMemory } from './memory.js';
import { legacyMemoryRepositoryForUser } from './legacyMemoryRepository.js';
const reply = text => ({reply:text,updatedPlan:null,nutritionDraft:null,coachActions:[]});
async function withRepository(getRepository,uid,run) {
  const controller=new AbortController();let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(async()=>run(await getRepository(uid,controller.signal),controller.signal)),
      new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Memory lookup timed out'));},8000);}),
    ]);
  } finally { clearTimeout(timer); }
}
export function createLegacyMemoryBridge({getRepository=legacyMemoryRepositoryForUser,skipPersonalisation=false,onSaved=()=>{}}={}) {
  const router=express.Router();
  const failed=(res,error)=>res.status(error.code==='MEMORY_DISABLED'?409:error.code==='MEMORY_NOT_DURABLE'?400:503).json({code:['MEMORY_NOT_DURABLE','MEMORY_DISABLED'].includes(error.code)?error.code:'MEMORY_UNAVAILABLE',error:'Coach could not access saved memory. Please try again.',retryable:error.code!=='MEMORY_NOT_DURABLE'});
  router.post('/memory',async(req,res)=>{
    if(!req.user?.uid)return res.status(401).json({code:'AI_SIGN_IN_REQUIRED'});
    if(!req.body||Object.keys(req.body).some(key=>key!=='text')||typeof req.body.text!=='string'||req.body.text.length>400)return res.status(400).json({code:'MEMORY_INVALID'});
    try{return res.json(await withRepository(getRepository,req.user.uid,(repo,signal)=>saveMemory(repo,req.body.text,signal)));}
    catch(error){if(error.code==='MEMORY_CANONICAL')return res.json({saved:true,alreadyInProfile:true});return failed(res,error);}
  });
  router.post('/',async(req,res,next)=>{
    if(!req.user?.uid||req.body?.protocolVersion===2||(skipPersonalisation&&req.body?.context?.personalisationVersion===1))return next();
    const messages=req.body?.messages;
    if(!Array.isArray(messages)||!messages.length)return next();
    const latest=[...messages].reverse().find(message=>message?.role==='user'&&typeof message.content==='string')?.content||'';
    try {
      if(/^\s*(?:please\s+)?remember\b|^\s*save (?:this|that) (?:as (?:a )?)?memory/i.test(latest)){
        if(!memoryCandidate(latest))return res.json(reply('I can remember lasting preferences and routines. Daily measurements and temporary states belong in your logs.'));
        await withRepository(getRepository,req.user.uid,(repo,signal)=>saveMemory(repo,latest,signal));
        onSaved(req.user.uid);
        return res.json({...reply("Remembered for coaching — I'll use this in future advice. This does not change your plan, profile or logs."),responseSource:'server_memory'});
      }
      const memories=await withRepository(getRepository,req.user.uid,repo=>repo.memories());
      const context=req.body.context&&typeof req.body.context==='object'?req.body.context:{};
      req.body.context={...context,athleteProfile:{...(context.athleteProfile||{}),coachMemory:memories}};
      return next();
    } catch(error){if(error.code==='MEMORY_CANONICAL')return res.json({...reply('That preference is already in your profile.'),responseSource:'server_memory'});return failed(res,error);}
  });
  return router;
}
