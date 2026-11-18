// Detours remain a separate route; nearby results and map clicks share this editor.
const NearbyRouting = (() => {
  "use strict";
  let via = null, marker = null, panel = null, line = null, shownRoute = null, pending = null, refresh = null, context = null;
  let stops = [], markers = [], picking = false, editVersion = 0;
  const same = (a,b) => a && b && map.distance(a,b)<20;
  function clear() {
    editVersion++;
    via = null;pending?.controller.abort();pending=null;clearTimeout(refresh);refresh=null;context=null;
    for(const item of markers)item.remove();markers=[];marker=null;stops=[];
    line?.remove();line=null;shownRoute=null;stopPicking();
    if(panel) panel.hidden = true;
  }
  function render() {
    if(!panel){
      panel=document.createElement("div");panel.className="nearby-via-summary";
      const name=textElement("span",""), remove=textElement("button","経由ルートを消す","secondary");
      remove.type="button";remove.addEventListener("click",clear);
      const status=textElement("p","","status");status.setAttribute("role","status");status.setAttribute("aria-live","polite");
      panel.append(name,remove,status);ui["route-details-content"].prepend(panel);
      panel.append(document.createElement("ol"));panel.children[3].className="detour-stop-list";
    }
    panel.hidden=!via;
    if(via) panel.firstElementChild.textContent=`経由ルート：${via.name || "選んだ場所"}`
      +(shownRoute?` ／ 距離 ${routeDistance(shownRoute.distance)} ／ 徒歩 約${routeDuration(shownRoute.duration)}`:"");
    panel.children[3].replaceChildren();
    stops.forEach((place,index)=>{
      const item=document.createElement("li");item.append(textElement("span",`${index+1}. ${place.name||"地図で指定した場所"}`));
      if(place.accessNote)item.append(textElement("span",place.accessNote,"walk-help"));
      for(const [label,action,disabled] of [["前へ",()=>move(index,-1),index===0],["後へ",()=>move(index,1),index===stops.length-1],["削除",()=>remove(index),false]]){
        const button=textElement("button",label,"secondary");button.type="button";button.disabled=disabled;
        button.setAttribute("aria-label",`${place.name||`寄り道${index+1}`}：${label}`);button.addEventListener("click",action);item.append(button);
      }
      panel.children[3].append(item);
    });
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
    if(stops.some(p=>same(p,place)))return;
    if(stops.length>=5){message(ui["nearby-convenience-status"],"寄り道は5か所まで追加できます。",true);return;}
    stops.push(Object.freeze({name:place.name || `地図で指定した場所 ${stops.length+1}`,lat:place.lat,lng:place.lng,
      ...(place.mapPoint && place.offset > 15 ? {accessNote:place.accessNote} : {})}));
    changed();
    map.closePopup();render();
    const compact=window.matchMedia("(max-width: 840px), (max-height: 480px)").matches;
    setRouteDetailsOpen(!compact);
    if(!routeEnabled || !routeLayer)beginWalkingRoute("standard");
    else if(stops.length===1)update(true);
    else refresh=setTimeout(()=>update(true),300);
  }
  function changed(){
    editVersion++;
    pending?.controller.abort();pending=null;clearTimeout(refresh);refresh=null;context=null;
    line?.remove();line=null;shownRoute=null;via=stops[0]||null;
    for(const item of markers)item.remove();markers=[];
    stops.forEach((p,i)=>markers.push(L.circleMarker([p.lat,p.lng],{radius:9,color:"#fff",weight:2,fillColor:"#E87524",fillOpacity:1,bubblingMouseEvents:false})
      .addTo(map).bindTooltip(textElement("span",String(i+1)),{permanent:true,direction:"center",className:"detour-number"})));
    marker=markers[0]||null;
  }
  function remove(index){if(!Number.isInteger(index)||index<0||index>=stops.length)return;stops.splice(index,1);if(!stops.length){clear();return;}changed();render();refresh=setTimeout(()=>update(true),300);}
  function move(index,delta){const next=index+delta;if(!Number.isInteger(index)||![-1,1].includes(delta)||index<0||next<0||index>=stops.length||next>=stops.length)return;
    [stops[index],stops[next]]=[stops[next],stops[index]];changed();render();refresh=setTimeout(()=>update(true),300);}
  async function update(userSelection=false) {
    if(!via || !destination || !getStartPoint())return;
    clearTimeout(refresh);refresh=null;pending?.controller.abort();
    const selected=via,start={...getStartPoint()},end={...destination},speed=currentWalkingSpeed().kmh;
    const budget=stops.length>1?45000:150000;
    const request={controller:new AbortController(),deadlineAt:Date.now()+budget};pending=request;
    const timer=setTimeout(()=>request.controller.abort(),budget);
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
    const selected=via,version=editVersion;if(!selected)throw new Error("Missing nearby waypoint");
    const signal=request.controller.signal;
    const check=()=>{if(signal.aborted || !isCurrent() || via!==selected || version!==editVersion)throw new DOMException("Aborted","AbortError");};
    const speed=currentWalkingSpeed().kmh;check();
    const leg=async(a,b)=>{
      try{return await calculateWalkingRoute(a,b,"standard",speed,{...request,longDistance:map.distance(a,b)>=20000,
        ...(stops.length>1?{routeTimeoutMs:Math.max(1,Math.min(12000,(request.deadlineAt||Date.now()+45000)-Date.now()))}:{})});}
      catch(e){
        check();
        if(!["DistanceExceeded","154"].includes(String(e.routeCode)) || [429,502,503].includes(e.httpStatus))throw e;
        return LongRoutes.segmented({start:a,end:b,signal,budgetMs:request.deadlineAt?request.deadlineAt-Date.now():LongRoutes.LIMITS.budgetMs,
          progress:text=>{if(isCurrent())message(panel.children[2],text);},locate:locateWalkingWaypoints,
          route:(from,to,childSignal)=>calculateWalkingRoute(from,to,"standard",speed,{controller:{signal:childSignal},routeTimeoutMs:30000})});
      }
    };
    let route,viaAlong=0;
    if(stops.length>1){
      const selectedStops=stops.slice(),points=[],steps=[];let distance=0,duration=0,cursor=start;
      for(const [index,goal] of [...selectedStops,end].entries()){
        check();if(same(cursor,goal))continue;const part=await leg(cursor,goal);check();
        if(points.length&&map.distance(points.at(-1),part.points[0])>.5)throw Object.assign(new Error("Detour gap"),{userMessage:"経由地でルートがつながりません。別の場所を指定してください。"});
        if(points.length+part.points.length>LongRoutes.LIMITS.points)throw new Error("経由ルートの情報量が上限を超えています。");
        points.push(...part.points.slice(points.length?1:0));distance+=part.distance;duration+=part.duration;
        steps.push(...part.steps.filter(s=>index===selectedStops.length||s.maneuver.type!=="arrive").map(s=>index>0&&s.maneuver.type==="depart"?{...s,instruction:"経由地から進む",maneuver:{...s.maneuver,type:"continue"}}:s));
        cursor={lat:part.points.at(-1)[0],lng:part.points.at(-1)[1]};
        if(index===0)viaAlong=points.slice(1).reduce((n,p,i)=>n+map.distance(points[i],p),0);
      }
      route={points,steps,distance,duration,nearbyStops:selectedStops};
    }else if(same(start,selected)){
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
    check();route.nearbyVia={...selected};route.nearbyViaAlong=viaAlong;route.nearbyStops=stops.slice();
    const pane=map.getPane("walkingRoutes") || map.createPane("walkingRoutes");pane.style.zIndex="350";pane.style.pointerEvents="none";
    const next=L.polyline(route.points,{pane:"walkingRoutes",color:"#E87524",weight:5,opacity:.95,interactive:false}).addTo(map);
    line?.remove();line=next;shownRoute=route;
    (routeLayers.get("standard") || routeLayers.get("ors_standard") || routeLayer)?.bringToFront();render();
  }
  function advance(route,progress,offRoute) {
    // Consume a navigation waypoint, never a saved visit or walk record.
    if(!via || !shownRoute || !currentPosition || map.distance(currentPosition,via)>40)return;
    const position=walkingRoutePosition(currentPosition,shownRoute);
    if(position.distance<=25 && position.along>=shownRoute.nearbyViaAlong+20)remove(0);
  }
  let pickBanner=null;
  function stopPicking(){picking=false;if(pickBanner)pickBanner.hidden=true;}
  function startPicking(){if(!destination){message(ui["nearby-convenience-status"],"先に目的地を設定してください。",true);return;}
    if(typeof stopStartMapSelection==="function")stopStartMapSelection();
    picking=true;document.querySelector?.('[data-view="map"]')?.click();if(pickBanner)pickBanner.hidden=false;}
  if(typeof appShell!=="undefined"){
    pickBanner=textElement("div","","start-map-selection detour-map-selection");pickBanner.hidden=true;
    pickBanner.append(textElement("span","寄り道を地図で追加（最大5か所）"));const done=textElement("button","完了","secondary");done.type="button";done.addEventListener("click",stopPicking);pickBanner.append(done);appShell.append(pickBanner);
    const add=textElement("button","寄り道","route-details-toggle secondary");add.type="button";add.setAttribute("aria-label","寄り道を地図で追加");add.addEventListener("click",startPicking);
    document.getElementById("route-map-actions").append(add);
    const edit=textElement("button","地図で寄り道を追加","secondary");edit.type="button";edit.addEventListener("click",startPicking);document.querySelector(".destination-actions").append(edit);
    document.addEventListener("keydown",e=>{if(e.key==="Escape")stopPicking();});
    document.addEventListener("click",e=>{
      const nav=e.target.closest?.("[data-view]");
      if((nav&&nav.dataset.view!=="map")||e.target.closest?.("#open-discovery, #edit-walking-settings, #panel-toggle, #pick-start-on-map"))stopPicking();
    });
  }
  return {actions,refreshActions,popupOpened,popupClosed,select,clear,fetchRoute,update,mainRouteChanged,advance,move,remove,startPicking,stopPicking,
    handleMapClick(place){if(!picking)return false;
      if(typeof MapPointSelection!=="undefined")MapPointSelection.show(place,{viaOnly:true});else select(place);
      return true;},get stops(){return stops.slice();},
    get via(){return via;},get route(){return shownRoute;},get busy(){return !!pending;}};
})();
