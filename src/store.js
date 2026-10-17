import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

export class Store {
  constructor(path='data/agent.sqlite') {
    mkdirSync(dirname(path),{recursive:true}); this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id))');
  }
  async list(kind) { return this.db.prepare('SELECT body FROM records WHERE kind=?').all(kind).map(x=>JSON.parse(x.body)); }
  async put(kind,body) {
    body={...body,id:body.id??randomUUID()};
    this.db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind,body.id,JSON.stringify(body)); return body;
  }
  close() {this.db.close();}
}
export class SupabaseStore {
  constructor(url,key,request=fetch) {this.url=url.replace(/\/$/,'');this.key=key;this.request=request;}
  async call(path,options={}) {
    const r=await this.request(`${this.url}/rest/v1/agent_records${path}`,{...options,headers:{apikey:this.key,Authorization:`Bearer ${this.key}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=representation'},signal:AbortSignal.timeout(15000)});
    if(!r.ok) throw new Error(`Supabase request failed (${r.status})`);
    return r.json();
  }
  async list(kind) {return (await this.call(`?kind=eq.${encodeURIComponent(kind)}&select=body`)).map(x=>x.body);}
  async put(kind,body) {body={...body,id:body.id??randomUUID()};await this.call('?on_conflict=kind,id',{method:'POST',body:JSON.stringify({kind,id:body.id,body})});return body;}
  close() {}
}
