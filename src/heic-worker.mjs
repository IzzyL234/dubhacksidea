import {parentPort,workerData} from 'node:worker_threads';
import convert from 'heic-convert';
try {
 const jpeg=await convert({buffer:Buffer.from(workerData),format:'JPEG',quality:0.85});
 parentPort.postMessage({bytes:new Uint8Array(jpeg)});
} catch {parentPort.postMessage({error:true});}
