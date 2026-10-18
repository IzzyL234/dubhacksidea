export type NearbyPlace={id:string;name:string;label:"library"|"cafe";latitude:number;longitude:number};
type Point={latitude:number;longitude:number};
const distance=(a:Point,b:Point)=>{const r=Math.PI/180,x=Math.sin((b.latitude-a.latitude)*r/2)**2+Math.cos(a.latitude*r)*Math.cos(b.latitude*r)*Math.sin((b.longitude-a.longitude)*r/2)**2;return 6371000*2*Math.asin(Math.min(1,Math.sqrt(x)));};
export function parseNearby(data:unknown,point:Point):NearbyPlace[]{
 const elements=(data as {elements?:unknown[]})?.elements;if(!Array.isArray(elements)||elements.length>2000)throw Error("Invalid place response");
 const places:NearbyPlace[]=[];
 for(const raw of elements){const e=raw as {type?:string;id?:number;lat?:number;lon?:number;center?:{lat?:number;lon?:number};tags?:{name?:string;amenity?:string}};
 const label=e.tags?.amenity,name=e.tags?.name?.replace(/[\x00-\x1f\x7f]/g," ").trim().slice(0,80),latitude=e.lat??e.center?.lat,longitude=e.lon??e.center?.lon;
 if(!name||!['library','cafe'].includes(label??'')||!['node','way','relation'].includes(e.type??'')||!Number.isSafeInteger(e.id)||typeof latitude!=='number'||typeof longitude!=='number'||!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180)continue;
 const place={id:`osm:${e.type}:${e.id}`,name,label:label as 'library'|'cafe',latitude,longitude};if(distance(point,place)<=150)places.push(place);
 }
 const sorted=places.sort((a,b)=>distance(point,a)-distance(point,b));return sorted.filter((p,i)=>!sorted.slice(0,i).some(q=>q.name.toLowerCase()===p.name.toLowerCase()&&distance(p,q)<80));
}
// Rounded query coordinates reduce precision sent to the public map service. Never include sender identifiers.
export async function lookupNearby(point:Point,request:typeof fetch=fetch):Promise<NearbyPlace[]>{
 if(!Number.isFinite(point.latitude)||!Number.isFinite(point.longitude)||Math.abs(point.latitude)>90||Math.abs(point.longitude)>180)throw Error("Invalid point");
 const lat=point.latitude.toFixed(3),lon=point.longitude.toFixed(3);
 const query=`[out:json][timeout:10];nwr(around:350,${lat},${lon})[amenity~"^(library|cafe)$"][name];out center;`;
 for(const endpoint of ['https://overpass.private.coffee/api/interpreter','https://overpass-api.de/api/interpreter']){
  try{
   const response=await request(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'StudyAgentHackathon/1.0'},body:new URLSearchParams({data:query}),signal:AbortSignal.timeout(12000),redirect:'error'});
   if(!response.ok)continue;
   const text=await response.text();if(text.length>1000000)continue;
   return parseNearby(JSON.parse(text),point);
  }catch{/* Try the documented fallback sequentially; never log coordinates or query URLs. */}
 }
 throw Error('Nearby lookup unavailable');
}
export function chooseNearby(places:NearbyPlace[],point:Point):NearbyPlace|null{
 const sorted=[...places].sort((a,b)=>distance(point,a)-distance(point,b));const first=sorted[0];
 if(!first||distance(point,first)>150)return null;
 if(sorted[1]&&distance(point,sorted[1])-distance(point,first)<40)return null;return first;
}
