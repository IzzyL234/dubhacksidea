export const PLACES=[['library','Library'],['cafe','Cafe'],['home','Home'],['dorm_room','Dorm room'],['classroom','Classroom']];
export function placeScore(snapshot,place,target){
 if(!PLACES.some(p=>p[0]===place)||!(snapshot?.model?.totalObservations??snapshot?.model?.observations))return null;
 const active=['bias',...(place==='home'?[]:['location:'+place]),'missing:study_space','missing:clutter','missing:lighting','missing:ergonomics','missing:duration'];let score=3;
 for(const feature of active){const value=snapshot.model.weights?.find(w=>w.feature===feature)?.[target];if(!Number.isFinite(value))return null;score+=value;}
 return Math.min(5,Math.max(1,score));
}
export function distractionScore(snapshot,place){
 const ratings=(snapshot?.history??[]).filter(h=>Number.isInteger(h.distraction)&&h.distraction>=1&&h.distraction<=5),matching=ratings.filter(h=>h.place===place);
 const aggregated=snapshot?.insights?.places?.find(p=>p.place===place&&Number.isFinite(p.averageDistraction));
 if(aggregated)return {value:aggregated.averageDistraction,overall:false,count:aggregated.count};
 const selected=matching.length?matching:ratings;return {value:selected.length?selected.reduce((a,h)=>a+h.distraction,0)/selected.length:null,overall:!matching.length,count:selected.length};
}
