// Reproducible synthetic outcomes, sampled independently of place category.
// Existing productivity, mood, photo tags and IDs are preserved.
import {createHash} from 'node:crypto';
const file=new URL('../data/seed_sessions.json',import.meta.url);
const rows=await Bun.file(file).json();
for(const row of rows){const bytes=createHash('sha256').update('distraction-v1:'+row.id).digest(),rating=1+bytes[0]!%5;
 const attribution=rating>=4?['interruption','setup','unsure'][bytes[1]!%3]:null;
 row.user_distraction_rating=rating;row.distraction_attribution=attribution;
 row.distraction_source=rating<4?null:attribution==='setup'?'surroundings':attribution==='interruption'?'phone':'other';
}
await Bun.write(file,JSON.stringify(rows,null,2)+'\n');
console.log(`Updated distraction fields for ${rows.length} starter sessions.`);
