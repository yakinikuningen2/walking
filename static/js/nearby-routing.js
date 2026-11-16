// Nearby results offer an explicit destination or single-detour choice.
const NearbyRouting = (() => {
  "use strict";
  let via = null, marker = null, panel = null, line = null, shownRoute = null, pending = null, refresh = null, context = null;
  const same = (a,b) => a && b && map.distance(a,b)<20;
  function clear() {
    via = null;pending?.controller.abort();pending=null;clearTimeout(refresh);refresh=null;context=null;
    marker?.remove();marker=null;line?.remove();line=null;shownRoute=null;
    if(panel) panel.hidden = true;
  }
  function render() {
    if(!panel){
      panel=document.createElement("div");panel.className="nearby-via-summary";
      const name=textElement("span",""), remove=textElement("button","経由ルートを消す","secondary");
      remove.type="button";remove.addEventListener("click",clear);
      const status=textElement("p","","status");status.setAttribute("role","status");status.setAttribute("aria-live","polite");
      panel.append(name,remove,status);ui["route-details-content"].prepend(panel);
    }
    panel.hidden=!via;
    if(via) panel.firstElementChild.textContent=`経由ルート：${via.name || "選んだ場所"}`
      +(shownRoute?` ／ 距離 ${routeDistance(shownRoute.distance)} ／ 徒歩 約${routeDuration(shownRoute.duration)}`:"");
  }
  function actions(place) {
    const box=document.createElement("div");box.className="nearby-place-actions";
    const goal=textElement("button","目的地にする","secondary"), detour=textElement("button","経由地にする","secondary");
    goal.type=detour.type="button";goal.dataset.nearbyAction="destination";detour.dataset.nearbyAction="via";
    goal.setAttribute("aria-label",`${place.name || "この場所"}を目的地にする`);
    detour.setAttribute("aria-label",`${place.name || "この場所"}を経由地にする`);
    goal.addEventListener("click",()=>setDestination(place));
    detour.addEventListener("click",()=>select(place));
    const note=textElement("p","","nearby-action-note");box.append(goal,detour,note);
    box.refreshNearbyActions=()=>{
      detour.disabled=!destination || same(place,destination);
      note.textContent=!destination?"経由地にするには、先に目的地を設定してください。":same(place,destination)?"現在の目的地です。":"";
      note.hidden=!note.textContent;
    };
    box.refreshNearbyActions();return box;
  }
  function refreshActions(root=document) {
    root.querySelectorAll(".nearby-place-actions").forEach(box=>box.refreshNearbyActions?.());
  }
  function popupOpened(root) { refreshActions(root);appShell.classList.add("nearby-choice-open"); }
  function popupClosed() { appShell.classList.remove("nearby-choice-open"); }
  function select(place) {
    if(!destination || !validCoordinates(place?.lat,place?.lng) || same(place,destination))return;
    if(!getStartPoint()){
      message(ui["nearby-convenience-status"],"出発地点を設定してから経由地を選んでください。",true);return;
    }
    clear();via=Object.freeze({name:place.name || "",lat:place.lat,lng:place.lng});
    marker=L.circleMarker([via.lat,via.lng],{radius:7,color:"#fff",weight:2,fillColor:"#E87524",fillOpacity:1,bubblingMouseEvents:false})
      .addTo(map).bindTooltip(textElement("span",`経由地：${via.name || "選んだ場所"}`));
    map.closePopup();render();
    const compact=window.matchMedia("(max-width: 840px), (max-height: 480px)").matches;
    setRouteDetailsOpen(!compact);
    if(!routeEnabled || !routeLayer)beginWalkingRoute("standard");
    else update(true);
  }
  async function update(userSelection=false) {
    if(!via || !destination || !getStartPoint())return;
    clearTimeout(refresh);refresh=null;pending?.controller.abort();
    const selected=via,start={...getStartPoint()},end={...destination},speed=currentWalkingSpeed().kmh;
    const request={controller:new AbortController(),deadlineAt:Date.now()+150000};pending=request;
    const timer=setTimeout(()=>request.controller.abort(),150000);
    const isCurrent=()=>pending===request && via===selected;
    context={start,end,speed};render();message(panel.children[2],"経由ルートを追加しています…");
    try{await fetchRoute(start,end,request,isCurrent);if(isCurrent())message(panel.children[2],"");}
    catch(error){if(isCurrent()){
      context=null;message(panel.children[2],routeErrorMessage(error),true);
      if(userSelection || !shownRoute)setRouteDetailsOpen(true);
    }}
    finally{clearTimeout(timer);clearTimeout(request.timeout);if(pending===request)pending=null;}
  }
  function mainRouteChanged() {
    if(!via || !routeEnabled || !routeLayer || !destination || !getStartPoint())return;
    const start=getStartPoint(),speed=currentWalkingSpeed().kmh;
    if(context && context.speed===speed && map.distance(context.start,start)<30 && map.distance(context.end,destination)<1)return;
    clearTimeout(refresh);refresh=setTimeout(()=>update(false),500);
  }
  async function fetchRoute(start,end,request,isCurrent) {
    const selected=via;if(!selected)throw new Error("Missing nearby waypoint");
    const signal=request.controller.signal;
    const check=()=>{if(signal.aborted || !isCurrent() || via!==selected)throw new DOMException("Aborted","AbortError");};
    const speed=currentWalkingSpeed().kmh;check();
    const leg=async(a,b)=>{
      try{return await calculateWalkingRoute(a,b,"standard",speed,{...request,longDistance:map.distance(a,b)>=20000});}
      catch(e){
        check();
        if(!["DistanceExceeded","154"].includes(String(e.routeCode)) || [429,502,503].includes(e.httpStatus))throw e;
        return LongRoutes.segmented({start:a,end:b,signal,budgetMs:request.deadlineAt?request.deadlineAt-Date.now():LongRoutes.LIMITS.budgetMs,
          progress:text=>{if(isCurrent())message(panel.children[2],text);},locate:locateWalkingWaypoints,
          route:(from,to,childSignal)=>calculateWalkingRoute(from,to,"standard",speed,{controller:{signal:childSignal},routeTimeoutMs:30000})});
      }
    };
    let route,viaAlong=0;
    if(same(start,selected)){
      route=await leg(start,end);check();
    }else{
      const first=await leg(start,selected);check();
      const cursor={lat:first.points.at(-1)[0],lng:first.points.at(-1)[1]};
      const last=await leg(cursor,end);check();
      if(map.distance(first.points.at(-1),last.points[0])>.5)throw Object.assign(new Error("Detour gap"),{userMessage:"経由地でルートがつながりませんでした。別の場所を選ぶか、経由を外してください。"});
      const points=first.points.concat(last.points.slice(1));
      if(points.length>LongRoutes.LIMITS.points)throw Object.assign(new Error("Too many route points"),{userMessage:"経由ルートの情報量が表示上限を超えています。"});
      const steps=first.steps.filter(s=>s.maneuver.type!=="arrive").concat(last.steps.map(s=>s.maneuver.type==="depart"
        ? {...s,instruction:"経由地から道なりに進む",maneuver:{...s.maneuver,type:"continue"}}:s));
      route={points,steps,distance:first.distance+last.distance,duration:first.duration+last.duration};
      viaAlong=first.points.slice(1).reduce((n,p,i)=>n+map.distance(first.points[i],p),0);
    }
    check();route.nearbyVia={...selected};route.nearbyViaAlong=viaAlong;
    const pane=map.getPane("walkingRoutes") || map.createPane("walkingRoutes");pane.style.zIndex="350";pane.style.pointerEvents="none";
    const next=L.polyline(route.points,{pane:"walkingRoutes",color:"#E87524",weight:5,opacity:.95,interactive:false}).addTo(map);
    line?.remove();line=next;shownRoute=route;
    (routeLayers.get("standard") || routeLayers.get("ors_standard") || routeLayer)?.bringToFront();render();
  }
  function advance(route,progress,offRoute) {
    // Consume a navigation waypoint, never a saved visit or walk record.
    if(!via || !shownRoute || !currentPosition || map.distance(currentPosition,via)>40)return;
    const position=walkingRoutePosition(currentPosition,shownRoute);
    if(position.distance<=25 && position.along>=shownRoute.nearbyViaAlong+20)clear();
  }
  return {actions,refreshActions,popupOpened,popupClosed,select,clear,fetchRoute,update,mainRouteChanged,advance,
    get via(){return via;},get route(){return shownRoute;},get busy(){return !!pending;}};
})();
