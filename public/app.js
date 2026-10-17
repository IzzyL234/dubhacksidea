const $=id=>document.getElementById(id);
let token='';
const notice=message=>{$('notice').textContent=message;};
async function api(path,body) {
  const result=await fetch(`/api/${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await result.json();if(!result.ok)throw new Error(data.error);return data;
}
function row(parent,content) {const div=document.createElement('div');div.className='row';div.textContent=content;parent.append(div);return div;}
function button(parent,label,action) {const b=document.createElement('button');b.textContent=label;b.onclick=()=>run(action);parent.append(b);}
const when=s=>new Date(s).toLocaleString();
const offset=()=>-new Date().getTimezoneOffset();
async function run(action) {try {notice('');await action();} catch(e){notice(e.message);}}
function values(form){return Object.fromEntries(new FormData(form));}
function times(v) {for(const k of ['start','end']){if(v[k])v[k]=new Date(v[k]).toISOString();else delete v[k];}return v;}
function form(id,action) {$(id).onsubmit=e=>{e.preventDefault();run(()=>action(values(e.target)));};}
async function refresh() {
  const state=await api('status');
  $('connections').textContent=`${state.integrations.storage} · ${state.integrations.calendar?'Google Calendar connected':'Local calendar demo'} · ${state.rated} study ratings`;
  $('sessions').replaceChildren();
  for(const s of [...state.sessions].reverse()) {
    const el=row($('sessions'),`${s.title} · ${when(s.start)} · ${s.rating?`Rating: ${s.rating}/5`:'Unrated'}`);
    const small=document.createElement('div');small.className='hint';small.textContent=`ID: ${s.id}`;el.append(small);
    if(Date.parse(s.end)<=Date.now()) for(let n=1;n<=5;n++)button(el,String(n),async()=>{await api('ratings',{id:s.id,rating:n});await refresh();});
  }
  $('events').replaceChildren();
  for(const e of state.events) {
    const el=row($('events'),`${e.title} · ${when(e.start)} – ${when(e.end)} · ${e.status}${e.localOnly?' (local demo)':''}`);
    if(e.status==='proposed')button(el,state.integrations.calendar?'Confirm & add to Google Calendar':'Confirm local commitment',async()=>{await api('confirm',{id:e.id});await refresh();notice('Event confirmed.');});
    if(e.calendarUrl){const a=document.createElement('a');a.href=e.calendarUrl;a.textContent='View on Google Calendar';a.rel='noopener';a.target='_blank';el.append(a);}
  }
  $('prompts').replaceChildren();for(const p of state.prompts.filter(p=>!p.delivered&&Date.parse(p.expiresAt)>Date.now())) {const el=row($('prompts'),p.text);button(el,'Dismiss',async()=>{await api('ack',{id:p.id});await refresh();});}
}
$('connect').onclick=()=>run(async()=>{token=$('token').value;await refresh();notice('Connected. Your token stays in this page’s memory.');});
form('slots',async v=>{const result=await api('slots',{...v,offsetMinutes:offset()});$('slot-list').replaceChildren();row($('slot-list'),result.availabilitySource);if(!result.slots.length)row($('slot-list'),'No available slots. Try a shorter block.');for(const s of result.slots){const el=row($('slot-list'),`${when(s.start)} · predicted ${s.predictedRating}/5 (${s.evidence} relevant ratings)`);button(el,'Choose this block',async()=>{const title=$('session').elements.title.value||'Study block';await api('proposals',{...s,title,study:true});await refresh();notice('Study block proposed. Review and confirm it below.');});}});
form('session',async v=>{const localHour=new Date(v.start).getHours();await api('sessions',{...times(v),localHour});await refresh();notice('Session saved.');});
form('decision',async v=>{v.weights={};for(const k of ['academic','social','wellbeing','career']){v.weights[k]=Number(v[`w_${k}`]);delete v[`w_${k}`];}const result=await api('decisions',times(v));$('decision-result').replaceChildren();const el=row($('decision-result'),`${result.recommendation} · ${result.score}/100`);row(el,result.explanation);row(el,`Benefits: ${Object.entries(result.contributions).map(([k,n])=>`${k} ${n.toFixed(1)}`).join(' · ')}. Penalties: cost ${result.penalties.opportunityCost}, energy ${result.penalties.lowEnergy}.`);});
form('proposal',async v=>{await api('proposals',times(v));await refresh();notice('Proposal ready for review below.');});
form('flyer',async v=>{let body={text:v.text};if(v.image?.size){if(v.image.size>4_000_000)throw new Error('Choose an image under 4 MB');const bytes=new Uint8Array(await v.image.arrayBuffer());let binary='';for(const b of bytes)binary+=String.fromCharCode(b);body={image:btoa(binary)};}const result=await api('flyer',body);$('flyer-result').textContent=`${result.title}\nDate hint: ${result.dateHint??'Please enter manually'}\nTime hint: ${result.timeHint??'Please enter manually'}\nLocation: ${result.locationHint??'Please enter manually'}\n\n${result.text}`;$('proposal').elements.title.value=result.title;});
form('chat',async v=>{const result=await api('messages',{...v,id:crypto.randomUUID(),offsetMinutes:offset()});$('reply').textContent=result.reply;await refresh();});
$('check-prompts').onclick=()=>run(async()=>{await api('tick',{});await refresh();});
setInterval(()=>{if(token)run(refresh);},60000);
