const fs=require('fs'); const C=require(process.argv[2]);
const [post, accAfter, dropLevel] = [+process.argv[5], +process.argv[6], process.argv[7]==='1'];
const sr=16000, OFF=16.31;
const raw=fs.readFileSync(process.argv[3]); const x=new Float32Array(raw.buffer, raw.byteOffset, raw.length/4);
const csv=fs.readFileSync(process.argv[4],'utf8').trim().split('\n').slice(1).map(l=>l.split(',').map(Number));
const acc=csv.map(r=>({t:r[0]*1000,x:r[1],y:r[2],z:r[3]}));
const wins=[[25.5,31.3],[36.5,42.5],[46.4,52.3],[54.5,60.3],[64.6,70.4],[74.8,80.6],[85.7,91.8],[94.7,100.6]], labels=[3,1,4,2,2,4,1,3];
const det=new C.Detector(sr,{postMs:post}); const hits=[];
for(let i=0;i<x.length;i+=256){ const ch=x.subarray(i,i+256); det.process(ch,((i+ch.length)/sr-OFF)*1000,h=>hits.push(h)); }
const rows=[]; for(const h of hits){ const t=h.wallMs/1000; const g=wins.findIndex(([s,e])=>t>=s&&t<e); if(g<0) continue;
  let fa=C.audioFeatures(h.seg,sr); if(dropLevel) fa=fa.slice(0,-1);
  rows.push({g,spot:labels[g],pass:g<4?1:2,f:fa.concat(C.accelFeatures(acc,h.wallMs,40,accAfter))}); }
const cnt=Array(8).fill(0); rows.forEach(r=>cnt[r.g]++);
let accs=[]; for(const [tr,te] of [[1,2],[2,1]]){ const train=[]; [1,2,3,4].forEach(s=>train.push(...rows.filter(r=>r.pass===tr&&r.spot===s).slice(0,15)));
  const m=new C.Model().fit(train.map(r=>r.f),train.map(r=>r.spot)); const test=rows.filter(r=>r.pass===te);
  accs.push(test.filter(r=>m.predict(r.f).zone===r.spot).length/test.length); }
const lat = hits.map(h=>h.delayMs).sort((a,b)=>a-b);
console.log(`post=${post}ms accAfter=${accAfter}ms dropLevel=${dropLevel}: taps/group ${cnt.join(',')} | acc ${(accs[0]*100).toFixed(0)}% / ${(accs[1]*100).toFixed(0)}% | detect delay median ${lat[lat.length>>1].toFixed(0)}ms`);
