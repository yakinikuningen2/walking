// Bounded pedestrian-only recovery. Intermediate coordinates must be located
// on the provider's pedestrian network; gaps are never filled with straight lines.
((root) => {
  "use strict";
  const LIMITS={partMeters:35000,baseParts:8,longPartMeters:70000,parts:16,budgetMs:120000,points:120000,joinMeters:.5,snapMeters:1200,refineAnchors:3};
  const valid=p=>Number.isFinite(p?.lat)&&Number.isFinite(p?.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180;
  function meters(a,b){if(!valid(a)||!valid(b))return Infinity;const r=Math.PI/180,h=Math.sin((a.lat-b.lat)*r/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin((a.lng-b.lng)*r/2)**2;return 12742000*Math.asin(Math.sqrt(Math.min(1,h)));}
  const error=(code,text)=>Object.assign(new Error(text),{routeCode:code,userMessage:text});
  function timeoutMs(distance){return distance>=50000?60000:distance>=20000?45000:18000;}
  function anchors(start,end){
    if(!valid(start)||!valid(end))throw error("RouteInput","出発地点と目的地を確認してください。");
    const direct=meters(start,end),usualCount=Math.max(2,Math.ceil(direct/LIMITS.partMeters));
    // Preserve the short split plan. For longer trips, keep each request below
    // the provider's observed ~100 km input limit without unbounded API calls.
    const count=usualCount<=LIMITS.baseParts?usualCount:Math.max(LIMITS.baseParts,Math.ceil(direct/LIMITS.longPartMeters));
    if(count>LIMITS.parts)throw error("AppRouteLimit","分割検索の対応範囲（直線距離約1,120km）を超えています。出発地点か目的地を近くに変更してください。");
    const r=Math.PI/180,a=start.lat*r,b=start.lng*r,c=end.lat*r,d=end.lng*r;
    const vector=(lat,lng)=>[Math.cos(lat)*Math.cos(lng),Math.cos(lat)*Math.sin(lng),Math.sin(lat)];
    const u=vector(a,b),v=vector(c,d),angle=Math.acos(Math.max(-1,Math.min(1,u.reduce((n,x,i)=>n+x*v[i],0))));
    if(Math.abs(Math.sin(angle))<1e-8)throw error("NoRoute","中継地点を確認できませんでした。別の地点を指定してください。");
    return Array.from({length:count-1},(_,i)=>{
      const t=(i+1)/count,x=Math.sin((1-t)*angle)/Math.sin(angle),y=Math.sin(t*angle)/Math.sin(angle),p=u.map((n,j)=>n*x+v[j]*y);
      return {lat:Math.atan2(p[2],Math.hypot(p[0],p[1]))/r,lng:Math.atan2(p[1],p[0])/r};
    });
  }
  function located(requested,data){
    if(!Array.isArray(data)||data.length!==requested.length)throw error("RouteResponse","徒歩で通れる中継地点を確認できませんでした。");
    return requested.map((input,i)=>{
      const choices=(data[i]?.edges||[]).filter(e=>e?.edge?.access?.pedestrian === true && !e.edge.destination_only && !e.edge.not_thru
        && !e.edge.access_restriction && !e.edge.start_restriction?.pedestrian && !e.edge.end_restriction?.pedestrian
        && !e.access_restrictions?.length && !["ferry","rail_ferry"].includes(e.edge.classification?.use)
        && e.inbound_reach>=10 && e.outbound_reach>=10)
        .map(e=>({lat:e.correlated_lat,lng:e.correlated_lon})).filter(p=>valid(p)&&meters(input,p)<=LIMITS.snapMeters)
        .sort((a,b)=>meters(input,a)-meters(input,b));
      if(!choices.length)throw error("NoRoute","徒歩で通れる中継地点が見つかりませんでした。出発地点か目的地を変えてください。");
      return choices[0];
    });
  }
  function offset(p,distance,bearing){
    const r=Math.PI/180,lat=p.lat*r,lng=p.lng*r,heading=bearing*r,angle=distance/6371000;
    const next=Math.asin(Math.sin(lat)*Math.cos(angle)+Math.cos(lat)*Math.sin(angle)*Math.cos(heading));
    const lon=lng+Math.atan2(Math.sin(heading)*Math.sin(angle)*Math.cos(lat),Math.cos(angle)-Math.sin(lat)*Math.sin(next));
    return {lat:next/r,lng:((lon/r+540)%360)-180};
  }
  async function locateVia(requested,locate,signal,progress){
    const read=(points,data)=>{
      if(!Array.isArray(data)||data.length!==points.length)throw error("RouteResponse","徒歩で通れる中継地点を確認できませんでした。");
      return points.map((p,i)=>{try{return located([p],[data[i]])[0];}catch(e){if(e.routeCode!=="NoRoute")throw e;return null;}});
    };
    const checkAbort=()=>{if(signal.aborted)throw new DOMException("Aborted","AbortError");};
    let found=read(requested,await locate(requested,signal));checkAbort();
    // A straight-line search center may fall in a lake or forest. Search a
    // bounded set of surrounding centers; only verified road positions survive.
    for(const radius of [5000,10000]){
      const missing=found.flatMap((p,i)=>p?[]:[i]);if(!missing.length)return found;
      if(missing.length>LIMITS.refineAnchors)break;
      progress("中継地点の周辺で歩ける道を確認しています…");checkAbort();
      const probes=missing.flatMap(i=>[0,90,180,270].map(b=>offset(requested[i],radius,b)));
      const candidates=read(probes,await locate(probes,signal));checkAbort();
      missing.forEach((i,j)=>{
        found[i]=candidates.slice(j*4,j*4+4).filter(p=>p&&meters(p,requested[i])<=radius+LIMITS.snapMeters)
          .sort((a,b)=>meters(a,requested[i])-meters(b,requested[i]))[0]||null;
      });
    }
    if(found.some(p=>!p))throw error("NoRoute","徒歩で通れる中継地点が見つかりませんでした。出発地点か目的地を変えてください。");
    return found;
  }
  function check(route,start,end){
    if(!Array.isArray(route?.points)||route.points.length<2||route.points.length>LIMITS.points||!route.points.every(p=>Array.isArray(p)&&valid({lat:p[0],lng:p[1]}))
      ||!Number.isFinite(route.distance)||route.distance<=0||!Number.isFinite(route.duration)||route.duration<=0
      ||!Array.isArray(route.steps)||!route.steps.length||route.steps.some(s=>s.mode!=="walking"||typeof s.maneuver?.type!=="string"||!Number.isFinite(s.distance)||s.distance<0))throw error("RouteResponse","徒歩ルートの情報を確認できませんでした。");
    const first={lat:route.points[0][0],lng:route.points[0][1]},last={lat:route.points.at(-1)[0],lng:route.points.at(-1)[1]},direct=meters(start,end);
    if(meters(start,first)>100||meters(end,last)>(end.mapPoint?20:100)||route.distance<direct*.8-200)throw error("RouteResponse","ルートが指定地点につながっていません。");
    if(route.distance>Math.max(10000,direct*3+2000))throw error("RouteDetour","分割すると大きな迂回になるため、徒歩ルートを表示できませんでした。");
    return route;
  }
  function join(legs,start,end){
    if(!Array.isArray(legs)||legs.length<2||legs.length>LIMITS.parts)throw error("RouteResponse","分割ルートを確認できませんでした。");
    let points=[],steps=[],distance=0,duration=0;
    for(const [i,leg] of legs.entries()){
      if(i&&meters({lat:points.at(-1)[0],lng:points.at(-1)[1]},{lat:leg.points[0][0],lng:leg.points[0][1]})>LIMITS.joinMeters)
        throw error("RouteGap","区間同士がつながらないため、徒歩ルートを表示できませんでした。");
      points=points.concat(i?leg.points.slice(1):leg.points);
      if(points.length>LIMITS.points)throw error("RouteResponse","ルートの情報量が表示上限を超えています。");
      for(const step of leg.steps){
        if(i<legs.length-1&&step.maneuver?.type==="arrive")continue;
        steps.push(i&&step.maneuver?.type==="depart"?{...step,instruction:"道なりに進む",maneuver:{...step.maneuver,type:"continue"}}:step);
      }
      distance+=leg.distance;duration+=leg.duration;
    }
    if(distance>meters(start,end)*3+5000)throw error("RouteDetour","大きな迂回になるため、徒歩ルートを表示できませんでした。");
    return {points,steps,distance,duration,segmented:true,segmentCount:legs.length};
  }
  async function segmented({start,end,signal,locate,route,progress=()=>{},budgetMs=LIMITS.budgetMs}){
    if(!Number.isFinite(budgetMs)||budgetMs<=0)throw error("RouteTimeout","ルート検索がタイムアウトしました。");
    const controller=new AbortController(),abort=()=>controller.abort();if(signal?.aborted)abort();
    signal?.addEventListener("abort",abort,{once:true});
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},Math.max(1,Math.min(budgetMs,LIMITS.budgetMs)));
    const aborted=new Promise((_,reject)=>controller.signal.addEventListener("abort",()=>reject(timedOut?error("RouteTimeout","ルート検索がタイムアウトしました。"):new DOMException("Aborted","AbortError")),{once:true}));
    try{
      if(controller.signal.aborted)throw new DOMException("Aborted","AbortError");
      return await Promise.race([aborted,(async()=>{
        const checkAbort=()=>{if(controller.signal.aborted)throw new DOMException("Aborted","AbortError");};
        const requests=anchors(start,end);progress("歩ける中継地点を確認しています…");
        const via=await locateVia(requests,locate,controller.signal,progress);checkAbort();
        const legs=[];let cursor=start;
        for(const [index,target] of [...via,end].entries()){
          checkAbort();progress(`長距離ルートを検索しています… ${index+1}/${via.length+1}`);
          const leg=await route(cursor,target,controller.signal);checkAbort();check(leg,cursor,target);legs.push(leg);
          cursor={lat:leg.points.at(-1)[0],lng:leg.points.at(-1)[1]};
        }
        return join(legs,start,end);
      })()]);
    }finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);controller.abort();}
  }
  const api={LIMITS,valid,meters,timeoutMs,anchors,located,check,join,segmented};
  if(typeof module==="object"&&module.exports)module.exports=api;else root.LongRoutes=api;
})(typeof globalThis!=="undefined"?globalThis:this);
