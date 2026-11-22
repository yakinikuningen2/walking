// Registered routes only. No live distance, time, motion or step measurement.
const RegisteredRoutes = (() => {
  "use strict";
  const Core=RouteBookCore,$=id=>document.getElementById(id);
  const storage={getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)};
  const book=new Core.RouteBook(storage),prefKey="walking.route-preferences.v1";
  let avoid=true,preview=null;
  try {
    const raw=localStorage.getItem(prefKey) ?? localStorage.getItem("walking.measurement.v1");
    const p=raw?JSON.parse(raw):null;if(p?.version===1)avoid=p.avoid!==false;
  } catch { /* Preserve old preferences without overwriting malformed data. */ }
  const controls=document.createElement("section");controls.id="registered-route-controls";
  controls.innerHTML=`<h3>表示中のルートを登録</h3><button id="route-save-plan" type="button">表示中のルートを保存</button><p id="route-book-status" class="status" role="status" aria-live="polite"></p><label class="route-book-checkbox"><input id="route-avoid-saved" type="checkbox"/>保存した道をなるべく避ける</label><p class="route-book-help">保存したルートを対象に、次の検索から反映します。出発・到着地点の付近や一本道など、同じ道を通る場合があります。</p>`;
  const section=document.createElement("section");section.id="registered-route-history";
  section.innerHTML='<h3>保存したルート</h3><p id="route-history-empty" class="route-book-help">保存したルートはありません。</p><ul id="route-history" class="place-list"></ul>';
  ui["walk-stats"].closest("section").before(controls);
  ui["visits-list"].closest("section").after(section);
  const tell=(text,error=false)=>message($("route-book-status"),text,error);
  $("route-avoid-saved").checked=avoid;
  const clock=seconds=>{const n=Math.max(0,Math.floor(seconds));return `${Math.floor(n/3600)?`${Math.floor(n/3600)}:`:""}${String(Math.floor(n/60)%60).padStart(2,"0")}:${String(n%60).padStart(2,"0")}`;};
  function currentRoute(){
    if(appShell.classList.contains("tour-active")){
      const course=WalkingTour.getCourse();if(course)return {points:course.legs.flatMap((leg,i)=>leg.points.slice(i?1:0)),distance:course.distance,duration:course.duration,name:"周遊コース"};
    }
    const route=NearbyRouting.route||routeChoices.get(activeRouteKind)?.route;
    return route?{...route,name:destination?.name||"予定ルート"}:null;
  }
  function render(){
    $("route-history").replaceChildren();$("route-history-empty").hidden=!!book.records.length;
    for(const record of book.records){
      const item=document.createElement("li");item.className="route-book-card";
      item.append(textElement("strong",record.name),textElement("p",`${new Date(record.date).toLocaleDateString("ja-JP")} ／ ${record.source==="plan"?"予定ルート":"散歩記録"}`,"route-book-help"));
      item.append(textElement("p",`距離 ${routeDistance(record.distanceMeters)} ／ 時間 ${clock(record.durationSeconds)}`));
      if(record.note)item.append(textElement("p",record.note));
      const actions=textElement("div","","route-book-buttons"),show=textElement("button","地図に表示","secondary"),remove=textElement("button","削除","secondary");show.type=remove.type="button";
      show.addEventListener("click",()=>{
        const lines=record.segments.filter(s=>s.length>1);if(!lines.length){tell("表示できるルートがありません。",true);return;}
        preview?.remove();const pane=map.getPane("savedRoutes")||map.createPane("savedRoutes");pane.style.zIndex="335";pane.style.pointerEvents="none";
        preview=L.polyline(lines,{pane:"savedRoutes",color:"#75857D",weight:4,interactive:false}).addTo(map);
        document.querySelector('[data-view="map"]').click();map.fitBounds(preview.getBounds(),{padding:[32,90],maxZoom:16,animate:false});
      });
      remove.addEventListener("click",()=>{try{book.remove(record.id);preview?.remove();preview=null;render();tell("記録を削除しました。");}catch(error){tell(error.message,true);}});
      actions.append(show,remove);item.append(actions);$("route-history").append(item);
    }
  }
  $("route-avoid-saved").addEventListener("change",()=>{
    avoid=$("route-avoid-saved").checked;
    try{localStorage.setItem(prefKey,JSON.stringify({version:1,avoid}));}
    catch{tell("設定を端末に保存できません。この画面を開いている間は利用できます。",true);}
  });
  $("route-save-plan").addEventListener("click",()=>{
    const route=currentRoute();if(!route){tell("先にルートを地図に表示してください。",true);return;}
    try{
      book.add(Core.validate({version:1,id:`plan-${Date.now()}`,name:route.name.slice(0,120),date:new Date().toISOString(),source:"plan",distanceMeters:route.distance,durationSeconds:route.duration,movingSeconds:0,weightKg:null,note:"",segments:Core.compact([route.points])}));
      render();tell("表示中のルートを保存しました。");
    }catch(error){tell(error.message||"保存できませんでした。",true);}
  });
  render();if(!book.readable)tell("保存したルートを読み込めません。既存データは上書きしていません。",true);
  return {choose:routes=>book.choose(routes,avoid),historyKey:()=>`${avoid}/${book.revision}/${book.records.length}`,
    get hasHistory(){return avoid&&book.records.length>0;},get records(){return book.records;}};
})();
