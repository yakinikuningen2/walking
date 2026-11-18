// Local, data-only step detection and summaries. No network or raw-data storage.
((root) => {
  "use strict";
  const integer=n=>Number.isSafeInteger(n)&&n>=0&&n<=1e9;
  const dateKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const hourKey=now=>{const d=new Date(now);return `${dateKey(d)}T${String(d.getHours()).padStart(2,"0")}`;};
  function validSnapshot(s) {
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
  class Detector {
    constructor(){this.reset();}
    reset(){this.last=null;this.base=null;this.filtered=0;this.warmUntil=0;this.blockUntil=0;this.peak=null;this.valley=false;this.peaks=[];this.active=false;this.source=null;}
    reject(now){this.peak=null;this.peaks=[];this.active=false;this.valley=false;this.blockUntil=now+700;}
    sample(event,now) {
      const finiteVector=v=>v&&[v.x,v.y,v.z].every(Number.isFinite);
      const withGravity=finiteVector(event?.accelerationIncludingGravity);
      const a=withGravity?event.accelerationIncludingGravity:event?.acceleration;
      if(!Number.isFinite(now)||!finiteVector(a))return {valid:false,steps:0};
      const source=withGravity?"gravity":"linear",magnitude=Math.hypot(a.x,a.y,a.z);
      const rotation=event.rotationRate;
      const spin=rotation&&[rotation.alpha,rotation.beta,rotation.gamma].some(n=>Number.isFinite(n)&&Math.abs(n)>250);
      if(this.last!==null&&now<=this.last)return {valid:false,steps:0};
      if(this.last===null||now-this.last>400||this.source!==source){
        this.reset();this.last=now;this.base=magnitude;this.warmUntil=now+700;this.source=source;
        return {valid:true,steps:0};
      }
      const dt=now-this.last;if(dt<10)return {valid:true,steps:0};this.last=now;
      if(magnitude>(withGravity?28:18)||spin){this.reject(now);this.base=magnitude;this.filtered=0;return {valid:true,steps:0};}
      this.base+=(1-Math.exp(-dt/700))*(magnitude-this.base);
      this.filtered+=(1-Math.exp(-dt/55))*(magnitude-this.base-this.filtered);
      const signal=this.filtered;
      if(now<this.warmUntil||now<this.blockUntil)return {valid:true,steps:0};
      if(signal<-.25)this.valley=true;
      if(!this.peak&&signal>.7&&this.valley)this.peak={start:now,time:now,value:signal};
      if(!this.peak)return {valid:true,steps:0};
      if(signal>this.peak.value){this.peak.value=signal;this.peak.time=now;}
      if(now-this.peak.start>550||this.peak.value>6){this.reject(now);return {valid:true,steps:0};}
      if(signal>.05)return {valid:true,steps:0};
      const peak=this.peak;this.peak=null;this.valley=false;
      if(now-peak.start<60)return {valid:true,steps:0};
      const last=this.peaks.at(-1),interval=last===undefined?null:peak.time-last;
      if(interval!==null&&interval<320){this.reject(now);return {valid:true,steps:0};}
      const previous=this.peaks.length>1?last-this.peaks.at(-2):null;
      if(interval!==null&&(interval>1500||(previous!==null&&Math.abs(interval-previous)>previous*.4))){this.peaks=[];this.active=false;}
      this.peaks.push(peak.time);if(this.peaks.length>4)this.peaks.shift();
      if(this.active)return {valid:true,steps:1};
      if(this.peaks.length===4){this.active=true;return {valid:true,steps:4};}
      return {valid:true,steps:0};
    }
  }
  class Counter {
    constructor(saved=null,{goal=6000,strideCm=70}={}) {
      this.data=saved?JSON.parse(JSON.stringify(saved)):{version:1,sensorSteps:0,estimatedSteps:0,remainderMeters:0,goal,strideCm,buckets:[]};
      if(!validSnapshot(this.data))throw Error("Invalid step record");
      this.mode="paused";this.since=0;
    }
    get total(){return this.data.sensorSteps+this.data.estimatedSteps;}
    setMode(mode,now){if(!["sensor","gps","pending","paused"].includes(mode)||!Number.isFinite(now))return;this.mode=mode;this.since=now;}
    add(source,count,now){
      if(!Number.isSafeInteger(count)||count<=0||!Number.isFinite(now)||this.total+count>1e9)return false;
      const key=hourKey(now);let bucket=this.data.buckets.find(b=>b.hour===key);
      if(!bucket){if(this.data.buckets.length>=6000)return false;bucket={hour:key,sensorSteps:0,estimatedSteps:0};this.data.buckets.push(bucket);}
      bucket[source]+=count;this.data[source]+=count;return true;
    }
    sensor(count,now){return this.mode==="sensor"&&now>=this.since&&this.add("sensorSteps",count,now);}
    gps(distance,from,to,now=to){
      // Never backfill before a mode switch, a pause, or a missing GPS interval.
      if(this.mode!=="gps"||!Number.isFinite(distance)||distance<=0||!Number.isFinite(from)||!Number.isFinite(to)||!Number.isFinite(now)
        ||from<this.since||to<=from||to-from>30000||now-to>15000||to>now+1000||distance/((to-from)/1000)>3.6)return false;
      const meters=this.data.remainderMeters+distance,stride=this.data.strideCm/100,count=Math.floor((meters+1e-9)/stride);
      if(count&&!this.add("estimatedSteps",count,to))return false;
      this.data.remainderMeters=Math.max(0,Math.min(stride-1e-12,meters-count*stride));return true;
    }
    snapshot(){return JSON.parse(JSON.stringify(this.data));}
  }
  function statistics(records,period,anchor) {
    if(!["day","week","month"].includes(period)||!/^\d{4}-\d{2}-\d{2}$/.test(anchor))throw Error("Invalid statistics period");
    const [y,m,d]=anchor.split("-").map(Number),start=new Date(y,m-1,d),end=new Date(start);
    if(!Number.isFinite(+start)||dateKey(start)!==anchor)throw Error("Invalid statistics date");
    if(period==="week")start.setDate(start.getDate()-(start.getDay()+6)%7);
    if(period==="month")start.setDate(1);
    end.setTime(+start);if(period==="month")end.setMonth(end.getMonth()+1);else end.setDate(end.getDate()+(period==="week"?7:1));
    const bars=[];
    if(period==="day")for(let h=0;h<24;h++)bars.push({key:`${dateKey(start)}T${String(h).padStart(2,"0")}`,label:`${h}時`,sensorSteps:0,estimatedSteps:0});
    else for(let date=new Date(start);date<end;date.setDate(date.getDate()+1))bars.push({key:dateKey(date),label:`${date.getMonth()+1}/${date.getDate()}`,sensorSteps:0,estimatedSteps:0});
    const rows=records.filter(r=>r.source==="gps"&&new Date(r.date)>=start&&new Date(r.date)<end);
    for(const r of records){if(r.source!=="gps"||!validSnapshot(r.steps))continue;
      for(const b of r.steps.buckets){const bar=bars.find(row=>row.key===(period==="day"?b.hour:b.hour.slice(0,10)));if(bar){bar.sensorSteps+=b.sensorSteps;bar.estimatedSteps+=b.estimatedSteps;}}
    }
    return {start:dateKey(start),end:dateKey(new Date(+end-1)),bars,rows,count:rows.length,
      sensorSteps:bars.reduce((n,b)=>n+b.sensorSteps,0),estimatedSteps:bars.reduce((n,b)=>n+b.estimatedSteps,0),
      distanceMeters:rows.reduce((n,r)=>n+r.distanceMeters,0),durationSeconds:rows.reduce((n,r)=>n+r.durationSeconds,0),
      missingSteps:rows.filter(r=>!r.steps).length};
  }
  const api={Detector,Counter,validSnapshot,statistics,dateKey};
  if(typeof module==="object"&&module.exports)module.exports=api;else root.WalkStepsCore=api;
})(globalThis);
