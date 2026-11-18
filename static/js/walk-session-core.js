// GPS measurements and the user's private route book. No network requests.
((root) => {
  "use strict";
  const Steps=typeof module==="object"&&module.exports?require("./walk-steps-core.js"):root.WalkStepsCore;
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
      || (record.steps!==undefined&&(!Steps.validSnapshot(record.steps)||record.source!=="gps"))
      || typeof record.note!=="string" || record.note.length>1000)throw Error("保存データの形式を確認できません。元のデータは上書きしません。");
    return record;
  }
  function calories(distanceMeters,weightKg) {
    // Level-walking active energy, excluding resting energy (Yokohama Sports
    // Medical Center): kcal = 0.5 * body mass kg * distance km. An estimate only.
    return positive(distanceMeters)&&Number.isFinite(weightKg)&&weightKg>=20&&weightKg<=300
      ? .5*weightKg*distanceMeters/1000 : null;
  }
  class Recorder {
    constructor(saved=null) {
      this.id=`walk-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      this.startedAt=new Date().toISOString();this.distanceMeters=0;this.durationSeconds=0;this.movingSeconds=0;
      this.segments=[];this.gaps=0;this.geometryLimited=false;this.anchor=null;this.running=false;this.since=null;
      if(saved){validate(saved);if(saved.source!=="gps")throw Error("Invalid draft");
        this.id=saved.id;this.startedAt=saved.date;this.distanceMeters=saved.distanceMeters;this.durationSeconds=saved.durationSeconds;
        this.movingSeconds=saved.movingSeconds;this.segments=saved.segments.map(s=>s.map(p=>p.slice()));this.gaps=saved.gaps||0;this.geometryLimited=!!saved.geometryLimited;if(saved.steps)this.steps=JSON.parse(JSON.stringify(saved.steps));}
    }
    start(now=Date.now()) {if(!this.running){this.running=true;this.since=now;this.anchor=null;}}
    elapsed(now=Date.now()) {return this.durationSeconds+(this.running?Math.max(0,now-this.since)/1000:0);}
    pause(now=Date.now()) {this.durationSeconds=this.elapsed(now);this.running=false;this.since=null;this.anchor=null;}
    breakSegment() {if(this.anchor)this.gaps++;this.anchor=null;}
    fix(position,now=Date.now()) {
      if(!this.running)return false;
      const c=position?.coords,t=position?.timestamp,p=c&&[c.latitude,c.longitude];
      if(!valid(p)||!Number.isFinite(c.accuracy)||c.accuracy<0||c.accuracy>30||!Number.isFinite(t)||now-t>15000||t>now+1000||t<this.since){this.breakSegment();return false;}
      if(!this.anchor){if(this.segments.at(-1)?.length===1)this.segments.pop();this.segments.push([p]);
        if(this.segments.length>100){this.segments=this.segments.slice(-100);this.geometryLimited=true;}
        this.anchor={p,t,accuracy:c.accuracy};return true;}
      const a=this.anchor,dt=(t-a.t)/1000;
      if(dt<=0)return false;
      if(dt>30){this.breakSegment();return this.fix(position,now);}
      const distance=meters(a.p,p);
      if(distance/dt>3.6){this.breakSegment();return false;}
      const deadband=Math.max(5,Math.min(15,(a.accuracy+c.accuracy)*.6));
      if(distance<deadband)return false;
      this.distanceMeters+=distance;this.movingSeconds+=dt;
      this.segments.at(-1).push(p);this.anchor={p,t,accuracy:c.accuracy};
      if(this.segments.reduce((n,s)=>n+s.length,0)>6000)this.segments=compact(this.segments,3000);
      return true;
    }
    speed() {return this.movingSeconds>=60&&this.distanceMeters>=100 ? this.distanceMeters/this.movingSeconds*3.6 : null;}
    record({id,name="散歩の記録",weightKg=null,note=""}={},now=Date.now()) {
      return validate({version:1,id:id||this.id,name,date:this.startedAt,source:"gps",distanceMeters:this.distanceMeters,
        durationSeconds:this.elapsed(now),movingSeconds:Math.min(this.movingSeconds,this.elapsed(now)),weightKg,
        note,segments:compact(this.segments),gaps:this.gaps,geometryLimited:this.geometryLimited,...(this.steps?{steps:JSON.parse(JSON.stringify(this.steps))}:{})});
    }
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
  const api={Recorder,RouteBook,validate,compact,calories,meters,MAX_RECORDS,MAX_POINTS};
  if(typeof module==="object"&&module.exports)module.exports=api;else root.WalkSessionCore=api;
})(globalThis);
