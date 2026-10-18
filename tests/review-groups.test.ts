import {test,expect} from 'bun:test';
import {reviewGroups} from '../frontend/review-groups.js';
test('approved conflicts contain only confirmed applied receipts and are not buried by pending rows',()=>{
 const rows=Array.from({length:12},(_,i)=>({id:String(i),status:'pending',createdAt:new Date(i*1000).toISOString()}));rows.push({id:'approved',status:'applied',createdAt:new Date(0).toISOString()});rows.push({id:'denied',status:'skipped',createdAt:new Date(0).toISOString()});
 const groups=reviewGroups(rows);expect(groups[0]?.total).toBe(12);expect(groups[0]?.rows.length).toBe(8);expect(groups[1]?.rows.map(p=>p.id)).toEqual(['approved']);expect(groups[2]?.rows.map(p=>p.id)).toEqual(['denied']);
});
