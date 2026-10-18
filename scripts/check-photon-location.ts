import { cloud } from "spectrum-ts";
import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";

// Read-only diagnostic: one explicitly supplied address; never list other people's locations.
const address=process.argv[2];
if(!address||!/^\+[1-9]\d{6,14}$/.test(address))throw Error("Supply your own E.164 phone number as the argument.");
const projectId=process.env.PROJECT_ID??process.env.SPECTRUM_PROJECT_ID;
const secret=process.env.PROJECT_SECRET??process.env.SPECTRUM_PROJECT_SECRET;
if(!projectId||!secret)throw Error("Photon project credentials are missing.");
try{
  const data=await cloud.issueImessageTokens(projectId,secret);
  const connections=data.type==="shared"
    ?[{address:process.env.SPECTRUM_IMESSAGE_ADDRESS??"imessage.spectrum.photon.codes:443",token:data.token}]
    :Object.entries(data.auth).map(([id,token])=>({address:`${id}.imsg.photon.codes:443`,token}));
  console.log(`Read-only location check: ${data.type} routing, ${connections.length} connection(s).`);
  let found=false;
  for(const connection of connections){
    const client=createGrpcClient({...connection,tls:true,timeout:15000,retry:false});
    try{
      const location=await client.locations.get(address);
      const coordinates=Number.isFinite(location.latitude)&&Number.isFinite(location.longitude);
      const age=location.locationTimestamp?Math.max(0,Math.round((Date.now()-location.locationTimestamp.getTime())/60000)):null;
      console.log(JSON.stringify({locationVisible:true,coordinatesAvailable:coordinates,source:location.locationType,
        locating:location.isLocatingInProgress,ageMinutes:Number.isFinite(age)?age:null}));
      if(process.argv.includes("--watch")) {
        const stream=client.locations.watch(address);
        const timer=setTimeout(()=>void stream.close(),20000);
        let updates=0,live=0,withCoordinates=0;
        try {
          for await(const update of stream) {
            updates++;
            if(update.location.locationType==="live")live++;
            if(Number.isFinite(update.location.latitude)&&Number.isFinite(update.location.longitude))withCoordinates++;
          }
          console.log(JSON.stringify({watchSeconds:20,updates,liveUpdates:live,updatesWithCoordinates:withCoordinates}));
        } finally {clearTimeout(timer);await stream.close();}
      }
      found=true;break;
    }catch(error){console.log("Location API result:",String((error as {code?:unknown}).code??"unavailable"));}
    finally{await client.close();}
  }
  if(!found)console.log("No location snapshot verified. A sharing message alone does not prove this account can read Find My.");
}catch{console.error("Location check could not finish. No credentials or coordinates were logged.");process.exitCode=1;}
