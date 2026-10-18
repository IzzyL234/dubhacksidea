import {fileURLToPath} from 'node:url';
const result=await Bun.build({entrypoints:[fileURLToPath(new URL('../src/hosted-entry.ts',import.meta.url))],outdir:fileURLToPath(new URL('../api/',import.meta.url)),naming:'index.mjs',target:'node',format:'esm'});
if(!result.success)throw Error(result.logs.map(String).join('\n'));
console.log('Built the self-contained hosted dashboard API.');
