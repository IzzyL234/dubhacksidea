const id=location.pathname.split('/').pop(),storage='daywise:review:'+id;
let key=new URLSearchParams(location.hash.slice(1)).get('key')??'',busy=false;
// Remove the capability from the visible URL before requests or navigation.
history.replaceState(null,'',location.pathname);
try{if(key)sessionStorage.setItem(storage,key);else key=sessionStorage.getItem(storage)??'';}catch{}
const root=document.getElementById('review'),status=document.getElementById('status');
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=x=>new Date(x).toLocaleString('en-US',{timeZone:'America/Los_Angeles',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
async function load(action){
 if(busy)return;busy=true;root.querySelectorAll('button').forEach(b=>b.disabled=true);status.className='';status.textContent=action==='approve'?'Checking the event and destination before applying…':action==='deny'?'Dismissing this suggestion…':'Loading your private review…';
 try{
  if(!/^[A-Za-z0-9_-]{43}$/.test(key))throw Error('Open the full private review link from your bot message. A dashboard code cannot approve calendar changes.');
  const response=await fetch('/api/learning/reviews/'+id+(action?'/'+action:''),{method:action?'POST':'GET',headers:{Authorization:'Bearer '+key},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(25000)}),data=await response.json();
  if(!response.ok)throw Error(data.error??'Review temporarily unavailable. Retry this link.');
  render(data.review);status.textContent=data.review.status==='applied'?'Approved · Calendar updated.':data.review.status==='skipped'?'Denied · Your calendar is unchanged.':data.review.status==='stale'?'The calendar changed. Request a fresh review; nothing was moved.':'Review the suggestion below. All times are Pacific.';
 }catch(e){status.className='error';status.textContent=e.name==='TimeoutError'?'Could not confirm the result. Reload this same link to check safely.':e.message;}finally{busy=false;root.querySelectorAll('button').forEach(b=>b.disabled=false);}
}
function render(p){root.hidden=false;root.innerHTML=`<span class="badge">${esc(p.status.toUpperCase())} · ${p.overlapMinutes} MIN OVERLAP</span><h2>${esc(p.title)}</h2><p>${esc(p.reason)}</p><div class="comparison"><div><h3>Current time</h3><p>${time(p.before.start)}<br>to ${time(p.before.end)}</p></div><div><h3>Suggested time</h3><p>${p.after?time(p.after.start)+'<br>to '+time(p.after.end):'No safe automatic move found.'}</p></div></div><h3>Why suggest a change?</h3><ul>${p.conflicts.map(c=>`<li>Overlaps <strong>${esc(c.title)}</strong> · ${time(c.start)} to ${time(c.end)}</li>`).join('')}</ul>${p.after?`<p>The proposed slot removes the overlap, preserves the event’s duration, and moves it ${p.shiftMinutes} minutes. Nearby events keep a 10-minute buffer.</p>`:''}${p.model?`<p>Study model context: productivity ${p.model.productivity.toFixed(1)}/5 · mood ${p.model.mood.toFixed(1)}/5, based on ${p.model.observations} observations.</p>`:''}<p class="footnote">The scheduling rule finds an available slot with minimal movement. The learning model does not yet establish a time-of-day benefit. Before approval, Daywise rechecks the event version and calendar availability.</p><small>Link expires ${time(p.expiresAt)} Pacific.</small>${p.status==='pending'?`<div class="actions">${p.after?'<button id="approve">Approve calendar change</button>':''}<button class="secondary" id="deny">Deny suggestion</button></div>`:''}`;document.getElementById('approve')?.addEventListener('click',()=>load('approve'));document.getElementById('deny')?.addEventListener('click',()=>load('deny'));}
void load();
