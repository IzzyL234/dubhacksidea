import {test,expect} from "bun:test";
import {readFile} from "node:fs/promises";
import {photoMime,photoAttachment,preparePhoto,sniffPhoto} from "../src/photo-input.ts";
import {analyzePhoto} from "../src/vision.ts";
test("iPhone HEIC converts to JPEG locally before Perceptron analysis",async()=>{
 const bytes=await readFile(new URL("./fixtures/synthetic-workspace.heic",import.meta.url));expect(sniffPhoto(bytes)).toBe("image/heic");
 const prepared=await preparePhoto(bytes);expect(prepared.mime).toBe("image/jpeg");expect(sniffPhoto(prepared.bytes)).toBe("image/jpeg");
 let calls=0;const result=await analyzePhoto(bytes,"image/heic","test-only",async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));expect(body.messages[0].content[1].image_url.url).toStartWith("data:image/jpeg;base64,");return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({lighting:"bright",clutter_score:2,ergonomics:null})}}]});});
 expect(result.clutter_score).toBe(2);expect(calls).toBe(1);
});
test("image signatures handle incorrect MIME labels and reject unrelated or oversized files",async()=>{
 expect(photoAttachment("application/octet-stream","photo.heic")).toBe(true);expect(photoAttachment("text/plain","notes.txt")).toBe(false);expect(photoMime("IMAGE/JPG; charset=binary")).toBe("image/jpeg");
 const jpeg=new Uint8Array([255,216,255,224]);expect((await preparePhoto(jpeg)).mime).toBe("image/jpeg");
 await expect(preparePhoto(new Uint8Array([1]))).rejects.toThrow("PHOTO_FORMAT_UNSUPPORTED");await expect(preparePhoto(new Uint8Array(8_000_001))).rejects.toThrow("PHOTO_SIZE_LIMIT");
 const heic=await readFile(new URL("./fixtures/synthetic-workspace.heic",import.meta.url));await expect(preparePhoto(heic,async()=>new Uint8Array([1]))).rejects.toThrow("PHOTO_CONVERSION_FAILED");
});
