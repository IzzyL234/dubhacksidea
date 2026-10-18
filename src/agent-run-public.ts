export function agentRunProjection(rows:unknown[]){
 const outcomes=['proposal','reply','clarify','fallback','workflow','confirmation','invalid_proposal','budget','failed','unavailable'];
 return rows.flatMap((raw:any)=>{
  if(!raw||typeof raw.id!=='string'||!/^[a-f0-9-]{36}$/i.test(raw.id)||!Number.isFinite(Date.parse(raw.reported_at))||!outcomes.includes(raw.outcome)||!Array.isArray(raw.steps))return [];
  return [{id:raw.id,at:raw.reported_at,outcome:raw.outcome,steps:raw.steps.filter((s:any)=>s&&['calendar','openings','learning','notes'].includes(s.tool)&&typeof s.ok==='boolean').slice(0,4).map((s:any)=>({tool:s.tool,ok:s.ok}))}];
 }).slice(0,20);
}
