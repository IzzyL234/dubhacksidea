import catalog from '../data/uw-seattle-buildings.json';
import type {NearbyPlace} from './nearby-places.ts';
export type Point={latitude:number;longitude:number};
export type CampusBuilding={id:string;name:string;code:string;polygons:number[][][][]};
export const campusBuildings:CampusBuilding[]=catalog.buildings;
const scale=111195;
function ringContains(ring:number[][],point:Point):boolean{
 let inside=false;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const a=ring[i]!,b=ring[j]!;
  if((a[1]!>point.latitude)!==(b[1]!>point.latitude)&&point.longitude<(b[0]!-a[0]!)*(point.latitude-a[1]!)/(b[1]!-a[1]!)+a[0]!)inside=!inside;
 }
 return inside;
}
export function footprintDistance(building:CampusBuilding,point:Point):number{
 if(!Number.isFinite(point.latitude)||!Number.isFinite(point.longitude))return Infinity;
 let best=Infinity;const xScale=scale*Math.cos(point.latitude*Math.PI/180);
 for(const polygon of building.polygons){
  if(polygon[0]&&ringContains(polygon[0],point)&&!polygon.slice(1).some(r=>ringContains(r,point)))return 0;
  for(const ring of polygon)for(let i=1;i<ring.length;i++){
   const a=ring[i-1]!,b=ring[i]!;
   const ax=(a[0]!-point.longitude)*xScale,ay=(a[1]!-point.latitude)*scale,bx=(b[0]!-point.longitude)*xScale,by=(b[1]!-point.latitude)*scale;
   const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));
   best=Math.min(best,Math.hypot(ax+t*dx,ay+t*dy));
  }
 }
 return best;
}
export function matchCampusBuilding(point:Point,accuracy:number,buildings:CampusBuilding[]=campusBuildings):CampusBuilding|null{
 if(!Number.isFinite(accuracy)||accuracy<=0||accuracy>100)return null;
 const ranked=buildings.map(building=>({building,distance:footprintDistance(building,point)})).sort((a,b)=>a.distance-b.distance);
 const first=ranked[0];if(!first||first.distance>25)return null;
 // Do not choose a building if the phone's accuracy radius also reaches another footprint.
 if(ranked[1]&&ranked[1].distance<=Math.max(accuracy,first.distance+10))return null;
 return first.building;
}
export function matchesCampusPlace(id:string,point:Point&{accuracy:number}):boolean{return matchCampusBuilding(point,point.accuracy)?.id===id;}
export async function lookupCampusBuildings(point:Point&{accuracy?:number}):Promise<NearbyPlace[]>{
 const building=matchCampusBuilding(point,point.accuracy??100);if(!building)return [];
 const ring=building.polygons[0]?.[0];if(!ring?.length)return [];
 const longitude=ring.reduce((n,p)=>n+p[0]!,0)/ring.length,latitude=ring.reduce((n,p)=>n+p[1]!,0)/ring.length;
 return [{id:building.id,name:`${building.name} (${building.code})`,label:'campus_building',latitude,longitude}];
}
