import { cloud } from "spectrum-ts";
import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";

export type LocationFailureKind="service_error"|"timeout"|"not_shared"|"authentication"|"configuration"|"unavailable";
export class PhotonLocationError extends Error {constructor(readonly kind:LocationFailureKind){super("Photon location: "+kind);this.name="PhotonLocationError";}}
export function locationFailureKind(error:unknown):LocationFailureKind {
 if(error instanceof PhotonLocationError)return error.kind;
 const e=error as {code?:unknown;grpcCode?:unknown;status?:unknown}|null;const code=e?.code;
 if(code==="sharedFriendLocationNotFound"||code==="addressNotFound")return "not_shared";
 if(["unauthenticated","unauthorized","tokenExpired","tokenBlocked"].includes(String(code))||e?.status===401||e?.status===403)return "authentication";
 if(code==="timeout"||e?.grpcCode===4)return "timeout";
 if(["internalError","serviceUnavailable","privateApiUnavailable","databaseError","networkError"].includes(String(code))||e?.grpcCode===13||e?.grpcCode===14)return "service_error";
 return "unavailable";
}
export function locationFailureReply(error:unknown):string{
 const kind=locationFailureKind(error);
 if(kind==="service_error")return "Photon's location service returned an error before I could retrieve a snapshot. I haven't checked your building yet. This doesn't prove location sharing stopped. Try live location status again shortly.";
 if(kind==="timeout")return "Photon's location lookup timed out before returning a snapshot. Try live location status again shortly.";
 if(kind==="not_shared")return "Photon couldn't find a shared location for your iMessage address. Check Find My sharing with this bot account, then try live location status.";
 if(kind==="authentication"||kind==="configuration")return "The bot's Photon connection needs checking. Verify the project's credentials in the Photon dashboard; don't send secrets in chat.";
 return "The location lookup failed before a snapshot was available. Try live location status again; I haven't identified your building.";
}

export type LocationSnapshot = { latitude?:number;longitude?:number;accuracy?:number;expiresAt?:string|Date;locationType:string;locationTimestamp?:string|Date;isLocatingInProgress:boolean };
export function locationStatus(snapshot:LocationSnapshot,now=Date.now()):string {
  const hasCoordinates=Number.isFinite(snapshot.latitude)&&Number.isFinite(snapshot.longitude);
  const timestamp=snapshot.locationTimestamp instanceof Date?snapshot.locationTimestamp.getTime():snapshot.locationTimestamp?Date.parse(snapshot.locationTimestamp):NaN;
  const age=Number.isFinite(timestamp)?Math.max(0,Math.round((now-timestamp)/60000)):null;
  const sources:Record<string,string>={live:"live",shallow:"cached",legacy:"older cached",unknown:"unknown freshness"};
  return `Photon can read your shared Find My location. Coordinates: ${hasCoordinates?"available":"not available yet"}. Source: ${sources[snapshot.locationType]??"unknown freshness"}.${age===null?" Capture time wasn't provided.":` Snapshot age: about ${age} minute(s).`}${snapshot.isLocatingInProgress?" Your device is still locating.":""} ${snapshot.locationType==="live"&&hasCoordinates?"The API labels this snapshot live; smart prompts require several fresh readings and explicit setup.":"A cached snapshot doesn't confirm continuous live updates. Text where am i for a UW building estimate; smart prompts on enables automatic checks."}`;
}
export async function getPhotonLocationStatus(address:string,read:(address:string)=>Promise<LocationSnapshot>=readPhotonLocation):Promise<string> {
  try { return locationStatus(await read(address)); }
  catch(error) { return locationFailureReply(error); }
}
export async function readPhotonLocation(address:string):Promise<LocationSnapshot> {
  if(!/^\+[1-9]\d{6,14}$/.test(address)&&!/^\S+@\S+\.\S+$/.test(address))throw new PhotonLocationError("configuration");
  const projectId=process.env.PROJECT_ID??process.env.SPECTRUM_PROJECT_ID;
  const secret=process.env.PROJECT_SECRET??process.env.SPECTRUM_PROJECT_SECRET;
  if(!projectId||!secret)throw new PhotonLocationError("configuration");
  try{
    const data=await cloud.issueImessageTokens(projectId,secret);
    const connections=data.type==="shared"
      ?[{address:process.env.SPECTRUM_IMESSAGE_ADDRESS??"imessage.spectrum.photon.codes:443",token:data.token}]
      :Object.entries(data.auth).map(([id,token])=>({address:`${id}.imsg.photon.codes:443`,token}));
    let failure:LocationFailureKind="unavailable";
    for(const connection of connections){
      const client=createGrpcClient({...connection,tls:true,timeout:15000,retry:false});
      try{return await client.locations.get(address);}
      catch(error){failure=locationFailureKind(error);/* Only the same sender on project lines. */}
      finally{await client.close();}
    }
    throw new PhotonLocationError(failure);
  }catch(error){throw new PhotonLocationError(locationFailureKind(error));}
}
