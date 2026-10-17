// Photon iMessage Kit 3.0.0 only; macOS + Full Disk Access, Node 24.
import {IMessageSDK} from '@photon-ai/imessage-kit';
const {APP_TOKEN,PHOTON_PARTICIPANT,AGENT_URL='http://127.0.0.1:3000'}=process.env;
if(process.platform!=='darwin')throw new Error('Photon iMessage Kit requires macOS. Run the dashboard on Windows or move this project to a Mac.');
if(!APP_TOKEN||!PHOTON_PARTICIPANT)throw new Error('Set APP_TOKEN and PHOTON_PARTICIPANT');
if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(AGENT_URL))throw new Error('Bridge requires a loopback agent URL');
const sdk=new IMessageSDK();
async function api(path,body) {const r=await fetch(`${AGENT_URL}/api/${path}`,{method:'POST',headers:{Authorization:`Bearer ${APP_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`Agent request failed (${r.status})`);return r.json();}
await sdk.startWatching({onDirectMessage:async msg=>{
  if(msg.isFromMe||msg.participant!==PHOTON_PARTICIPANT||!msg.text||!msg.chatId)return;
  try {const result=await api('messages',{id:msg.id,text:msg.text,offsetMinutes:-new Date().getTimezoneOffset()});await sdk.send({to:msg.chatId,text:result.reply});}
  catch {console.error('Incoming command failed; inspect the dashboard.');}
},onError:()=>console.error('Photon watcher error')});
let polling=false;
const timer=setInterval(async()=>{if(polling)return;polling=true;try {for(const prompt of await api('tick',{})) {await sdk.send({to:PHOTON_PARTICIPANT,text:prompt.text});await api('ack',{id:prompt.id});}}catch {console.error('Prompt delivery failed; will retry.');}finally{polling=false;}},60000);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{clearInterval(timer);await sdk.close();process.exit();});
console.log('Photon bridge listening for the configured participant.');
