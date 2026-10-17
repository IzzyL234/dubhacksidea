export function number(value, min, max, label = 'value') {
  if (value === '' || value === null || typeof value === 'boolean' || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${label} must be ${min}–${max}`);
  return Number(value);
}
export function text(value, label='text', max=4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
  return value.trim();
}
export function instant(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Use an ISO timestamp with timezone offset');
  return new Date(value).toISOString();
}
export function interval(start, end) {
  start = instant(start); end = instant(end);
  if (Date.parse(end) <= Date.parse(start)) throw new Error('End must follow start');
  return {start, end};
}
export const overlaps = (a,b) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
const defaults = {academic: .35, social: .25, wellbeing: .25, career: .15};
export function decide(input) {
  const weights = {...defaults, ...input.weights};
  for (const k of Object.keys(defaults)) weights[k] = number(weights[k],0,1,k);
  const total = Object.values(defaults).reduce((s,_,i)=>s+weights[Object.keys(defaults)[i]],0);
  if (!total) throw new Error('At least one weight must be positive');
  const contributions = Object.fromEntries(Object.keys(defaults).map(k=>[k, number(input[k],0,10,k)*10*weights[k]/total]));
  const cost = number(input.cost ?? 3,0,10,'opportunity cost') * 3;
  const energy = number(input.energy ?? 5,0,10,'energy');
  const score = Math.round(Math.max(0,Math.min(100,Object.values(contributions).reduce((a,b)=>a+b,0)-cost-(10-energy)*1.5)));
  return {score, recommendation: input.conflict ? 'Reschedule' : score >= 60 ? 'Say yes' : score >= 40 ? 'Consider a shorter version' : 'Protect your time', contributions, penalties:{opportunityCost:cost,lowEnergy:(10-energy)*1.5}, conflict:!!input.conflict, explanation:input.conflict ? 'This overlaps an existing commitment. Find another time before accepting.' : 'Weighted benefits minus opportunity cost and energy load. Adjust the values to reflect your priorities.'};
}
export function recommend(sessions, candidates) {
  return candidates.map(slot=>{
    interval(slot.start,slot.end);
    // Use offset-local hour, not the server timezone. Bayesian prior avoids overfitting one rating.
    const hour = Number(slot.localHour ?? new Date(slot.start).getUTCHours());
    const observations = sessions.filter(s=>s.rating && s.localHour !== undefined && Math.abs(s.localHour-hour)<=2);
    const predictedRating = (observations.reduce((s,x)=>s+x.rating,0)+3*3)/(observations.length+3);
    return {...slot,predictedRating:Math.round(predictedRating*100)/100,evidence:observations.length};
  }).sort((a,b)=>b.predictedRating-a.predictedRating || Date.parse(a.start)-Date.parse(b.start));
}
export function parseFlyer(raw) {
  const lines=text(raw).split('\n').map(x=>x.trim()).filter(Boolean);
  return {title:lines[0].slice(0,160),dateHint:raw.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? null,timeHint:raw.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i)?.[0] ?? null,locationHint:lines.find(x=>/^(?:where|location|venue)\s*:/i.test(x))?.replace(/^[^:]+:\s*/,'') ?? null,text:raw,requiresReview:true};
}
