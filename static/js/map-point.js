// Explicit map choices. A tap alone never sends a request or changes a route.
const MapPointSelection = (() => {
  "use strict";
  const MAX_DISTANCE=150,CONFIRM_DISTANCE=15;
  function roadPoint(place,data,distance,isRestricted=()=>false) {
    if(!Array.isArray(data)||data.length!==1||!data[0])throw Object.assign(Error("Invalid locate response"),{routeCode:"RouteResponse"});
    if(data[0].edges===null)return null;
    if(!Array.isArray(data[0].edges))throw Object.assign(Error("Invalid locate response"),{routeCode:"RouteResponse"});
    const found=data[0].edges.filter(item=>{
      const edge=item?.edge,restrictions=item.access_restrictions||[];
      const knownOtherModes=Array.isArray(restrictions)&&restrictions.length>0&&restrictions.every(r=>r.pedestrian===false);
      return Array.isArray(restrictions)&&edge?.access?.pedestrian===true&&!edge.destination_only&&(!edge.access_restriction||knownOtherModes)
        &&!edge.start_restriction?.pedestrian&&!edge.end_restriction?.pedestrian
        &&(!restrictions.length||knownOtherModes)&&edge.classification?.surface!=="impassable"
        &&!["ferry","rail_ferry","rail"].includes(edge.classification?.use)
        &&Number.isFinite(item.inbound_reach)&&Number.isFinite(item.outbound_reach)&&item.inbound_reach>=10&&item.outbound_reach>=10;
    }).map(item=>({lat:item.correlated_lat,lng:item.correlated_lon}))
      .filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180)
      .filter(p=>!isRestricted(p)&&!(data[0].nodes||[]).some(n=>(n.private_access===true||n.access?.pedestrian===false)&&Number.isFinite(n.lat)&&Number.isFinite(n.lon)&&distance(p,{lat:n.lat,lng:n.lon})<5))
      .map(p=>({...p,offset:distance(place,p)})).filter(p=>p.offset<=MAX_DISTANCE).sort((a,b)=>a.offset-b.offset);
    if(!found.length)return null;
    return {...found[0],name:"",address:"",mapPoint:true,
      accessNote:found[0].offset>CONFIRM_DISTANCE?`タップ地点から約${Math.round(found[0].offset)}mの徒歩で通れる道を指定しています。`:"徒歩で通れる道の位置を指定しています。"};
  }
  function createResolver({locate,distance,loadAccess=async()=>null,isRestricted=()=>false,now=Date.now}) {
    const cache=new Map();
    return async(place,signal)=>{
      if(signal.aborted)throw new DOMException("Aborted","AbortError");
      const key=`${place.lat.toFixed(6)},${place.lng.toFixed(6)}`,saved=cache.get(key);
      if(saved&&saved.expires>now())return saved.value;
      const [data,access]=await Promise.all([locate([place],signal,{searchCutoff:200,timeoutMs:8000}),loadAccess(signal)]);
      if(signal.aborted)throw new DOMException("Aborted","AbortError");
      const value=roadPoint(place,data,distance,p=>isRestricted(p,access));
      cache.set(key,{value,expires:now()+(value?300000:30000)});
      while(cache.size>32)cache.delete(cache.keys().next().value);
      return value;
    };
  }
  const helpers={roadPoint,createResolver,MAX_DISTANCE,CONFIRM_DISTANCE};
  if(typeof module==="object"&&module.exports){module.exports=helpers;return helpers;}
  const resolve=createResolver({locate:locateWalkingWaypoints,distance:(a,b)=>map.distance(a,b),
    loadAccess:signal=>loadRouteAccess({controller:{signal}}),
    isRestricted:(p,access)=>routeCrossesRestrictedArea([[p.lat,p.lng],[p.lat,p.lng]],(access?.areas||[]).map(a=>a.ring))});
  let active=null;
  function cancel() {
    const old=active;active=null;if(!old)return;
    old.controller?.abort();clearTimeout(old.timer);old.popup.remove();
  }
  function show(place,{viaOnly=false}={}) {
    if(!validCoordinates(place?.lat,place?.lng))return;
    cancel();
    const box=document.createElement("div");box.className="map-point-choice";
    box.append(textElement("strong","この場所を指定"));
    const actions=textElement("div","","map-point-actions"),status=textElement("p","","status");
    status.setAttribute("role","status");status.setAttribute("aria-live","polite");
    const state={place:{lat:place.lat,lng:place.lng},destination,allowStarting:viaOnly,buttons:[],status,controller:null,timer:null,point:null,action:null};
    const button=(action,label)=>{
      const control=textElement("button",label,"secondary");control.type="button";control.dataset.mapPointAction=action;
      control.addEventListener("click",()=>choose(state,action));state.buttons.push(control);actions.append(control);
    };
    if(!viaOnly)button("destination","目的地にする");
    if((routeEnabled||viaOnly)&&destination)button("via","経由地にする");
    if(!state.buttons.length){status.textContent="経由地を追加するには、先に目的地へのルートを表示してください。";}
    box.append(actions,status);
    const size=map.getSize(),width=Number.isFinite(size.x)?size.x:360;
    const maxWidth=Math.max(160,Math.min(300,width-136));
    const mapTop=map.getContainer?.()?.getBoundingClientRect?.()?.top||0;
    const tops=[".nearby-convenience-controls",".legend-control"].map(selector=>document.querySelector?.(selector)?.getBoundingClientRect?.())
      .filter(rect=>rect&&rect.height>0&&rect.top-mapTop<size.y/2).map(rect=>rect.bottom-mapTop);
    const topPadding=Math.min(size.y*.3,Math.max(96,...tops)+12);
    state.popup=L.popup({className:"map-point-popup",maxWidth,minWidth:Math.min(200,maxWidth),autoPan:true,
      autoPanPaddingTopLeft:[12,topPadding],autoPanPaddingBottomRight:[72,110],maxHeight:Math.max(120,Math.min(300,size.y-topPadding-120))})
      .setLatLng([place.lat,place.lng]).setContent(box);
    state.popup.on("remove",()=>{
      if(active===state){active=null;state.controller?.abort();clearTimeout(state.timer);}
      if(typeof NearbyRouting!=="undefined")NearbyRouting.popupClosed();
    });
    active=state;state.popup.openOn(map);
    if(typeof NearbyRouting!=="undefined")NearbyRouting.popupOpened(box);
  }
  function commit(state,action) {
    if(active!==state)return;
    if(action==="via"&&((!routeEnabled&&!state.allowStarting)||!destination||destination!==state.destination)){
      message(state.status,"目的地やルートが変わりました。地図でもう一度指定してください。",true);return;
    }
    if(action==="via"&&NearbyRouting.stops.length>=5){message(state.status,"寄り道は5か所まで追加できます。",true);return;}
    if(action==="via"&&map.distance(state.point,destination)<20){message(state.status,"現在の目的地と同じ場所です。",true);return;}
    if(action==="via"&&NearbyRouting.stops.some(p=>map.distance(p,state.point)<20)){message(state.status,"この付近はすでに経由地に追加されています。",true);return;}
    const point=state.point;active=null;clearTimeout(state.timer);
    if(action==="destination"){
      if(typeof WalkingTour!=="undefined"&&appShell.classList.contains("tour-active"))WalkingTour.deactivate();
      setDestination(point);
    }else NearbyRouting.select(point);
    state.popup.remove();
  }
  async function choose(state,action) {
    if(active!==state||state.controller)return;
    if(action==="via"&&NearbyRouting.stops.length>=5){message(state.status,"寄り道は5か所まで追加できます。",true);return;}
    if(state.point&&state.action===action){commit(state,action);return;}
    const controller=new AbortController();state.controller=controller;
    state.timer=setTimeout(()=>controller.abort(),12000);
    state.buttons.forEach(b=>{b.disabled=true;});message(state.status,"徒歩で通れる位置を確認しています…");
    try {
      const point=await resolve(state.place,controller.signal);if(active!==state)return;
      if(!point){message(state.status,"近くに徒歩で通れる道が見つかりませんでした。道路や入口を選んでください。",true);return;}
      state.point=point;state.action=action;
      if(point.offset>CONFIRM_DISTANCE){
        message(state.status,`タップした位置の代わりに、約${Math.round(point.offset)}m先の道を指定できます。`);
        for(const button of state.buttons)button.hidden=button.dataset.mapPointAction!==action;
        const selected=state.buttons.find(b=>b.dataset.mapPointAction===action);
        selected.textContent=action==="via"?"近くの道を経由地にする":"近くの道を目的地にする";
      }else commit(state,action);
    }catch(error){
      if(active!==state)return;
      const text=["NoSegment","170","171","172"].includes(String(error.routeCode))?"近くに徒歩で通れる道が見つかりませんでした。道路や入口を選んでください。"
        :error.routeCode==="ROUTING_RELAY_REQUIRED"?"位置の確認にはPythonサーバーが必要です。起動または再起動してください。"
        :error.name==="AbortError"?"位置の確認がタイムアウトしました。もう一度お試しください。"
        :[429,503].includes(error.httpStatus)?"確認先が混み合っています。時間をおいてもう一度お試しください。"
        :"通信エラーで徒歩の通行可否を確認できませんでした。もう一度お試しください。";
      message(state.status,text,true);
    }finally {
      clearTimeout(state.timer);state.controller=null;
      if(active===state){state.buttons.forEach(b=>{b.disabled=false;});state.popup.update?.();}
    }
  }
  document.addEventListener("click",event=>{
    if(event.target.closest?.("button[data-view], #open-discovery, #panel-toggle, #edit-walking-settings"))cancel();
  });
  return {show,cancel};
})();
