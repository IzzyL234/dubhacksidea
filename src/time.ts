export const TIMEZONE = "America/Los_Angeles";
export function localParts(timestamp:number) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:TIMEZONE,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(timestamp)).filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));
}
export function localDate(timestamp:number):string {
  const p=localParts(timestamp);return `${p.year}-${p.month}-${p.day}`;
}
export function addDays(date:string,days:number):string {
  return new Date(Date.parse(`${date}T12:00:00Z`)+days*86400_000).toISOString().slice(0,10);
}
export function parseCalendarTime(value:string):number {
  const date=value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(date){const check=new Date(Date.UTC(Number(date[1]),Number(date[2])-1,Number(date[3])));
    if(check.getUTCFullYear()!==Number(date[1])||check.getUTCMonth()+1!==Number(date[2])||check.getUTCDate()!==Number(date[3]))throw new Error("That calendar date does not exist.");}
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed=Date.parse(value);if(Number.isFinite(parsed))return parsed;
  }
  const match=value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if(!match)throw new Error("Use YYYY-MM-DD HH:mm in Pacific time, or an ISO time with an explicit offset.");
  const [,y,m,d,h,min]=match;
  const target=Date.UTC(Number(y),Number(m)-1,Number(d),Number(h),Number(min));
  let candidate=target;
  for(let i=0;i<3;i++){
    const p=localParts(candidate);
    const actual=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute));
    candidate+=target-actual;
  }
  const matches=(timestamp:number)=>{
    const p=localParts(timestamp);return p.year===y&&p.month===m&&p.day===d&&p.hour===h&&p.minute===min;
  };
  if(!matches(candidate))throw new Error("That local date/time doesn't exist. Check the date and daylight-saving transition.");
  if(matches(candidate-3600_000)||matches(candidate+3600_000))throw new Error("That time occurs twice during daylight saving. Use an ISO time with an explicit offset.");
  return candidate;
}
export function formatTime(timestamp:number):string {
  return new Date(timestamp).toLocaleString("en-US",{timeZone:TIMEZONE,weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
}
