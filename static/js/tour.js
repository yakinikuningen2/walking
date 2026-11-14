// Browser controller for multi-stop tours. Ordinary destination routing stays in app.js.
const WalkingTour = (() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const screen=$("tour-screen"), status=$("tour-status"), historyKey="walking.tours.v1", draftKey="walking.tour-active.v1";
  const markers=L.layerGroup().addTo(map);
  let line=null, course=null, pool=[], saved=[], active=null, forceCurrent=false, pickingStart=false, initialized=false;
  let historyWritable=true,draftWritable=true;
  const badge=document.createElement("button");badge.type="button";badge.className="tour-map-progress";badge.hidden=true;
  const mapControls=document.createElement("div");mapControls.className="tour-map-controls";mapControls.hidden=true;
  const legend=document.createElement("div");legend.className="tour-line-legend tour-map-legend";legend.setAttribute("role","note");legend.setAttribute("aria-label","周遊ルートの凡例");
  badge.addEventListener("click",()=>document.querySelector('[data-view="tour"]').click());mapControls.append(legend,badge);appShell.append(mapControls);
  function renderLegend(target){
    target.replaceChildren();
    for(const [kind,label,description] of [["outbound",course.settings.returnToStart?"行き":"周遊ルート","緑の実線"],...(course.settings.returnToStart?[["return","帰り","オレンジの破線"]]:[])]){
      const item=document.createElement("span");item.setAttribute("aria-label",`${label}：${description}`);
      const swatch=document.createElement("span");swatch.className=`tour-line-swatch ${kind}`;swatch.setAttribute("aria-hidden","true");
      item.append(swatch,document.createTextNode(label));target.append(item);
    }
  }
  function tell(text,error=false){message(status,text,error);}
  function selectedStart(){return forceCurrent?currentPosition:getStartPoint();}
  function syncStart(){const p=selectedStart();$("tour-start-name").textContent=p?(forceCurrent||!searchedStart?"現在地":p.name||"地図で指定した地点"):"出発地点未設定";}
  function load(){
    try{
      const raw=localStorage.getItem(historyKey);
      if(raw){const data=JSON.parse(raw);if(data.version!==1||!Array.isArray(data.courses)||data.courses.length>TourCore.LIMITS.saved)throw Error();
        saved=data.courses.map(TourCore.validateCourse);if(new Set(saved.map(c=>c.id)).size!==saved.length||saved.some(c=>!TourCore.complete(c)||!Number.isFinite(Date.parse(c.completedAt))))throw Error();}
    }catch{saved=[];historyWritable=false;tell("保存した周遊を読み込めません。元のデータは上書きしません。",true);}
    try{const raw=localStorage.getItem(draftKey);if(raw){const data=JSON.parse(raw);course=TourCore.validateCourse(data);}}
    catch{draftWritable=false;tell("進行中の周遊を読み込めません。元のデータは上書きしません。",true);}
  }
  function persistDraft(){
    if(!course)return false;
    if(!draftWritable){tell("進行中の保存データは上書きしません。この画面で周遊を続けられます。",true);return false;}
    try{localStorage.setItem(draftKey,JSON.stringify(course));return true;}
    catch{tell("周遊の進捗を端末に保存できませんでした。この画面では引き続き操作できます。",true);return false;}
  }
  function busy(value){
    for(const control of $("tour-form").querySelectorAll("input,select,button"))control.disabled=value;
    $("tour-cancel").disabled=!value;$("tour-form").setAttribute("aria-busy",String(value));
    $("tour-generate").textContent=value?"コースを作成中…":"コースを作る";
    for(const control of $("tour-course").querySelectorAll("input,select,button"))control.disabled=value;
    if(!value)renderCourse();
  }
  function cancel(){if(!active)return;const request=active;active=null;request.controller.abort();busy(false);tell("周遊コースの作成を中止しました。");}
  function hideMap(){if(line)line.remove();line=null;markers.clearLayers();badge.hidden=true;mapControls.hidden=true;appShell.classList.remove("tour-active");}
  function deactivate(){cancel();hideMap();}
  function mapProgress(){
    if(!course)return;
    const pending=course.stops.filter(p=>!course.visited.includes(p.key));
    const current=pending[0]?.name||(course.settings.returnToStart&&!course.returned?"出発地点":"完了");
    badge.textContent=`周遊 ${course.visited.length}/${course.stops.length} · ${current}`;
  }
  function draw(fit=false){
    if(!course)return;hideMap();stopWalkingRoute();
    appShell.classList.add("tour-active");
    destinationMarker?.getElement()?.classList.add("tour-normal-destination");
    // Draw each fetched leg separately; never invent straight connectors between snaps.
    const outbound=course.settings.returnToStart?course.legs.slice(0,-1):course.legs;
    const paths=[L.polyline(outbound.map(l=>l.points),{color:"#245744",weight:6,opacity:.9,interactive:false,className:"tour-outbound-line"})];
    if(course.settings.returnToStart)paths.push(L.polyline(course.legs.at(-1).points,{color:"#E87524",weight:5,opacity:1,dashArray:"10 8",interactive:false,className:"tour-return-line"}));
    line=L.featureGroup(paths).addTo(map);
    L.circleMarker([course.start.lat,course.start.lng],{radius:7,color:"#fff",weight:2,fillColor:"#267DCE",fillOpacity:1}).addTo(markers).bindTooltip(textElement("span",course.start.name));
    const first=course.stops.find(p=>!course.visited.includes(p.key));
    course.stops.forEach((p,i)=>{
      const visited=course.visited.includes(p.key);
      const icon=L.divIcon({className:`tour-number-marker${visited?" is-visited":first?.key===p.key?" is-next":""}`,html:`<span>${i+1}</span>`,iconSize:[30,30],iconAnchor:[15,15]});
      const popup=document.createElement("div");popup.append(textElement("strong",`${i+1}. ${p.name}`),textElement("p",p.kindLabel));
      if(p.accessNote)popup.append(textElement("p",p.accessNote,"tour-help"));
      const view=textElement("button","地点登録");view.type="button";view.addEventListener("click",()=>selectPlace(p));popup.append(view);
      L.marker([p.lat,p.lng],{icon,bubblingMouseEvents:false}).addTo(markers).bindPopup(popup,{autoPan:false});
    });
    mapProgress();renderLegend(legend);badge.hidden=false;mapControls.hidden=false;
    if(fit)requestAnimationFrame(()=>{if(line)map.fitBounds(line.getBounds(),{padding:[40,40],maxZoom:16,animate:false});});
  }
  function renderCourse(){
    $("tour-course").hidden=!course;if(!course)return;
    const pending=course.stops.filter(p=>!course.visited.includes(p.key));
    $("tour-summary").textContent=`${routeDistance(course.distance)} ／ 徒歩約${routeDuration(course.duration)} ／ ${course.stops.length}地点`;
    renderLegend($("tour-route-legend"));
    $("tour-route-note").textContent=`${TourCore.THEMES[course.settings.theme].label}${course.settings.direction!=="any"?` · ${TourCore.DIRECTIONS[course.settings.direction]}方面`:""} · ${course.settings.speed} km/h · ${course.settings.returnToStart?"出発地点に戻る":"最後の地点で終了"}（ルート検索の推定）${course.overlap>=.15||course.returnOverlap>.15?"。一部で同じ道を通ります。":""}`;
    $("tour-progress").textContent=`訪問済み ${course.visited.length}/${course.stops.length}地点${TourCore.complete(course)?" · 完了":""}`;
    $("tour-next").textContent=pending.length?`現在の目的地：${pending[0].name}${pending[1]?` ／ 次：${pending[1].name}`:course.settings.returnToStart?" ／ 次：出発地点":""}`:course.settings.returnToStart&&!course.returned?"現在の目的地：出発地点":"すべての経由地の訪問を確認しました。";
    $("tour-stops").replaceChildren();
    course.stops.forEach((p,i)=>{
      const item=document.createElement("li");item.className="tour-stop";
      const heading=document.createElement("div");heading.className="tour-stop-title";
      const name=textElement("button",p.name);name.type="button";name.onclick=()=>{if(!line)draw();focusPlace(p,{keepZoom:true});};
      heading.append(textElement("span",String(i+1),"tour-stop-number"),name);item.append(heading,textElement("p",p.kindLabel,"tour-help"));
      if(p.accessNote)item.append(textElement("p",p.accessNote,"tour-help"));
      const label=document.createElement("label");label.className="tour-check";
      const check=document.createElement("input");check.type="checkbox";check.checked=course.visited.includes(p.key);check.disabled=!!active;check.dataset.tourKey=p.key;
      check.addEventListener("change",()=>{
        course.visited=check.checked?[...course.visited,p.key]:course.visited.filter(k=>k!==p.key);
        if(!check.checked)course.returned=false;persistDraft();const visible=!!line;renderCourse();if(visible)draw();
        [...$("tour-stops").querySelectorAll("input")].find(c=>c.dataset.tourKey===p.key)?.focus({preventScroll:true});
      });label.append(check,document.createTextNode("訪問済み"));item.append(label);
      const actions=document.createElement("div");actions.className="tour-stop-actions";
      for(const [text,disabled,run] of [["上へ",i===0,()=>edit([...course.stops.slice(0,i-1),p,course.stops[i-1],...course.stops.slice(i+1)])],
        ["下へ",i===course.stops.length-1,()=>edit([...course.stops.slice(0,i),course.stops[i+1],p,...course.stops.slice(i+2)])],
        ["入れ替え",false,()=>replacement(item,i)],["削除",course.stops.length===1,()=>edit(course.stops.filter((_,j)=>j!==i))]]){
        const button=textElement("button",text);button.type="button";button.disabled=disabled||!!active;button.setAttribute("aria-label",`${p.name}：${text}`);button.onclick=run;actions.append(button);
      }
      item.append(actions);$("tour-stops").append(item);
    });
    $("tour-return-confirm").hidden=!course.settings.returnToStart||pending.length>0;
    $("tour-returned").checked=course.returned;$("tour-returned").disabled=!!active;
    $("tour-save").disabled=!!active||!historyWritable||!TourCore.complete(course);
    for(const id of ["tour-regenerate","tour-show-map","tour-hide-map"])$(id).disabled=!!active;
    mapProgress();
  }
  function renderHistory(){
    $("tour-history").replaceChildren();$("tour-history-empty").hidden=saved.length>0;
    for(const entry of [...saved].sort((a,b)=>b.completedAt.localeCompare(a.completedAt))){
      const item=document.createElement("li");item.className="tour-history-card";
      item.append(textElement("strong",`${TourCore.THEMES[entry.settings.theme].label}${entry.settings.direction!=="any"?` · ${TourCore.DIRECTIONS[entry.settings.direction]}方面`:""}`),textElement("p",`${new Date(entry.completedAt).toLocaleDateString("ja-JP")} · ${entry.stops.length}地点`,"tour-help"),textElement("p",`${routeDistance(entry.distance)} ／ 約${routeDuration(entry.duration)}（ルート推定）`,"tour-help"));
      const show=textElement("button","コースを見る");show.type="button";show.onclick=()=>{cancel();course=TourCore.validateCourse(structuredClone(entry));$("tour-direction").value=course.settings.direction;pool=[];persistDraft();renderCourse();draw(true);$("tour-course").scrollIntoView({block:"nearest"});};
      const remove=textElement("button","削除");remove.type="button";remove.disabled=!historyWritable;remove.onclick=()=>{
        const next=saved.filter(c=>c.id!==entry.id);try{localStorage.setItem(historyKey,JSON.stringify({version:1,courses:next}));saved=next;renderHistory();tell("保存した周遊コースを削除しました。");}catch{tell("削除を保存できませんでした。元の記録は残しています。",true);}
      };item.append(show,remove);$("tour-history").append(item);
    }
  }
  async function search(config,start,signal){
    const kinds=TourCore.THEMES[config.theme].kinds,byKind=new Map();let next=0,failures=0;
    const minutes=Math.max(5,Math.min(config.minutes*(config.returnToStart ? .5 : .85),15000*60*1.3/(config.speed*1000)));
    async function worker(){
      while(next<kinds.length&&!signal.aborted){
        const kind=kinds[next++];const child={controller:new AbortController(),criteria:{kind,minutes,minMinutes:0,speed:config.speed,ambience:"any",direction:config.direction||"any",keyword:"",highElevation:false},randomProbe:true};
        const abort=()=>child.controller.abort();signal.addEventListener("abort",abort,{once:true});
        try{
          const result=await TourCore.bounded(async s=>{
            const stop=()=>child.controller.abort();s.addEventListener("abort",stop,{once:true});
            try{return await findDiscoveryPlaces(child.criteria,start,child,places=>{if(!s.aborted&&!signal.aborted)byKind.set(kind,places);});}
            finally{s.removeEventListener("abort",stop);}
          },3000,signal);
          if(!signal.aborted)byKind.set(kind,result);
        }catch(error){if(signal.aborted)throw error;failures++;}
        finally{signal.removeEventListener("abort",abort);child.controller.abort();}
      }
    }
    await Promise.all([worker(),worker()]);
    const rows=[...byKind.values()],mixed=[];
    for(let i=0;i<50;i++)for(const row of rows)if(row[i])mixed.push(row[i]);
    if(mixed.length<(config.autoCount?1:config.count)&&failures)throw new TourCore.TourError("SEARCH_API","一部の施設を検索できず、必要な候補を確認できませんでした。時間を置いて再試行してください。");
    return mixed;
  }
  const engine=TourCore.createEngine({search,progress:text=>{if(active)tell(text);},route:async(a,b,speed,signal,options={})=>{
    const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener("abort",abort,{once:true});
    if(signal.aborted)controller.abort();
    try{
      const route=await calculateWalkingRoute(a,b,"standard",speed,{controller},null,options.avoidPolygons||[]);
      if(route.steps.some(step=>step.mode!=="walking"))throw new TourCore.TourError("NO_ROUTE","徒歩だけの経路を確認できませんでした。");
      if(!routeAttributionAdded){map.attributionControl.addAttribution('<a href="https://valhalla.openstreetmap.de/">ルート: Valhalla / FOSSGIS</a>');routeAttributionAdded=true;}
      return route;
    }catch(error){
      if(signal.aborted)throw error;
      throw TourCore.routeFailure(error);
    }finally{signal.removeEventListener("abort",abort);controller.abort();}
  }});
  function formSettings(){const minutes=Number($("tour-hours").value)*60+Number($("tour-minutes").value);return TourCore.settings({minutes,count:TourCore.automaticCount(minutes),autoCount:true,speed:Number($("tour-speed").value),theme:$("tour-theme").value,direction:$("tour-direction").value,returnToStart:$("tour-return").checked});}
  async function work(task){
    if(active)return;const request={controller:new AbortController()};active=request;busy(true);
    try{const result=await task(request.controller.signal);if(active!==request||request.controller.signal.aborted)return;
      course=result.course||result;if(result.pool)pool=result.pool;const stored=persistDraft();renderCourse();draw(true);if(stored)tell("周遊コースを作成しました。");$("tour-course").scrollIntoView({block:"nearest",behavior:"instant"});
    }catch(error){if(active===request)tell(error.name==="AbortError"?"周遊コースの作成を中止しました。":error.message||"周遊コースを作成できませんでした。",error.name!=="AbortError");}
    finally{if(active===request){active=null;busy(false);}}
  }
  function generate(useCurrentSettings=true){
    if(active||(useCurrentSettings&&!$("tour-form").reportValidity()))return;
    try{const config=useCurrentSettings?formSettings():{...course.settings,autoCount:true};const start=useCurrentSettings?selectedStart():course.start;
      if(!start){requestCurrentLocation();throw new TourCore.TourError("START","出発地点を検索または地図で指定してください。");}
      if(config.theme==="unfamiliar"&&(!storageReadable||!historyWritable))throw new TourCore.TourError("STORAGE","訪問記録を読み込めないため、記録のない場所を判定できません。");
      const known=[...(storageReadable?visits:[]),...saved.flatMap(c=>c.stops.filter(p=>c.visited.includes(p.key)))];
      work(signal=>engine.generate(config,start,{signal,visits:known,seed:Math.floor(Math.random()*1000)}));
    }catch(error){tell(error.message,true);}
  }
  function edit(stops){work(signal=>engine.rebuild(course,stops,signal));}
  async function replacement(item,index){
    if(active)return;
    if(!pool.some(p=>!course.stops.some(s=>s.key===p.key))){
      const request={controller:new AbortController()};active=request;busy(true);tell("入れ替える場所を検索中…");
      try{
        if(course.settings.theme==="unfamiliar"&&(!storageReadable||!historyWritable))throw new TourCore.TourError("STORAGE","訪問記録を読み込めないため、記録のない場所を判定できません。");
        const raw=await TourCore.bounded(s=>search({...course.settings,count:1},course.start,s),TourCore.LIMITS.searchMs,request.controller.signal,"SEARCH_TIMEOUT");
        if(active!==request||request.controller.signal.aborted)return;
        const known=[...(storageReadable?visits:[]),...saved.flatMap(c=>c.stops.filter(p=>c.visited.includes(p.key)))];
        pool=TourCore.candidates(raw,course.start,known,course.settings.theme==="unfamiliar",course.settings.direction||"any");
      }catch(error){if(active===request)tell(error.name==="AbortError"?"候補の検索を中止しました。":error.message,true);return;}
      finally{if(active===request){active=null;busy(false);}}
      item=$("tour-stops").children[index];
    }
    if(!item?.isConnected)return;
    item.querySelector(".tour-replacement")?.remove();
    const box=document.createElement("div");box.className="tour-replacement";
    const options=pool.filter(p=>!course.stops.some(s=>s.key===p.key));
    if(!options.length){tell("入れ替え用の候補がありません。コースを再生成してください。",true);return;}
    const label=textElement("label","入れ替える場所"),select=document.createElement("select");label.htmlFor=`tour-replace-${index}`;select.id=label.htmlFor;
    options.forEach((p,i)=>{const option=textElement("option",`${p.name} ／ ${p.kindLabel}`);option.value=String(i);select.append(option);});
    const apply=textElement("button","この場所に入れ替え");apply.type="button";apply.onclick=()=>edit(course.stops.map((p,i)=>i===index?options[Number(select.value)]:p));
    box.append(label,select,apply);item.append(box);select.focus();
  }
  $("tour-form").addEventListener("submit",event=>{event.preventDefault();generate();});
  $("tour-cancel").addEventListener("click",cancel);$("tour-regenerate").addEventListener("click",()=>generate(false));
  $("tour-show-map").addEventListener("click",()=>{draw(true);document.querySelector('[data-view="map"]').click();});
  $("tour-hide-map").addEventListener("click",hideMap);
  $("tour-speed").addEventListener("input",()=>{$("tour-speed-value").textContent=`${Number($("tour-speed").value).toFixed(1)} km/h`;});
  $("tour-speed").addEventListener("keydown",event=>{if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key))event.stopPropagation();});
  $("tour-returned").addEventListener("change",()=>{if(!course)return;course.returned=$("tour-returned").checked;persistDraft();renderCourse();mapProgress();});
  $("tour-save").addEventListener("click",()=>{
    if(!course||!TourCore.complete(course)||!historyWritable)return;
    if(saved.length>=TourCore.LIMITS.saved&&!saved.some(c=>c.id===course.id)){tell("保存できる周遊は50件までです。不要な保存コースを削除してください。",true);return;}
    const entry=TourCore.validateCourse(structuredClone({...course,completedAt:new Date().toISOString()})),next=[...saved.filter(c=>c.id!==course.id),entry];
    try{localStorage.setItem(historyKey,JSON.stringify({version:1,courses:next}));saved=next;course=structuredClone(entry);const stored=persistDraft();renderHistory();tell(stored?"完了した周遊コースを保存しました。":"完了コースは保存しましたが、進行中の記録は保存できませんでした。",!stored);}catch{tell("保存できませんでした。ブラウザの保存設定と空き容量を確認してください。",true);}
  });
  $("tour-use-current").addEventListener("click",()=>{forceCurrent=true;syncStart();if(!currentPosition)requestCurrentLocation();});
  $("tour-change-start").addEventListener("click",()=>{forceCurrent=false;pickingStart=true;document.querySelector('[data-view="search"]').click();$("change-start").click();});
  document.addEventListener("click",event=>{const nav=event.target.closest("[data-view]");if(nav&&nav.dataset.view!=="search")pickingStart=false;});
  document.addEventListener("walking:start-selected",()=>{syncStart();if(pickingStart){pickingStart=false;document.querySelector('[data-view="tour"]').click();}});
  new MutationObserver(syncStart).observe(ui["location-button"],{attributes:true,attributeFilter:["aria-busy"]});
  screen.addEventListener("keydown",event=>{if(event.key==="Escape"){event.stopPropagation();document.querySelector('[data-view="map"]').click();}});
  function viewport(){
    const visible=window.visualViewport;
    const height=visible?.height||innerHeight,inset=Math.max(0,innerHeight-height-(visible?.offsetTop||0));
    screen.style.setProperty("--tour-visible-height",`${height}px`);screen.style.setProperty("--tour-keyboard-inset",`${inset}px`);
    screen.classList.toggle("keyboard-open",(visible?.scale||1)<1.1&&height<innerHeight-100);
    const field=document.activeElement,content=$("tour-content");
    if(screen.hidden||!content.contains(field)||!field.matches('input[type="number"],select'))return;
    const box=field.getBoundingClientRect(),area=content.getBoundingClientRect();
    if(box.bottom>area.bottom-12)content.scrollTop+=box.bottom-area.bottom+12;
    else if(box.top<area.top+12)content.scrollTop+=box.top-area.top-12;
  }
  window.visualViewport?.addEventListener("resize",viewport);screen.addEventListener("focusin",()=>requestAnimationFrame(viewport));
  load();renderHistory();renderCourse();
  return {open(){screen.hidden=false;syncStart();if(!initialized){initialized=true;$("tour-speed").value=currentWalkingSpeed().kmh;$("tour-speed").dispatchEvent(new Event("input"));$("tour-direction").value=course?.settings.direction||"any";}},close(){screen.hidden=true;},hideMap,deactivate,
    getCourse:()=>course,getSaved:()=>saved,isBusy:()=>!!active,engine};
})();
