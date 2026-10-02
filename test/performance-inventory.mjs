// Manual Node benchmark; synthetic data, no browser API or network.
import { inventory } from '../extension/src/inventory.js';
const groups = Array.from({length:2000}, (_,id)=>({id,windowId:1,title:`Group ${id}`,color:'blue'}));
const tabs = groups.map(g=>({id:g.id,groupId:g.id,windowId:1,url:`https://host${g.id%100}.example/path`,title:'Example'}));
for(let i=0;i<10;i++) inventory(tabs,false,2000,groups);
const times=[];
for(let i=0;i<100;i++){const start=performance.now();inventory(tabs,false,2000,groups);times.push(performance.now()-start);}
times.sort((a,b)=>a-b);
console.log(JSON.stringify({tabs:tabs.length,groups:groups.length,medianMs:times[50],p95Ms:times[95]}));

const oversized = [{id:1,windowId:1,url:'https://example.com/',title:'😀'.repeat(500000)}];
const start=performance.now();
for(let i=0;i<10;i++) inventory(oversized);
console.log(JSON.stringify({oversizedTitleCodePoints:500000,runs:10,totalMs:performance.now()-start}));
