import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {freshReading,distanceMeters} from './smart-prompts.ts';
import type {LocationSnapshot} from './photon-location.ts';
type Point=NonNullable<ReturnType<typeof freshReading>>;
type Session={id:string;startedAt:string};
type State={sessionId:string;baseline?:Point;settling:Point[];away:Point[];prompted?:boolean;pendingUntil?:number};
type Dependencies={session:(conversation:string)=>Promise<Session|null>;read:(conversation:string)=>Promise<LocationSnapshot|null>;send:(conversation:string,text:string)=>Promise<void>;now?:()=>number};
export class StudyDeparture {
 private locks=new Map<string,Promise<unknown>>();private now:()=>number;
 constructor(private deps:Dependencies,private directory=fileURLToPath(new URL('../data/departures/',import.meta.url))){this.now=deps.now??Date.now;}
 private async locked<T>(conversation:string,run:(path:string)=>Promise<T>):Promise<T>{
  const key=createHash('sha256').update(conversation).digest('hex'),prior=this.locks.get(key)??Promise.resolve();
  const next=prior.catch(()=>{}).then(()=>run(join(this.directory,key+'.json')));this.locks.set(key,next);
  try{return await next;}finally{if(this.locks.get(key)===next)this.locks.delete(key);}
 }
 private async load(path:string):Promise<State|null>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
 private async save(path:string,state:State){await mkdir(this.directory,{recursive:true});const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,path);}
 async tick(conversation:string):Promise<void>{return this.locked(conversation,async path=>{
  const session=await this.deps.session(conversation);if(!session)return;
  const previous=await this.load(path),state:State=previous?.sessionId===session.id?previous:{sessionId:session.id,settling:[],away:[]};
  if(state.prompted)return;
  let point:Point|null=null;try{const snapshot=await this.deps.read(conversation);point=snapshot?freshReading(snapshot,this.now()):null;}catch{/* Service failure cannot mean the user departed. */}
  if(!point||point.at<Date.parse(session.startedAt)){state.away=[];state.settling=[];await this.save(path,state);return;}
  const append=(list:Point[],p:Point)=>{const recent=list.filter(x=>p.at-x.at<=5*60000&&x.at<=p.at);if(recent.length&&p.at-recent.at(-1)!.at>2*60000)return [p];if(!recent.some(x=>x.at===p.at))recent.push(p);return recent.slice(-6);};
  const stable=(list:Point[])=>list.length>=3&&list.at(-1)!.at-list[0]!.at>=2*60000;
  if(!state.baseline){
   if(state.settling.some(p=>distanceMeters(p,point!)>75))state.settling=[];
   state.settling=append(state.settling,point);
   if(stable(state.settling))state.baseline=state.settling.at(-1)!;
   await this.save(path,state);return;
  }
  // Both readings' error radii must clear the departure threshold.
  const definitelyAway=distanceMeters(state.baseline,point)-state.baseline.accuracy-point.accuracy>150;
  state.away=definitelyAway?append(state.away,point):[];
  if(!stable(state.away)){await this.save(path,state);return;}
  const current=await this.deps.session(conversation);if(current?.id!==session.id)return;
  state.prompted=true;state.pendingUntil=this.now()+15*60000;await this.save(path,state);
  await this.deps.send(conversation,'It looks like you’ve left the spot where you were studying. Are you finished, taking a break, or still studying? Reply finished, break, or still studying. I haven’t ended your session.');
 });}
 async answer(conversation:string,text:string):Promise<{done:boolean;reply?:string}|null>{return this.locked(conversation,async path=>{
  const state=await this.load(path);if(!state?.pendingUntil||state.pendingUntil<this.now())return null;
  const session=await this.deps.session(conversation);if(session?.id!==state.sessionId){delete state.pendingUntil;await this.save(path,state);return null;}
  const command=text.trim().toLowerCase().replace(/[.!?]+$/,'');
  const done=/^(finished|i'?m finished|done|finished studying)$/.test(command),stay=/^(break|taking a break|i'?m taking a break|still studying|keep studying)$/.test(command);
  if(!done&&!stay)return null;
  delete state.pendingUntil;await this.save(path,state);
  return done?{done:true}:{done:false,reply:'Okay—I’ll leave your study session open and won’t send another departure check-in for this session. Text done when you finish.'};
 });}
}
