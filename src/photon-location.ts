import { cloud } from "spectrum-ts";
import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";

export type LocationSnapshot = { latitude?:number;longitude?:number;locationType:string;locationTimestamp?:string|Date;isLocatingInProgress:boolean };
export function locationStatus(snapshot:LocationSnapshot,now=Date.now()):string {
  const hasCoordinates=Number.isFinite(snapshot.latitude)&&Number.isFinite(snapshot.longitude);
  const timestamp=snapshot.locationTimestamp instanceof Date?snapshot.locationTimestamp.getTime():snapshot.locationTimestamp?Date.parse(snapshot.locationTimestamp):NaN;
  const age=Number.isFinite(timestamp)?Math.max(0,Math.round((now-timestamp)/60000)):null;
  const sources:Record<string,string>={live:"live",shallow:"cached",legacy:"older cached",unknown:"unknown freshness"};
  return `Photon can read your shared Find My location. Coordinates: ${hasCoordinates?"available":"not available yet"}. Source: ${sources[snapshot.locationType]??"unknown freshness"}.${age===null?" Capture time wasn't provided.":` Snapshot age: about ${age} minute(s).`}${snapshot.isLocatingInProgress?" Your device is still locating.":""} ${snapshot.locationType==="live"&&hasCoordinates?"The API labels this snapshot live; continuous arrival detection isn't connected yet.":"A cached snapshot doesn't confirm continuous live updates. Arrival detection isn't connected yet."}`;
}
export async function getPhotonLocationStatus(address:string):Promise<string> {
  if(!/^\+[1-9]\d{6,14}$/.test(address)&&!/^\S+@\S+\.\S+$/.test(address))return "I couldn't identify your iMessage address for a location lookup.";
  const projectId=process.env.PROJECT_ID??process.env.SPECTRUM_PROJECT_ID;
  const secret=process.env.PROJECT_SECRET??process.env.SPECTRUM_PROJECT_SECRET;
  if(!projectId||!secret)return "The Photon project connection isn't configured.";
  try{
    const data=await cloud.issueImessageTokens(projectId,secret);
    const connections=data.type==="shared"
      ?[{address:process.env.SPECTRUM_IMESSAGE_ADDRESS??"imessage.spectrum.photon.codes:443",token:data.token}]
      :Object.entries(data.auth).map(([id,token])=>({address:`${id}.imsg.photon.codes:443`,token}));
    for(const connection of connections){
      const client=createGrpcClient({...connection,tls:true,timeout:15000,retry:false});
      try{return locationStatus(await client.locations.get(address));}
      catch{/* Try the same sender on another project line; never enumerate other people's shares. */}
      finally{await client.close();}
    }
    return "I couldn't read a shared location for your iMessage address. Check that you're sharing with this bot account; the chat notice alone isn't enough.";
  }catch{return "Photon's location lookup is unavailable right now. No coordinates or credentials were logged.";}
}
