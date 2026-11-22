// Saved-route storage and comparison. No live measurement or network requests.
((root) => {
  "use strict";
  // Validate existing saved step totals for backward compatibility; no new counting.
  const integer=n=>Number.isSafeInteger(n)&&n>=0&&n<=1e9;
  function validLegacySteps(s) {
    if(!s||s.version!==1||!integer(s.sensorSteps)||!integer(s.estimatedSteps)
      ||!Number.isInteger(s.goal)||s.goal<1||s.goal>100000||!Number.isInteger(s.strideCm)||s.strideCm<30||s.strideCm>150
      ||!Number.isFinite(s.remainderMeters)||s.remainderMeters<0||s.remainderMeters>=s.strideCm/100
      ||!Array.isArray(s.buckets)||s.buckets.length>6000)return false;
    let sensor=0,estimated=0;const seen=new Set();
    for(const b of s.buckets){
      if(!b||typeof b.hour!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(b.hour)||!Number.isFinite(Date.parse(b.hour+":00:00"))
        ||seen.has(b.hour)||!integer(b.sensorSteps)||!integer(b.estimatedSteps))return false;
      seen.add(b.hour);sensor+=b.sensorSteps;estimated+=b.estimatedSteps;
    }
    return sensor===s.sensorSteps&&estimated===s.estimatedSteps;
  }
  const MAX_RECORDS = 40, MAX_POINTS = 1500;
  const valid = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
  const point = p => Array.isArray(p) ? { lat:p[0], lng:p[1] } : p;
  function meters(a,b) {
    a=point(a);b=point(b);const rad=Math.PI/180;
    const h=Math.sin((b.lat-a.lat)*rad/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin((b.lng-a.lng)*rad/2)**2;
    return 12742000*Math.asin(Math.sqrt(Math.min(1,h)));
  }
  function compact(segments,limit=MAX_POINTS) {
    const list=segments.filter(s=>s.length).slice(-100),total=list.reduce((n,s)=>n+s.length,0);
    if(total<=limit)return list.map(s=>s.map(p=>p.slice()));
    const remaining=Math.max(0,limit-list.length*2);
    return list.map(s=>{
      if(s.length===1)return [s[0].slice()];
      const count=Math.min(s.length,Math.max(2,Math.floor(remaining*s.length/total)+2));
      return Array.from({length:count},(_,i)=>s[Math.round(i*(s.length-1)/(count-1))].slice());
    });
  }
  const positive = n => typeof n==="number" && Number.isFinite(n) && n>=0;
  function validate(record) {
    if(!record || record.version!==1 || typeof record.id!=="string" || record.id.length>100
      || typeof record.name!=="string" || !record.name.trim() || record.name.length>120
      || !["gps","plan"].includes(record.source) || !Number.isFinite(Date.parse(record.date))
      || !positive(record.distanceMeters) || !positive(record.durationSeconds)
      || !positive(record.movingSeconds) || record.movingSeconds>record.durationSeconds+1
      || !(record.weightKg===null || (positive(record.weightKg)&&record.weightKg>=20&&record.weightKg<=300))
      || !Array.isArray(record.segments) || record.segments.length>100
      || record.segments.some(s=>!Array.isArray(s)||!s.length||s.some(p=>!valid(p)))
      || record.segments.reduce((n,s)=>n+s.length,0)>MAX_POINTS
      || (record.gaps!==undefined&&(!Number.isSafeInteger(record.gaps)||record.gaps<0))
      || (record.geometryLimited!==undefined&&typeof record.geometryLimited!=="boolean")
      || (record.steps!==undefined&&(!validLegacySteps(record.steps)||record.source!=="gps"))
      || typeof record.note!=="string" || record.note.length>1000)throw Error("保存データの形式を確認できません。元のデータは上書きしません。");
    return record;
  }
  class RouteBook {
    constructor(storage,key="walking.routes.v1") {
      this.storage=storage;this.key=key;this.records=[];this.readable=true;this.revision=0;
      try {const raw=storage.getItem(key);if(raw===null)return;const data=JSON.parse(raw);
        if(data.version!==1||!Array.isArray(data.records)||data.records.length>MAX_RECORDS)throw Error("Invalid book");
        const ids=new Set();this.records=data.records.map(r=>{validate(r);if(ids.has(r.id))throw Error("Duplicate id");ids.add(r.id);return r;});
      } catch {this.readable=false;this.records=[];}
    }
    write(next) {
      if(!this.readable)throw Error("保存データを読み込めません。既存のルートは上書きしていません。");
      if(next.length>MAX_RECORDS)throw Error("ルートは40件まで保存できます。不要な記録を削除してください。");
      next.forEach(validate);this.storage.setItem(this.key,JSON.stringify({version:1,records:next}));
      this.records=next;this.revision++;
    }
    add(record) {validate(record);if(this.records.some(r=>r.id===record.id))throw Error("すでに保存済みです。");this.write([record,...this.records]);}
    remove(id) {this.write(this.records.filter(r=>r.id!==id));}
    choose(routes,enabled=true) {
      if(!routes.length)throw Error("No routes");
      if(!enabled||!this.records.length)return routes[0];
      const origin=routes[0].points[0],scale=Math.cos(origin[0]*Math.PI/180),grid=new Map();let samples=0;
      const xy=p=>[(p[1]-origin[1])*111195*scale,(p[0]-origin[0])*111195];
      const key=(x,y)=>`${x},${y}`;
      outer:for(const record of this.records)for(const segment of record.segments)for(let i=1;i<segment.length;i++){
        const a=segment[i-1],b=segment[i],n=Math.max(1,Math.ceil(meters(a,b)/25));
        for(let j=0;j<=n;j++){
          if(++samples>60000)break outer;
          const p=xy([a[0]+(b[0]-a[0])*j/n,a[1]+(b[1]-a[1])*j/n]),k=key(Math.floor(p[0]/40),Math.floor(p[1]/40));
          if(!grid.has(k))grid.set(k,[]);const bucket=grid.get(k);
          if(bucket.length<32&&bucket.every(q=>Math.hypot(q[0]-p[0],q[1]-p[1])>5))bucket.push(p);
        }
      }
      const shortest=Math.min(...routes.map(r=>r.distance)),scored=[];
      for(const route of routes){
        let length=0,repeated=0,count=0;
        for(let i=1;i<route.points.length;i++){
          const a=route.points[i-1],b=route.points[i],distance=meters(a,b),n=Math.max(1,Math.ceil(distance/30));
          for(let j=0;j<n;j++){
            if(++count>6000)break;
            const p=xy([a[0]+(b[0]-a[0])*(j+.5)/n,a[1]+(b[1]-a[1])*(j+.5)/n]),x=Math.floor(p[0]/40),y=Math.floor(p[1]/40);let hit=false;
            for(let dx=-1;dx<=1&&!hit;dx++)for(let dy=-1;dy<=1&&!hit;dy++)hit=(grid.get(key(x+dx,y+dy))||[]).some(q=>Math.hypot(q[0]-p[0],q[1]-p[1])<=35);
            length+=distance/n;if(hit)repeated+=distance/n;
          }
          if(count>6000)break;
        }
        const ratio=length?repeated/length:0;
        if(route.distance<=shortest*1.5+300)scored.push({route,ratio,limited:count>6000,score:route.distance*(1+ratio*3)});
      }
      scored.sort((a,b)=>a.score-b.score);const best=scored[0];
      return {...best.route,historyCompared:true,historyOverlap:best.ratio,historyAlternatives:routes.length,historySampleLimited:samples>60000||best.limited};
    }
  }
  const api={RouteBook,validate,compact,meters,MAX_RECORDS,MAX_POINTS};
  if(typeof module==="object"&&module.exports)module.exports=api;else root.RouteBookCore=api;
})(globalThis);
