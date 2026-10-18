import { parseLocationLink } from "./location.ts";
type Test = {expires:number;counts:Record<string,number>;pins:number;coordinateMessages:number;seen:Set<string>};
const types=new Set(["text","richlink","attachment","custom","group","contact","voice","reaction","poll","read"]);
function coordinates(value:unknown,depth=0):boolean {
  if(!value||typeof value!=="object"||depth>3)return false;
  const v=value as Record<string,unknown>;
  if((typeof v.latitude==="number"&&typeof v.longitude==="number")||(typeof v.lat==="number"&&(typeof v.lon==="number"||typeof v.lng==="number")))return true;
  return Object.values(v).slice(0,20).some(child=>coordinates(child,depth+1));
}
export class LocationDiagnostics {
  private tests=new Map<string,Test>();
  constructor(private now=Date.now){}
  handle(conversation:string,text:string):string|null {
    const command=text.trim().toLowerCase();
    if(command==="location test"){
      this.tests.set(conversation,{expires:this.now()+10*60000,counts:{},pins:0,coordinateMessages:0,seen:new Set()});
      return "Location test is on for 10 minutes. Share My Location → Indefinitely in this iMessage chat, then text location test status. I count message types only; I don't save coordinates or raw messages. This test doesn't enable tracking.";
    }
    if(command==="location test stop"){this.tests.delete(conversation);return "Location test stopped and its counters cleared.";}
    if(command!=="location test status")return null;
    const state=this.active(conversation);
    if(!state)return "No active location test. Text location test to start.";
    const counts=Object.entries(state.counts).map(([type,count])=>`${type}: ${count}`).join(", ")||"none yet";
    return `Location test — received messages: ${counts}. Readable map links: ${state.pins}. Custom messages with coordinate-shaped fields: ${state.coordinateMessages}. A pin or sharing notice alone doesn't prove live updates; a separate Photon location API may be needed.`;
  }
  private active(conversation:string):Test|undefined {
    for(const[key,test]of this.tests)if(test.expires<=this.now())this.tests.delete(key);
    return this.tests.get(conversation);
  }
  observe(conversation:string,id:string,content:{type:string;text?:string;url?:string;raw?:unknown}):void {
    const state=this.active(conversation);if(!state||state.seen.has(id))return;
    if(content.type==="text"&&/^location test(?: status| stop)?$/i.test(content.text?.trim()??""))return;
    if(state.seen.size>=200)return; // Bound this temporary diagnostic session.
    state.seen.add(id);const type=types.has(content.type)?content.type:"other";state.counts[type]=(state.counts[type]??0)+1;
    if((content.type==="text"||content.type==="richlink")&&parseLocationLink(content.text??content.url??""))state.pins++;
    if(content.type==="custom"&&coordinates(content.raw))state.coordinateMessages++;
  }
}
