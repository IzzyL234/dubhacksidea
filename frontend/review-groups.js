export function reviewGroups(rows){
 const groups=[['Pending reviews',['pending'],'No pending calendar reviews.'],['Approved conflicts',['applied'],'No confirmed calendar changes yet.'],['Other reviews',['skipped','stale'],'No denied or outdated reviews.']];
 return groups.map(([label,statuses,empty])=>{const matches=rows.filter(p=>statuses.includes(p.status)).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));return {label,empty,total:matches.length,rows:matches.slice(0,8)};});
}
