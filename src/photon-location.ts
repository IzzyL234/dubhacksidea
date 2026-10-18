import { cloud } from "spectrum-ts";
import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";

export type LocationSnapshot = { latitude?:number;longitude?:number;accuracy?:number;expiresAt?:string|Date;locationType:string;locationTimestamp?:string|Date;isLocatingInProgress:boolean };
export function locationStatus(snapshot:LocationSnapshot,now=Date.now()):string {
  const hasCoordinates=Number.isFinite(snapshot.latitude)&&Number.isFinite(snapshot.longitude);
  const timestamp=snapshot.locationTimestamp instanceof Date?snapshot.locationTimestamp.getTime():snapshot.locationTimestamp?Date.parse(snapshot.locationTimestamp):NaN;
  const age=Number.isFinite(timestamp)?Math.max(0,Math.round((now-timestamp)/60000)):null;
  const sources:Record<string,string>={live:"live",shallow:"cached",legacy:"older cached",unknown:"unknown freshness"};
  return `Photon can read your shared Find My location. Coordinates: ${hasCoordinates?"available":"not available yet"}. Source: ${sources[snapshot.locationType]??"unknown freshness"}.${age===null?" Capture time wasn't provided.":` Snapshot age: about ${age} minute(s).`}${snapshot.isLocatingInProgress?" Your device is still locating.":""} ${snapshot.locationType==="live"&&hasCoordinates?"The API labels this snapshot live; smart prompts require several fresh readings and explicit setup.":"A cached snapshot doesn't confirm continuous live updates. Use smart prompts on only after saving a named place."}`;
}
export async function getPhotonLocationStatus(address:string):Promise<string> {
  try { return locationStatus(await readPhotonLocation(address)); }
  catch { return "I couldn't read a shared location for your iMessage address. Check that you're sharing with this bot account; the chat notice alone isn't enough."; }
}
export async function readPhotonLocation(address:string):Promise<LocationSnapshot> {
  if(!/^\+[1-9]\d{6,14}$/.test(address)&&!/^\S+@\S+\.\S+$/.test(address))throw Error("Invalid sender address");
  const projectId=process.env.PROJECT_ID??process.env.SPECTRUM_PROJECT_ID;
  const secret=process.env.PROJECT_SECRET??process.env.SPECTRUM_PROJECT_SECRET;
  if(!projectId||!secret)throw Error("Photon project connection missing");
  try{
    const data=await cloud.issueImessageTokens(projectId,secret);
    const connections=data.type==="shared"
      ?[{address:process.env.SPECTRUM_IMESSAGE_ADDRESS??"imessage.spectrum.photon.codes:443",token:data.token}]
      :Object.entries(data.auth).map(([id,token])=>({address:`${id}.imsg.photon.codes:443`,token}));
    for(const connection of connections){
      const client=createGrpcClient({...connection,tls:true,timeout:15000,retry:false});
      try{return await client.locations.get(address);}
      catch{/* Try the same sender on another project line; never enumerate other people's shares. */}
      finally{await client.close();}
    }
    throw Error("No visible location");
  }catch{throw Error("Photon location unavailable");}
}
