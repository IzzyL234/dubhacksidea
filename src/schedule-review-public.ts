export function scheduleReviewProjection(rows:unknown[],now=Date.now()){
 return rows.flatMap((raw:any)=>{
  const p=raw?.review;
  const validRange=(v:any)=>v&&typeof v.start==='string'&&typeof v.end==='string'&&Number.isFinite(Date.parse(v.start))&&Date.parse(v.end)>Date.parse(v.start);
  if(!p||!/^[a-f0-9]{16}$/.test(p.id)||!['pending','applied','skipped','stale'].includes(p.status)||!validRange(p.before)||p.after&&!validRange(p.after)||!Number.isFinite(Date.parse(p.createdAt))||!Number.isFinite(Date.parse(p.expiresAt))||!Array.isArray(p.conflicts))return [];
  const text=(v:unknown)=>typeof v==='string'?v.slice(0,500):'';
  return [{id:p.id,createdAt:p.createdAt,expiresAt:p.expiresAt,status:p.status==='pending'&&Date.parse(p.expiresAt)<=now?'stale':p.status,title:text(p.title).slice(0,160),before:{start:p.before.start,end:p.before.end},after:p.after?{start:p.after.start,end:p.after.end}:null,conflicts:p.conflicts.filter(validRange).slice(0,20).map((c:any)=>({title:text(c.title).slice(0,160),start:c.start,end:c.end})),overlapMinutes:Number.isFinite(p.overlapMinutes)?p.overlapMinutes:0,shiftMinutes:Number.isFinite(p.shiftMinutes)?p.shiftMinutes:null,reason:text(p.reason),model:p.model&&[p.model.productivity,p.model.mood].every((v:any)=>Number.isFinite(v)&&v>=1&&v<=5)&&Number.isInteger(p.model.observations)&&p.model.observations>0?{productivity:p.model.productivity,mood:p.model.mood,observations:p.model.observations}:null}];
 }).slice(0,20);
}
