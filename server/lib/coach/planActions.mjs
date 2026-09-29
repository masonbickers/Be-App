export function applyPlanEdits(plan,edits=[]) {
  if(!plan || !Array.isArray(edits) || edits.length>20)throw new Error('Invalid plan edits');
  const result=structuredClone(plan);
  const leaves=new Set(['notes','description','title','name','durationMin','durationSec','targetDurationMin','totalDurationSec','duration','seconds','distanceKm','distanceMeters','date','dateKey','day','intensity','pace','targetPace']);
  for(const edit of edits) {
    const parts=String(edit.path).split('/').slice(1);
    if(!String(edit.path).startsWith('/') || parts.length<3 || !['weeks','days','sessions'].includes(parts[0]==='plan'?parts[1]:parts[0]) || parts.some(p=>['__proto__','prototype','constructor'].includes(p)) || !leaves.has(parts.at(-1))) throw new Error('Protected plan path');
    let target=result;for(const p of parts.slice(0,-1)){if(!target || !Object.hasOwn(target,p))throw new Error('Unknown plan path');target=target[p];}
    const key=parts.at(-1),value=JSON.parse(edit.valueJson);
    if(!target || !Object.hasOwn(target,key) || !['string','number'].includes(typeof value) || typeof value!==typeof target[key])throw new Error('Invalid edit value');
    if(typeof value==='number' && (!Number.isFinite(value)||value<0||value>100000))throw new Error('Invalid quantity');
    if(/date/i.test(key) && (!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value).toISOString().slice(0,10)!==value))throw new Error('Invalid date');
    target[key]=value;
  }
  return result;
}
export function editablePlanFields(plan, todayIso = new Date().toISOString().slice(0, 10)) {
  const today = Date.parse(todayIso);
  // Keep current sessions in the bounded model context even in a long plan.
  const proximity = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 5) return Infinity;
    const date = value.dateKey || value.date || value.weekStartDate || value.startDate;
    const distance = typeof date === 'string' ? Math.abs(Date.parse(date) - today) : Infinity;
    return Math.min(Number.isFinite(distance) ? distance : Infinity,
      ...Object.values(value).filter(item => item && typeof item === 'object').map(item => proximity(item, depth + 1)));
  };
  const result=[];
  const allowed=new Set(['notes','description','title','name','durationMin','durationSec','targetDurationMin','totalDurationSec','duration','seconds','distanceKm','distanceMeters','date','dateKey','day','intensity','pace','targetPace']);
  const walk=(value,path,depth=0)=>{
    if(depth>16 || result.length>=100)return;
    if(!value || typeof value!=='object')return;
    const entries = Object.entries(value);
    if (Array.isArray(value)) entries.sort((a, b) => proximity(a[1]) - proximity(b[1]));
    for(const [key,item] of entries){
      if(result.length>=100)break;
      const next=path+'/'+key;
      if(item && typeof item==='object')walk(item,next,depth+1);
      else if(allowed.has(key)&&['string','number'].includes(typeof item))result.push({path:next,value:typeof item==='string'?item.slice(0,300):item});
    }
  };
  for(const root of ['weeks','days','sessions'])if(plan?.[root])walk(plan[root],'/'+root);
  if(plan?.plan)for(const root of ['weeks','days','sessions'])if(plan.plan[root])walk(plan.plan[root],'/plan/'+root);
  return result;
}

// Build the existing client contract from bounded edits, never from card prose.
export function preparePlanActionResponse(parsed, plan) {
  const actions = Array.isArray(parsed?.coachActions) ? parsed.coachActions : [];
  const planActions = actions.filter(action => action?.type === 'plan_update');
  if (parsed?.updatedPlan) throw Object.assign(new Error('Full plan replacement is not permitted'), { code: 'PLAN_EDIT_INVALID' });
  if (!planActions.length && !parsed?.planEdits?.length) return parsed;
  if (!plan?.id || !Array.isArray(parsed.planEdits) || !parsed.planEdits.length) {
    throw Object.assign(new Error('Missing plan target or executable plan edits'), { code: 'PLAN_EDIT_INVALID' });
  }
  let updatedPlan;
  try { updatedPlan = applyPlanEdits(plan, parsed.planEdits); }
  catch (error) { throw Object.assign(error, { code: 'PLAN_EDIT_INVALID' }); }
  if (!planActions.length) actions.push({
    type: 'plan_update', title: 'Update your plan?', summary: 'Review the proposed plan change.',
  });
  return { ...parsed, updatedPlan, coachActions: actions.map(action => action.type === 'plan_update' ? {
    ...action, status: 'pending', autoApply: false, targetId: plan.id,
    payload: { updatedPlan, planId: plan.id, planCollection: plan.sourceCollection || 'plans' },
  } : action) };
}
