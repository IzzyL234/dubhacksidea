import {Worker} from "node:worker_threads";
export const PHOTO_LIMIT=8_000_000;
export function photoMime(mime:string):string{return mime.split(";")[0]!.trim().toLowerCase().replace(/^image\/(?:jpg|pjpeg)$/,"image/jpeg");}
export function photoAttachment(mime:string,name=""):boolean{return photoMime(mime).startsWith("image/")||photoMime(mime)==="application/octet-stream"||/\.(?:jpe?g|png|webp|hei[cf])$/i.test(name);}
export function sniffPhoto(bytes:Uint8Array):"image/jpeg"|"image/png"|"image/webp"|"image/heic"|null{
 const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)return "image/jpeg";
 if(b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return "image/png";
 if(b.length>=12&&b.toString("ascii",0,4)==="RIFF"&&b.toString("ascii",8,12)==="WEBP")return "image/webp";
 if(b.length>=16&&b.toString("ascii",4,8)==="ftyp"&&/^(?:heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(b.toString("ascii",8,12)))return "image/heic";
 return null;
}
export function convertHeic(bytes:Uint8Array):Promise<Uint8Array>{return new Promise((resolve,reject)=>{
 const worker=new Worker(new URL("./heic-worker.mjs",import.meta.url),{workerData:bytes,resourceLimits:{maxOldGenerationSizeMb:512}});
 const timer=setTimeout(()=>{void worker.terminate();reject(Error("PHOTO_CONVERSION_TIMEOUT"));},30000);
 worker.once("message",(result:{bytes?:Uint8Array;error?:boolean})=>{clearTimeout(timer);void worker.terminate();result.bytes?resolve(new Uint8Array(result.bytes)):reject(Error("PHOTO_CONVERSION_FAILED"));});
 worker.once("error",()=>{clearTimeout(timer);reject(Error("PHOTO_CONVERSION_FAILED"));});
 worker.once("exit",code=>{clearTimeout(timer);reject(Error("PHOTO_CONVERSION_FAILED"));});
});}
export async function preparePhoto(bytes:Uint8Array,convert=convertHeic):Promise<{bytes:Uint8Array;mime:string}>{
 if(!bytes.length||bytes.length>PHOTO_LIMIT)throw Error("PHOTO_SIZE_LIMIT");
 const mime=sniffPhoto(bytes);if(!mime)throw Error("PHOTO_FORMAT_UNSUPPORTED");
 if(mime!=="image/heic")return {bytes,mime};
 const jpeg=await convert(bytes);if(jpeg.length>PHOTO_LIMIT)throw Error("PHOTO_SIZE_LIMIT");if(sniffPhoto(jpeg)!=="image/jpeg")throw Error("PHOTO_CONVERSION_FAILED");
 return {bytes:jpeg,mime:"image/jpeg"};
}
