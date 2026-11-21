// Bounded geographic searches reuse the existing map proxy and OSM access checks.
const GeographicSearch = (() => {
  'use strict';
  const C=GeographicCore, cache=new Map(), regionCache=new Map();
  let layer=null;
  const stale=(request,context,query)=>context.active!==request || context.input.value.trim()!==query || request.controller.signal.aborted;
  function remember(store,key,value,ttl=C.LIMITS.ttl){store.set(key,{at:Date.now(),value,ttl});while(store.size>C.LIMITS.cache)store.delete(store.keys().next().value);}
  function saved(store,key){const hit=store.get(key);return hit&&Date.now()-hit.at<hit.ttl?hit.value:null;}
  async function photon(params,request,timeout=5000) {
    while(Date.now()-lastSearchAt<1000)await abortableRouteDelay(1000-(Date.now()-lastSearchAt),request.controller.signal);
    if(request.controller.signal.aborted)throw new DOMException('Aborted','AbortError');
    const controller=new AbortController(),abort=()=>controller.abort();request.controller.signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,Math.max(1,Math.min(timeout,request.deadlineAt-Date.now())));
    try {
      const url=new URL(params.reverse?'../reverse':SEARCH_ENDPOINT,SEARCH_ENDPOINT);delete params.reverse;
      for(const [key,value]of Object.entries({...params,lang:'default'}))for(const item of Array.isArray(value)?value:[value])url.searchParams.append(key,String(item));
      lastSearchAt=Date.now();const r=await fetch(url,{signal:controller.signal});if(!r.ok)throw Object.assign(Error('Geographic search unavailable'),{httpStatus:r.status});
      return C.photon(await r.json());
    }finally{clearTimeout(timer);request.controller.signal.removeEventListener('abort',abort);}
  }
  function criteria(area){return {minMinutes:0,minutes:(area.radius+1000)*DISCOVERY_DISTANCE_FACTOR/4000*60,speed:4,kind:'any',ambience:'any',direction:'any',keyword:''};}
  function prepare(raw,intent,area){
    return mergeDiscoveryElements(raw).filter(e=>C.accept(e,intent,area,naturalAllowed) && naturalGeometryCount(e)<=6000)
      .sort((a,b)=>Number(!!C.title(b))-Number(!!C.title(a)) || Number(C.kind(b)==='park')-Number(C.kind(a)==='park')
        || C.meters(C.location(a),area)-C.meters(C.location(b),area));
  }
  function convert(e,intent,area,resolved){
    const k=C.kind(e),access=resolved?.naturalAccess;
    const a=access?.anchorType==='way' && Number.isSafeInteger(access.anchorId) && access.anchorId>0 && C.point(access.point)?access:null;
    const t=e.tags||{},p=a?.point || C.location(e);
    const labels={park:'公園・緑地',waterside:'川辺・湖畔',coast:'海辺',forest:'森・林',sightseeing:'観光名所・展望地点'};
    const name=C.title(e) || ({waterside:'名前のない水辺',coast:'名前のない海辺',forest:'名前のない森',park:'名前のない公園',sightseeing:'名前のない展望地点'})[k];
    const address=[t['addr:province'],t['addr:city'],t['addr:suburb'],t['addr:street']].filter(Boolean).join('、');
    const result=PlaceIdentity.attach({...p,name,address:address||'所在地の記載なし',kindId:k,kindLabel:labels[k],geographicSearch:true,geoAccess:!!a,
      key:`${e.type}/${e.id}`,geoFeaturePoint:C.location(e),geoRelevance:C.relevance(intent,area,!!a),
      sourceUrl:`https://www.openstreetmap.org/${e.type}/${e.id}`,
      accessNote:a?.note||'徒歩で向かえる入口・道を確認できていません。',
      ...(a?{accessStatus:a.status,accessAnchor:{type:a.anchorType,id:a.anchorId}}:{}),
      ...(typeof PlacePhotos!=='undefined'?{photoHints:PlacePhotos.hints({...e,tags:t})}:{}),
      ...(typeof t['description:ja']==='string'?{description:t['description:ja'].slice(0,300)}:{})},e);
    return result;
  }
  async function collect(intent,area,request,update=()=>{}) {
    const key=JSON.stringify([intent.kind,intent.wantsView,area.lat,area.lng,area.radius,area.name]);
    const hit=saved(cache,key);if(hit)return hit;
    let raw=[],sourceFailed=false,accessFailed=false,limited=false;
    try{raw=await naturalRead(C.featureQuery(intent,area),request,C.LIMITS.mapTimeoutMs);}
    catch(error){if(request.controller.signal.aborted)throw error;sourceFailed=true;
      raw=await photon({reverse:true,lat:area.lat,lon:area.lng,radius:area.radius/1000,osm_tag:C.tagsFor(intent),limit:C.LIMITS.features},request);
    }
    if(request.controller.signal.aborted)throw new DOMException('Aborted','AbortError');
    const features=prepare(raw,intent,area);limited=raw.length>=C.LIMITS.features || features.length>C.LIMITS.results;
    let results=features.slice(0,C.LIMITS.results).map(e=>convert(e,intent,area,null));
    if(results.length)update({places:results,sourceFailed,accessPending:true,limited});
    const selected=features.filter(e=>!e.photonOnly && naturalGeometryCount(e)<=1200).slice(0,C.LIMITS.accessFeatures), centers=[];
    for(const e of selected)for(const p of naturalFocusPoints(e,criteria(area),area)){
      if(centers.length<C.LIMITS.centers && centers.every(q=>C.meters(p,q)>300))centers.push(p);
    }
    if(centers.length){
      try{
        const data=await naturalRead(C.accessQuery(centers,discoveryBounds),request,C.LIMITS.mapTimeoutMs);
        const incomplete=naturalDataTruncated(data,centers.map(()=>100));limited ||= incomplete;
        if(data.reduce((n,e)=>n+naturalGeometryCount(e),0)>18000)throw Error('Access geometry budget');
        const access=naturalPrepareAccess(data,area);access.incomplete=incomplete || access.limited;
        const mapped=new Map();
        for(const e of selected){
          await new Promise(resolve=>setTimeout(resolve,0));
          if(request.controller.signal.aborted)throw new DOMException('Aborted','AbortError');
          const k=C.kind(e),resolved=naturalResolve(e,['park','sightseeing'].includes(k)?'forest':k,data,criteria(area),area,access);
          if(resolved)mapped.set(`${e.type}/${e.id}`,convert(e,intent,area,resolved));
        }
        results=results.map(p=>mapped.get(p.key)||p);
        // Prefer usable walking endpoints. Informational results remain clearly marked.
        results.sort((a,b)=>Number(b.geoAccess)-Number(a.geoAccess));
      }catch(error){if(request.controller.signal.aborted)throw error;accessFailed=true;}
    }
    if(request.controller.signal.aborted)throw new DOMException('Aborted','AbortError');
    const result={places:PlaceIdentity.dedupe(results),sourceFailed,accessFailed,limited,accessPending:false};
    remember(cache,key,result,sourceFailed||accessFailed?30000:results.length?C.LIMITS.ttl:30000);return result;
  }
  function render(result,context){
    renderSearch(result.places,context);
    if(layer)layer.clearLayers();else layer=L.layerGroup().addTo(map);
    for(const p of result.places){
      const popup=document.createElement('div');popup.append(textElement('strong',p.name),textElement('p',p.geoRelevance));
      const button=textElement('button',p.geoAccess?'目的地にする':'地図で確認','secondary');button.type='button';button.onclick=()=>select(p,context);popup.append(button);
      L.circleMarker([p.lat,p.lng],{radius:6,color:'#245744',weight:1.5,fillColor:p.geoAccess?'#245744':'#fff',fillOpacity:1,bubblingMouseEvents:false}).addTo(layer).bindPopup(popup,{autoPan:false});
    }
    const n=result.places.length,ready=result.places.filter(p=>p.geoAccess).length;
    message(context.status,n?`${n}件${result.accessPending?'・入口・歩道を確認中…':`・徒歩地点確認 ${ready}件`}${result.sourceFailed?'・予備検索を使用（地図情報は取得できませんでした）':''}${result.accessFailed?'・入口・歩道の取得で通信エラー':''}${result.limited?'・範囲・件数を絞って表示':''}`
      :result.sourceFailed?'予備検索では候補が見つかりませんでした。地図情報の通信エラーにより、周辺全体は確認できていません。':'検索した範囲では、条件に合う場所が見つかりませんでした。',!n&&result.sourceFailed);
  }
  function select(place,context){
    if(C.unresolved(place)){focusPlace(place,{keepZoom:true});message(context.status,'徒歩で向かえる入口・道を確認できていないため、地点情報のみ表示しています。');return false;}
    context.onSelect(place);return true;
  }
  function choices(intent,regions,context){
    context.results.replaceChildren();
    const mountain=['foothill','mountain'].includes(intent.kind);
    if(mountain && !regions.length){message(context.status,'山の地域が見つかりませんでした。山の名前を含めて検索してください。');return;}
    message(context.status,regions.length?'検索する地域を選んでください。':'地域が見つかりませんでした。地図を探したい場所へ移動して、範囲を指定できます。');
    for(const region of regions){
      const item=document.createElement('li'),button=textElement('button',region.name,'result-button');button.type='button';
      button.append(textElement('span',region.address||'所在地の記載なし','place-detail'));
      if(region.broad){button.append(textElement('span','広い地域です。地図で検索範囲を指定','place-detail'));button.onclick=()=>{
        focusPlace(region,{keepZoom:true});mapChoice(intent,context,region);
      };}else button.onclick=()=>run(intent,context,region);
      item.append(button);context.results.append(item);
    }
    if(!mountain){const item=document.createElement('li'),button=textElement('button','地図の表示位置で範囲を指定','secondary');button.type='button';button.onclick=()=>mapChoice(intent,context);item.append(button);context.results.append(item);}
  }
  function mapChoice(intent,context,region=null){
    context.results.replaceChildren();message(context.status,'地図を探したい場所へ移動してから、範囲を確定してください。');
    const item=document.createElement('li'),button=textElement('button','表示位置の周辺8kmで探す','secondary');button.type='button';button.onclick=()=>{
      const p=map.getCenter(),extent=region?.extent;
      if(extent && (p.lng<extent[0]||p.lng>extent[2]||p.lat<extent[3]||p.lat>extent[1])){message(context.status,'選んだ地域の範囲内へ地図を移動してください。',true);return;}
      run(intent,context,{lat:p.lat,lng:p.lng,name:region?`${region.name}・地図の表示位置`:'地図の表示位置',radius:8000,mapScope:true});
    };item.append(button);context.results.append(item);
  }
  async function run(intent,context,chosen=null){
    cancelSearch(context);const query=context.input.value.trim();if(query!==intent.query && C.normalized(query)!==intent.query)return;
    const request={controller:new AbortController(),deadlineAt:Date.now()+C.LIMITS.timeoutMs};
    request.timeout=setTimeout(()=>request.controller.abort(),C.LIMITS.timeoutMs);context.active=request;setSearchBusy(true,context);
    message(context.status,'周辺の場所を検索中…');
    const cancel=textElement('button','中止','secondary geo-search-cancel');cancel.type='button';cancel.onclick=()=>{cancelSearch(context);message(context.status,'検索を中止しました。');cancel.remove();};context.status.after(cancel);
    try{
      let region=chosen;
      if(!region && intent.region){
        const regionKey=JSON.stringify([intent.kind,intent.region]);
        let available=saved(regionCache,regionKey);
        if(!available){available=C.regions(await photon({q:intent.region,limit:16},request),intent);remember(regionCache,regionKey,available,available.length?C.LIMITS.ttl:30000);}
        if(stale(request,context,query))return;
        if(available.length!==1 || available[0].broad){choices(intent,available,context);return;}
        region=available[0];
      }
      if(!region){
        const start=getStartPoint();if(!start){mapChoice(intent,context);return;}
        if(intent.kind==='mountain'){
          const mountains=await photon({reverse:true,lat:Math.round(start.lat*1000)/1000,lon:Math.round(start.lng*1000)/1000,radius:30,osm_tag:['natural:peak','natural:volcano'],limit:6},request);
          if(stale(request,context,query))return;
          choices(intent,C.regions(mountains,intent),context);return;
        }
        region={...start,name:start.name||'出発地点'};
      }
      const area=C.scope(intent,region);if(region.mapScope)area.radius=8000;
      const result=await collect(intent,area,request,result=>{if(!stale(request,context,query))render(result,context);});
      if(!stale(request,context,query))render(result,context);
    }catch(error){if(context.active===request && context.input.value.trim()===query)message(context.status,error.name==='AbortError'||error.routeCode==='MapTimeout'
      ?'周辺検索がタイムアウトしました。取得済みの候補は表示しています。'
      :[429,503].includes(error.httpStatus)?'検索先が混み合っているため、候補を取得できませんでした。':'通信エラーにより候補を取得できませんでした。「見つからない」という結果ではありません。',true);}
    finally{clearTimeout(request.timeout);cancel.remove();if(context.active===request){context.active=null;setSearchBusy(false,context);}}
  }
  return {search:(query,context)=>{const intent=C.parse(query);if(!intent)return false;run(intent,context);return true;},select,collect,prepare,convert};
})();
