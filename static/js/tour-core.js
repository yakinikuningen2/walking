// Walking tour planning uses injected search/routing functions and no external libraries.
((root) => {
  "use strict";
  const THEMES = {
    any: { label: "おまかせ", kinds: ["park", "shrine", "neighborhood", "cafe", "sightseeing", "culture"] },
    nature: { label: "自然を楽しむ", kinds: ["park", "waterside", "forest", "mountain"] },
    history: { label: "歴史・神社巡り", kinds: ["shrine", "culture"] },
    town: { label: "街並みを楽しむ", kinds: ["neighborhood", "sightseeing", "shopping"] },
    food: { label: "カフェ・グルメ巡り", kinds: ["cafe", "restaurant"] },
    unfamiliar: { label: "知らない場所を探す", kinds: ["park", "shrine", "neighborhood", "cafe", "sightseeing", "culture"] },
  };
  const LIMITS = { generationMs: 45000, searchMs: 12000, legMs: 7000, routeCalls: 14, attempts: 3, stops: 5, pool: 40, saved: 50, geometry: 20000 };
  const DIRECTIONS = {any:"指定しない",n:"北",e:"東",s:"南",w:"西"};
  class TourError extends Error { constructor(code, message) { super(message); this.code = code; } }
  function routeFailure(error) {
    if(error instanceof TourError)return error;
    if(error?.routeCode==="NoRoute" || [170,171,441,442].includes(Number(error?.routeCode)) || error?.userMessage) {
      return new TourError("NO_ROUTE",error.userMessage||"経由地まで歩ける経路がありません。");
    }
    return new TourError("ROUTE_API","徒歩ルートを取得できませんでした。通信状態や検索先の混雑を確認して再試行してください。");
  }
  function point(p) { return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180; }
  function meters(a, b) {
    if (!point(a) || !point(b)) return Infinity;
    const rad = Math.PI / 180;
    const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  function settings(input) {
    if (!input || !Number.isSafeInteger(input.minutes) || input.minutes < 15 || !Number.isFinite(input.speed) || input.speed < 2.5 || input.speed > 6.5
      || !Number.isInteger(input.count) || input.count < 1 || input.count > LIMITS.stops || !Object.hasOwn(THEMES, input.theme) || typeof input.returnToStart !== "boolean"
      || (input.direction!==undefined&&!Object.hasOwn(DIRECTIONS,input.direction))) {
      throw new TourError("INPUT", "散歩時間・歩く速さ・コースの条件を確認してください。");
    }
    return { minutes: input.minutes, speed: input.speed, count: input.count, theme: input.theme, returnToStart: input.returnToStart,direction:input.direction===undefined?"any":input.direction,
      ...(input.autoCount===true ? {autoCount:true} : {}) };
  }
  function directionMatches(start,p,direction="any") {
    if(!point(start)||!point(p)||!Object.hasOwn(DIRECTIONS,direction))return false;
    if(direction==="any")return true;
    const rad=Math.PI/180,a=start.lat*rad,b=p.lat*rad,delta=(p.lng-start.lng)*rad;
    const east=Math.sin(delta)*Math.cos(b),north=Math.cos(a)*Math.sin(b)-Math.sin(a)*Math.cos(b)*Math.cos(delta);
    if(Math.hypot(east,north)<1e-12)return false;
    const bearing=(Math.atan2(east,north)/rad+360)%360,target={n:0,e:90,s:180,w:270}[direction];
    return Math.abs(((bearing-target+540)%360)-180)<=45+1e-7;
  }
  function automaticCount(minutes, available=LIMITS.stops) { return Math.min(available,LIMITS.stops,Math.max(1,Math.round(minutes/30))); }
  function cleanPlace(p) {
    if (!point(p) || typeof p.name !== "string" || !p.name.trim()) return null;
    return { lat: p.lat, lng: p.lng, name: p.name.trim().slice(0, 120), address: typeof p.address === "string" ? p.address.slice(0, 300) : "",
      key: typeof p.key === "string" && p.key ? p.key.slice(0, 200) : `${p.lat.toFixed(6)},${p.lng.toFixed(6)}/${p.name.slice(0,120)}`,
      kindId: typeof p.kindId === "string" ? p.kindId.slice(0, 40) : "", kindLabel: typeof p.kindLabel === "string" ? p.kindLabel.slice(0, 60) : "場所",
      ...(typeof p.accessNote === "string" ? { accessNote: p.accessNote.slice(0,180) } : {}) };
  }
  function candidates(input, start, visits = [], unfamiliar = false,direction="any") {
    const unique = [];
    for (const raw of input) {
      const p = cleanPlace(raw);
      if (!p || meters(start, p) < 80 || unique.some(other => other.key === p.key || (other.name === p.name && meters(other,p) < 80))) continue;
      if (!directionMatches(start,p,direction)) continue;
      if (unfamiliar && visits.some(visit=>meters(p,visit)<100)) continue;
      unique.push(p);
    }
    return unique.sort((a,b) => meters(start,a)-meters(start,b)).slice(0, LIMITS.pool);
  }
  function pathCost(start, stops, closed) {
    const chain = [start,...stops,...(closed?[start]:[])];
    return chain.slice(1).reduce((sum,p,i)=>sum+meters(chain[i],p),0);
  }
  function orderStops(start, input, closed) {
    let best=input, distance=Infinity;
    function visit(prefix, remaining) {
      if (!remaining.length) { const cost=pathCost(start,prefix,closed);if(cost<distance){distance=cost;best=prefix;}return; }
      remaining.forEach((p,i)=>visit([...prefix,p],remaining.filter((_,j)=>j!==i)));
    }
    visit([],input);return best;
  }
  function selectStops(pool, start, config, attempt = 0, seed = 0) {
    const target = config.minutes * config.speed * 1000 / 60 / (config.returnToStart ? 3.8 : 2.7) * [1,.5,.8][attempt];
    const ranked=[...pool].sort((a,b)=>Math.abs(meters(start,a)-target)-Math.abs(meters(start,b)-target));
    const chosen=[ranked[(seed+attempt)%Math.min(4,ranked.length)]];
    while(chosen.length<config.count){
      const remaining=ranked.filter(p=>!chosen.includes(p));
      remaining.sort((a,b)=>pathCost(start,orderStops(start,[...chosen,a],config.returnToStart),config.returnToStart)
        -pathCost(start,orderStops(start,[...chosen,b],config.returnToStart),config.returnToStart));
      chosen.push(remaining[0]);
    }
    return orderStops(start,chosen,config.returnToStart);
  }
  function roadSamples(legs) {
    const ref=legs[0]?.points[0];if(!ref)return [];
    const samples=[],scale=Math.max(.02,Math.cos(ref[0]*Math.PI/180));
    for(let leg=0;leg<legs.length;leg++)for(let i=1;i<legs[leg].points.length;i++){
      const a=legs[leg].points[i-1],b=legs[leg].points[i],delta=((b[1]-a[1]+540)%360)-180;
      const length=meters({lat:a[0],lng:a[1]},{lat:b[0],lng:b[1]});if(!length)continue;
      const count=Math.min(512,Math.max(1,Math.ceil(length/8)));
      const direction=((Math.round(Math.atan2(b[0]-a[0],delta*scale)*6/Math.PI)%6)+6)%6;
      for(let j=0;j<count;j++){
        const t=(j+.5)/count,p={lat:a[0]+(b[0]-a[0])*t,lng:((a[1]+delta*t+540)%360)-180};
        const x=((p.lng-ref[1]+540)%360)-180,y=p.lat-ref[0];
        const key=`${Math.round(x*111195*scale/12)},${Math.round(y*111195/12)},${direction}`;
        samples.push({key,p,leg,length:length/count});if(samples.length>=24000)return samples;
      }
    }
    return samples;
  }
  function overlap(legs,returnOnly=false) {
    const used=new Set();let total=0,repeated=0,lastKey=null,lastLeg=-1,repeat=false;
    for(const sample of roadSamples(legs)){
      if(sample.leg!==lastLeg){lastKey=null;lastLeg=sample.leg;}
      if(sample.key!==lastKey){repeat=used.has(sample.key);used.add(sample.key);lastKey=sample.key;}
      if(!returnOnly||sample.leg===legs.length-1){total+=sample.length;if(repeat)repeated+=sample.length;}
    }
    return total?repeated/total:0;
  }
  function returnAvoidAreas(legs,start,end) {
    const samples=roadSamples(legs),outbound=new Set(samples.filter(p=>p.leg<legs.length-1).map(p=>p.key));
    const shared=samples.filter(s=>s.leg===legs.length-1&&outbound.has(s.key)&&meters(s.p,start)>120&&meters(s.p,end)>120)
      .sort((a,b)=>Math.min(meters(b.p,start),meters(b.p,end))-Math.min(meters(a.p,start),meters(a.p,end)));
    const chosen=[];
    for(const s of shared){
      if(chosen.some(p=>meters(p,s.p)<180))continue;chosen.push(s.p);if(chosen.length===4)break;
    }
    return chosen.flatMap(p=>{
      const dy=12/111195,dx=dy/Math.max(.02,Math.cos(p.lat*Math.PI/180));
      if(Math.abs(p.lng)+dx>=180||Math.abs(p.lat)+dy>=90)return [];
      return [[[p.lng-dx,p.lat-dy],[p.lng+dx,p.lat-dy],[p.lng+dx,p.lat+dy],[p.lng-dx,p.lat+dy],[p.lng-dx,p.lat-dy]]];
    });
  }
  function validLeg(leg, from, to) {
    return !!leg && Number.isFinite(leg.distance) && leg.distance>=0 && Number.isFinite(leg.duration) && leg.duration>=0
      && Array.isArray(leg.points) && leg.points.length>=2 && leg.points.length<=LIMITS.geometry
      && leg.points.every(p=>Array.isArray(p)&&point({lat:p[0],lng:p[1]}))
      && (!from || meters(from,{lat:leg.points[0][0],lng:leg.points[0][1]})<=100)
      && (!to || meters(to,{lat:leg.points.at(-1)[0],lng:leg.points.at(-1)[1]})<=100);
  }
  function complete(course) { return course.stops.every(p=>course.visited.includes(p.key)) && (!course.settings.returnToStart || course.returned===true); }
  function validateCourse(raw) {
    if (!raw || raw.version!==1 || typeof raw.id!=="string" || !raw.id || !point(raw.start) || typeof raw.start.name!=="string"
      || !Number.isFinite(Date.parse(raw.createdAt)) || !Array.isArray(raw.stops) || raw.stops.length<1 || raw.stops.length>LIMITS.stops
      || raw.stops.some(p=>!cleanPlace(p)||typeof p.key!=="string"||!p.key) || new Set(raw.stops.map(p=>p.key)).size!==raw.stops.length
      || !Array.isArray(raw.visited) || new Set(raw.visited).size!==raw.visited.length || raw.visited.some(k=>!raw.stops.some(p=>p.key===k))
      || typeof raw.returned!=="boolean" || !Array.isArray(raw.legs)
      || (raw.completedAt!==undefined && !Number.isFinite(Date.parse(raw.completedAt)))) throw new TourError("STORAGE", "周遊コースの保存データを読み込めません。");
    const config=settings(raw.settings);
    const chain=[raw.start,...raw.stops,...(config.returnToStart?[raw.start]:[])];
    if(config.count!==raw.stops.length || raw.stops.some(p=>!directionMatches(raw.start,p,config.direction)) || raw.legs.length!==chain.length-1 || !raw.legs.every((leg,i)=>validLeg(leg,chain[i],chain[i+1]))) throw new TourError("STORAGE","保存された徒歩ルートを確認できません。");
    const distance=raw.legs.reduce((s,l)=>s+l.distance,0),duration=raw.legs.reduce((s,l)=>s+l.duration,0);
    if(duration>config.minutes*60 || !Number.isFinite(distance) || !Number.isFinite(duration))throw new TourError("STORAGE","保存されたコースの時間が条件に合いません。");
    return {...raw,settings:config,start:{...raw.start},stops:raw.stops.map(cleanPlace),visited:[...raw.visited],distance,duration,overlap:overlap(raw.legs),returnOverlap:config.returnToStart?overlap(raw.legs,true):0};
  }
  async function bounded(work, ms, signal, code="TIMEOUT") {
    const controller=new AbortController();
    const abort=()=>controller.abort();
    if(signal?.aborted)throw new DOMException("Aborted","AbortError");
    signal?.addEventListener("abort",abort,{once:true});
    let expired=false;
    const timer=setTimeout(()=>{expired=true;controller.abort();},ms);
    let cancel;
    const cancelled=new Promise((_,reject)=>{cancel=()=>reject(expired?new TourError(code,"処理が制限時間を超えました。条件を変えて再試行してください。"):new DOMException("Aborted","AbortError"));controller.signal.addEventListener("abort",cancel,{once:true});});
    try{return await Promise.race([Promise.resolve().then(()=>work(controller.signal)),cancelled]);}
    finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);controller.signal.removeEventListener("abort",cancel);controller.abort();}
  }
  function createEngine(deps) {
    const cache=new Map();
    async function getLeg(a,b,speed,state,signal,options={}) {
      const key=`${a.lat.toFixed(6)},${a.lng.toFixed(6)}/${b.lat.toFixed(6)},${b.lng.toFixed(6)}/${speed}/${JSON.stringify(options.avoidPolygons||[])}`;
      let leg=cache.get(key);
      if(!leg||Date.now()-leg.at>300000){
        if(state.calls>=LIMITS.routeCalls)throw new TourError("LIMIT","徒歩ルートの確認回数の上限に達しました。条件を変えて再試行してください。");
        state.calls++;
        leg=await bounded(s=>deps.route(a,b,speed,s,options),LIMITS.legMs,signal);
        if(signal.aborted)throw new DOMException("Aborted","AbortError");
        if(!validLeg(leg,a,b))throw new TourError("NO_ROUTE","経由地まで歩けるルートを確認できませんでした。");
        leg={points:leg.points.map(p=>[p[0],p[1]]),distance:leg.distance,duration:leg.duration,at:Date.now()};
        if(cache.size>=80)cache.delete(cache.keys().next().value);cache.set(key,leg);
      }
      return leg;
    }
    async function measure(start, stops, config, state, signal) {
      const chain=[start,...stops,...(config.returnToStart?[start]:[])],legs=[];
      for(let i=1;i<chain.length;i++){
        if(signal.aborted)throw new DOMException("Aborted","AbortError");
        deps.progress?.(`徒歩ルートを確認中（${i}/${chain.length-1}区間）`);
        legs.push(await getLeg(chain[i-1],chain[i],config.speed,state,signal));
        if(legs.reduce((sum,l)=>sum+l.duration,0)>config.minutes*60)throw new TourError("OVER_BUDGET","帰り道を含む徒歩時間が設定時間を超えます。時間を延ばすか、出発地点・テーマを変えてください。");
      }
      // Keep the verified baseline when a different return road is unavailable or too long.
      if(config.returnToStart&&overlap(legs,true)>.08&&state.calls<LIMITS.routeCalls
        && (!state.deadlineAt||Date.now()+LIMITS.legMs+1000<state.deadlineAt)){
        const avoidPolygons=returnAvoidAreas(legs,start,stops.at(-1));
        if(avoidPolygons.length){
          deps.progress?.("帰り道の別ルートを確認中…");
          try{
            const alternate=await getLeg(stops.at(-1),start,config.speed,state,signal,{avoidPolygons});
            const proposal=[...legs.slice(0,-1),alternate];
            if(proposal.reduce((sum,l)=>sum+l.duration,0)<=config.minutes*60
              && overlap(proposal,true)<overlap(legs,true)-.02)legs[legs.length-1]=alternate;
          }catch(error){if(signal.aborted||error.name==="AbortError")throw error;}
        }
      }
      return {legs:legs.map(({points,distance,duration})=>({points,distance,duration})),distance:legs.reduce((s,l)=>s+l.distance,0),duration:legs.reduce((s,l)=>s+l.duration,0),overlap:overlap(legs),returnOverlap:config.returnToStart?overlap(legs,true):0};
    }
    async function generate(input, start, options={}) {
      const config=settings(input);
      if(!point(start))throw new TourError("START","出発地点を設定してください。");
      const deadlineAt=Date.now()+LIMITS.generationMs;
      return bounded(async signal=>{
        deps.progress?.("立ち寄る場所を検索中…");
        const raw=await bounded(s=>deps.search(config,start,s),LIMITS.searchMs,signal,"SEARCH_TIMEOUT");
        const pool=candidates(raw,start,options.visits,config.theme==="unfamiliar",config.direction);
        if(config.autoCount)config.count=automaticCount(config.minutes,pool.length);
        if(!pool.length||pool.length<config.count)throw new TourError("INSUFFICIENT",`${config.direction!=="any"?`${DIRECTIONS[config.direction]}方面で`:""}立ち寄れる候補が足りないため、コースを作れません。テーマ・方角・出発地点を変えてください。`);
        let best=null,last=null;const seen=new Set(),state={calls:0,deadlineAt};
        for(let attempt=0;attempt<LIMITS.attempts;attempt++){
          const stops=selectStops(pool,start,config,attempt,options.seed||0),key=stops.map(p=>p.key).join('/');
          if(seen.has(key))continue;seen.add(key);
          try{
            const route=await measure(start,stops,config,state,signal);
            const repeated=route.returnOverlap*.7+route.overlap*.3,bestRepeated=best?best.returnOverlap*.7+best.overlap*.3:Infinity;
            if(!best || repeated<bestRepeated-.02 || (Math.abs(repeated-bestRepeated)<=.02 && route.duration>best.duration))best={...route,stops};
            if(route.overlap<.15&&(!config.returnToStart||route.returnOverlap<.1))break;
          }catch(error){
            if(signal.aborted||error.name==="AbortError")throw error;
            if(!["OVER_BUDGET","NO_ROUTE","LIMIT"].includes(error.code)){
              if(best)break; // Optional optimization must not discard a validated course.
              throw error;
            }
            last=error;
            if(config.autoCount&&config.count>1&&["OVER_BUDGET","NO_ROUTE"].includes(error.code))config.count--;
          }
          if(state.calls+config.count+(config.returnToStart?1:0)>LIMITS.routeCalls)break;
          if(best&&Date.now()+(config.count+(config.returnToStart?2:0))*LIMITS.legMs+1000>=deadlineAt)break;
        }
        if(!best)throw last||new TourError("NO_ROUTE","条件に合う徒歩コースを作れませんでした。");
        const course={version:1,id:options.id||`${Date.now()}-${Math.random().toString(36).slice(2)}`,createdAt:new Date().toISOString(),settings:{...config,count:best.stops.length},start:{lat:start.lat,lng:start.lng,name:start.name||"出発地点"},
          stops:best.stops,legs:best.legs,distance:best.distance,duration:best.duration,overlap:best.overlap,visited:[],returned:false};
        return {course:validateCourse(course),pool,calls:state.calls};
      },LIMITS.generationMs,options.signal);
    }
    async function rebuild(course, stops, signal) {
      const clean=stops.map(cleanPlace);
      if(!clean.length || clean.some(p=>!p) || new Set(clean.map(p=>p.key)).size!==clean.length || clean.length>LIMITS.stops)throw new TourError("INPUT","経由地は重複なしで1〜5地点を指定してください。");
      const config=settings({...course.settings,count:clean.length});
      if(clean.some(p=>!directionMatches(course.start,p,config.direction)))throw new TourError("INPUT","選んだ経由地は指定した方角の範囲外です。");
      return bounded(async s=>{
        const route=await measure(course.start,clean,config,{calls:0,deadlineAt:Date.now()+LIMITS.generationMs},s);
        const next={...course,...route,settings:config,stops:clean,visited:course.visited.filter(k=>clean.some(p=>p.key===k)),returned:false};
        return validateCourse(next);
      },LIMITS.generationMs,signal);
    }
    return {generate,rebuild};
  }
  const api={THEMES,DIRECTIONS,LIMITS,TourError,routeFailure,meters,point,settings,directionMatches,automaticCount,candidates,orderStops,overlap,returnAvoidAreas,validLeg,complete,validateCourse,bounded,createEngine};
  if(typeof module==="object"&&module.exports)module.exports=api;else root.TourCore=api;
})(globalThis);
