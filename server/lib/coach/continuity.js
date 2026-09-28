import { Buffer } from 'node:buffer';
const invalid = message => Object.assign(new Error(message), {code:'COACH_INVALID_INPUT',status:400});
export const validCoachId = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
export function coachInputBudget({contextWindow=128000,outputReserve=6000}={}) {
 return Math.max(0,Math.min(32000,contextWindow-outputReserve));
}
// UTF-8 bytes form a conservative upper bound for byte-level BPE tokens. Count
// envelope overhead too. This deliberately underfills rather than overruns an
// unknown configured model; COACH_MODEL_CONTEXT_TOKENS can lower the ceiling.
export const tokenUpperBound = value => Buffer.byteLength(String(value || ''),'utf8') + 12;
export function budgetConversation(rows,{budget=32000}={}) {
 const eligible=(Array.isArray(rows)?rows:[]).filter(m=>['user','assistant'].includes(m?.role)&&typeof m.content==='string'&&m.content.trim()&&!m.streaming&&!['stopped','failed','interrupted','pending'].includes(m.presentationState));
 const messages=[],droppedIds=[];let used=0;
 for(let i=eligible.length-1;i>=0;i--){
  const row=eligible[i],cost=tokenUpperBound(row.content);
  if(used+cost>budget){if(!messages.length)throw invalid('Latest message exceeds context budget');droppedIds.unshift(...eligible.slice(0,i+1).map(m=>m.id).filter(Boolean));break;}
  used+=cost;messages.unshift({role:row.role,content:row.content});
 }
 return {messages,droppedIds,used};
}
export function validateTurn(body) {
 if(!body||!validCoachId(body.threadId)||!validCoachId(body.messageId)||!validCoachId(body.requestId))throw invalid('Valid thread, message and request identifiers required');
 if(body.temporary!=null&&typeof body.temporary!=='boolean')throw invalid('Invalid temporary mode');
 if(!Array.isArray(body.messages)||!body.messages.length||body.messages.length>400)throw invalid('Invalid conversation');
 const latest=body.messages.at(-1);
 if(latest?.role!=='user'||typeof latest.content!=='string'||!latest.content.trim()||tokenUpperBound(latest.content)>16000)throw invalid('A non-empty user question is required');
 if(body.attachments!=null&&(!Array.isArray(body.attachments)||body.attachments.length>4||body.attachments.some(a=>!validCoachId(a?.id))))throw invalid('Invalid attachment references');
 return {...body,temporary:body.temporary===true,content:latest.content.trim()};
}
