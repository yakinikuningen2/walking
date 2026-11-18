const WalkingSession = (() => {
  "use strict";
  const Core=WalkSessionCore,storage={getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)},book=new Core.RouteBook(storage),draftKey="walking.gps-draft.v1",prefKey="walking.measurement.v1";
  let recorder=null,draftBlocked=false,weight=null,avoid=true,measuredKmh=null,lastPersist=0,track=null,preview=null;
  try {const raw=localStorage.getItem(prefKey);if(raw){const p=JSON.parse(raw);if(p.version===1){weight=Number.isFinite(p.weight)&&p.weight>=20&&p.weight<=300?p.weight:null;avoid=p.avoid!==false;
    measuredKmh=Number.isFinite(p.measuredKmh)&&p.measuredKmh>=2.5&&p.measuredKmh<=6.5?p.measuredKmh:null;}}}catch{}
  try {const raw=localStorage.getItem(draftKey);if(raw){const draft=JSON.parse(raw);if(!book.records.some(r=>r.id===draft.id))recorder=new Core.Recorder(draft);}}catch{draftBlocked=true;}
  const screen=document.createElement("section");screen.id="walk-screen";screen.className="walk-screen";screen.hidden=true;
  screen.setAttribute("role","region");screen.setAttribute("aria-labelledby","walk-heading");
  screen.innerHTML=`<div class="walk-heading"><div class="sheet-grip" aria-hidden="true"></div><div><span class="section-label">散歩の記録</span><h2 id="walk-heading">散歩の計測</h2></div><div class="heading-actions"><button class="sheet-expand icon-button" type="button" aria-label="計測画面を展開" aria-expanded="false"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><use href="#i-chevron"/></svg></button><button id="close-walk" class="icon-button" type="button" aria-label="計測画面を閉じる"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><use href="#i-close"/></svg></button></div></div>
    <div id="walk-content"><section><div class="walk-live-metrics"><div><span>距離</span><output id="walk-distance">0 m</output></div><div><span>歩いた時間</span><output id="walk-moving">0:00</output></div><div><span>消費カロリー</span><output id="walk-calories">—</output></div><div><span>平均の歩く速さ</span><output id="walk-speed">—</output></div></div>
    <p id="walk-elapsed" class="walk-help">計測時間 0:00</p><div class="walk-buttons"><button id="walk-start" type="button">計測開始</button><button id="walk-pause" type="button" class="secondary" disabled>一時停止</button><button id="walk-end" type="button" class="secondary" disabled>終了</button></div>
    <label for="walk-weight">体重（kg・カロリー計算用、任意）</label><input id="walk-weight" type="number" min="20" max="300" step="0.1" inputmode="decimal" placeholder="未設定"/><p class="walk-help">平地を歩く場合の目安です。安静時の消費分は含みません。体重は外部へ送信しません。<a href="https://www.yspc-ysmc.jp/ysmc/column/health-fitness/run-1.html" target="_blank" rel="noopener">計算方法の出典</a></p>
    <button id="walk-use-speed" type="button" disabled>計測した速さを設定する</button><p id="walk-speed-help" class="walk-help">100m以上・歩行区間60秒以上で平均の速さを表示します。</p>
    <p class="walk-help">動きを確認できた区間を集計します。画面を閉じる・ロックする際は一時停止します。戻ったら再開してください。</p>
    <div id="walk-save-fields" hidden><label for="walk-record-name">記録名</label><input id="walk-record-name" maxlength="120" placeholder="散歩の記録"/><label for="walk-record-note">メモ</label><textarea id="walk-record-note" maxlength="1000" rows="2"></textarea><div class="walk-buttons"><button id="walk-save" type="button">記録を保存</button><button id="walk-discard" type="button" class="secondary">計測を破棄</button></div></div></section>
    <p id="walk-status" class="status" role="status" aria-live="polite"></p>
    <section><h3>表示中のルートを登録</h3><button id="walk-save-plan" type="button">表示中のルートを保存</button><label class="walk-checkbox"><input id="walk-avoid" type="checkbox"/>保存した道をなるべく避ける</label><p class="walk-help">保存したルートを対象に、次の検索から反映します。出発・到着地点の付近や一本道など、同じ道を通る場合があります。</p></section>
    <section><div class="results-heading"><h3>散歩の集計</h3><label class="sr-only" for="walk-month">集計月</label><input id="walk-month" type="month"/></div><p id="walk-month-summary" class="walk-help"></p></section>
    <section><h3>保存したルート</h3><p id="walk-history-empty" class="walk-help">保存したルートはありません。</p><ul id="walk-history" class="place-list"></ul></section></div>`;
  appShell.append(screen);
  screen.querySelector(".walk-live-metrics").before(screen.querySelector("#walk-start").parentElement);
  const nav=textElement("button","");nav.type="button";nav.dataset.view="walk";nav.setAttribute("aria-controls","walk-screen");
  nav.innerHTML='<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><use href="#i-clock"/></svg><span>計測</span>';
  document.querySelector('.navigation-items [data-view="saved"]').before(nav);
  const $=id=>document.getElementById(id),tell=(text,error=false)=>message($("walk-status"),text,error);
  const routeControls=$("walk-save-plan").closest("section"),routeHistory=$("walk-history").closest("section");
  routeControls.id="registered-route-controls";routeHistory.id="registered-route-history";
  const bookStatus=textElement("p","","status");bookStatus.id="route-book-status";
  bookStatus.setAttribute("role","status");bookStatus.setAttribute("aria-live","polite");$("walk-save-plan").after(bookStatus);
  ui["walk-stats"].closest("section").before(routeControls);
  ui["visits-list"].closest("section").after(routeHistory);
  const tellBook=(text,error=false)=>message(bookStatus,text,error);
  $("walk-weight").value=weight===null?"":weight;$("walk-avoid").checked=avoid;
  $("walk-month").value=localDate().slice(0,7);
  function clock(seconds){const n=Math.max(0,Math.floor(seconds));return `${Math.floor(n/3600)?`${Math.floor(n/3600)}:`:""}${String(Math.floor(n/60)%60).padStart(2,"0")}:${String(n%60).padStart(2,"0")}`;}
  function persistDraft(force=false) {
    if(!recorder||draftBlocked||(!force&&Date.now()-lastPersist<15000))return;
    try{localStorage.setItem(draftKey,JSON.stringify(recorder.record({weightKg:weight})));lastPersist=Date.now();}
    catch{tell("計測の途中保存ができません。画面を閉じる前に記録を保存してください。",true);}
  }
  function paint() {
    const distance=recorder?.distanceMeters||0,speed=recorder?.speed(),cal=Core.calories(distance,weight);
    $("walk-distance").textContent=routeDistance(distance);$("walk-moving").textContent=clock(recorder?.movingSeconds||0);
    $("walk-calories").textContent=cal===null?"体重未設定":`${Math.round(cal)} kcal`;
    $("walk-speed").textContent=speed===null||speed===undefined?"—":`${speed.toFixed(1)} km/h`;
    $("walk-elapsed").textContent=`計測時間 ${clock(recorder?.elapsed()||0)}${recorder?.running?" ・計測中":recorder?" ・停止中":""}${recorder?.gaps?" ・未計測区間あり":""}${recorder?.geometryLimited?" ・軌跡の一部を省略":""}`;
    $("walk-start").disabled=!!recorder?.running||draftBlocked;$("walk-start").textContent=recorder?.running?"計測中":recorder?"再開":"計測開始";
    $("walk-pause").disabled=!recorder?.running;$("walk-end").disabled=!recorder;
    $("walk-save-fields").hidden=!recorder&&!draftBlocked;$("walk-save").disabled=!recorder||recorder.running||!(distance>=5||recorder.elapsed()>0);
    $("walk-use-speed").disabled=!Number.isFinite(speed)||speed<2.5||speed>6.5;
    const choice=Number.isFinite(speed)&&speed>=2.5&&speed<=6.5?Math.round(speed*10)/10:measuredKmh;
    measuredChoice.disabled=choice===null;measuredChoice.textContent=choice===null?"計測した速さを選ぶ（未計測）":`計測した速さ ${choice.toFixed(1)} km/h を選ぶ`;
    $("walk-speed-help").textContent=Number.isFinite(speed)?speed<2.5||speed>6.5?"計測結果が設定範囲（2.5〜6.5 km/h）の外です。もう少し歩いて確認してください。":"この平均速度を、歩く速さの設定に保存できます。":"100m以上・歩行区間60秒以上で平均の速さを表示します。";
  }
  function drawTrack(){
    track?.remove();track=null;if(!recorder)return;
    const lines=recorder.segments.filter(s=>s.length>1);if(!lines.length)return;
    const pane=map.getPane("walkTracks")||map.createPane("walkTracks");pane.style.zIndex="335";pane.style.pointerEvents="none";
    track=L.polyline(lines,{pane:"walkTracks",color:"#245744",weight:3,opacity:.75,interactive:false}).addTo(map);
  }
  function currentRoute(){
    if(appShell.classList.contains("tour-active")){
      const c=WalkingTour.getCourse();if(c)return {points:c.legs.flatMap((leg,i)=>leg.points.slice(i?1:0)),distance:c.distance,duration:c.duration,name:"周遊コース"};
    }
    const r=NearbyRouting.route||routeChoices.get(activeRouteKind)?.route;
    return r?{...r,name:destination?.name||"予定ルート"}:null;
  }
  function history(){
    $("walk-history").replaceChildren();$("walk-history-empty").hidden=!!book.records.length;
    for(const r of book.records){
      const li=document.createElement("li");li.className="walk-history-card";
      li.append(textElement("strong",r.name),textElement("p",`${new Date(r.date).toLocaleDateString("ja-JP")}${r.source==="plan"?" ／ 予定":""}`,"walk-help"));
      li.append(textElement("p",`距離 ${routeDistance(r.distanceMeters)} ／ 時間 ${clock(r.durationSeconds)}`));
      if(r.source==="gps")li.append(textElement("p",`歩いた時間 ${clock(r.movingSeconds)} ／ 消費カロリー ${r.weightKg===null?"体重未設定":`約${Math.round(Core.calories(r.distanceMeters,r.weightKg))} kcal`}`,"walk-help"));
      if(r.steps)li.append(textElement("p",`${(r.steps.sensorSteps+r.steps.estimatedSteps).toLocaleString("ja-JP")}歩${r.steps.estimatedSteps?`（推定 ${r.steps.estimatedSteps.toLocaleString("ja-JP")}歩）`:""}`,"walk-help"));
      if(r.note)li.append(textElement("p",r.note));
      if(r.geometryLimited)li.append(textElement("p","軌跡は直近100区間のみを保存しています。距離・時間にはそれ以前の有効な計測も含みます。","walk-help"));
      const actions=textElement("div","","walk-buttons"),show=textElement("button","地図に表示","secondary"),remove=textElement("button","削除","secondary");show.type=remove.type="button";
      show.addEventListener("click",()=>{preview?.remove();const lines=r.segments.filter(s=>s.length>1);if(!lines.length){tellBook("表示できる軌跡がありません。",true);return;}
        const pane=map.getPane("walkTracks")||map.createPane("walkTracks");pane.style.zIndex="335";pane.style.pointerEvents="none";
        preview=L.polyline(lines,{pane:"walkTracks",color:"#75857D",weight:4,interactive:false}).addTo(map);
        document.querySelector('[data-view="map"]').click();map.fitBounds(preview.getBounds(),{padding:[32,90],maxZoom:16,animate:false});});
      remove.addEventListener("click",()=>{try{book.remove(r.id);preview?.remove();preview=null;history();tellBook("記録を削除しました。");}catch(e){tellBook(e.message,true);}});
      actions.append(show,remove);li.append(actions);$("walk-history").append(li);
    }
    if(typeof WalkPedometer!=="undefined")WalkPedometer.history();
  }
  function pause(text="一時停止中") {if(recorder?.running){if(typeof WalkPedometer!=="undefined")WalkPedometer.pause();recorder.pause();rememberMeasured();persistDraft(true);paint();if(text)tell(text);}}
  $("walk-start").addEventListener("click",()=>{
    if(draftBlocked)return;
    if(!recorder)recorder=new Core.Recorder();recorder.start();
    if(typeof WalkPedometer!=="undefined")WalkPedometer.start(recorder);
    const hasLocation=window.isSecureContext!==false&&navigator.geolocation&&!locationPermissionDenied;
    if(hasLocation)startWatchingLocation();persistDraft(true);paint();
    tell(hasLocation?"":"位置情報を利用できないため距離は計測できません。歩数・時間は計測できます。",!hasLocation);});
  $("walk-pause").addEventListener("click",()=>pause());
  $("walk-end").addEventListener("click",()=>{pause("");paint();tell("計測終了。保存できます。");});
  $("walk-weight").addEventListener("change",()=>{const value=$("walk-weight").value.trim(),next=value===""?null:Number(value);
    if(next!==null&&(!Number.isFinite(next)||next<20||next>300)){tell("体重は20〜300kgで入力してください。",true);return;}weight=next;savePreferences();paint();persistDraft(true);});
  function savePreferences(report=tell){try{localStorage.setItem(prefKey,JSON.stringify({version:1,weight,avoid,measuredKmh}));}catch{report("設定を端末に保存できません。この画面を開いている間は利用できます。",true);}}
  function rememberMeasured(){const speed=recorder?.speed();if(Number.isFinite(speed)&&speed>=2.5&&speed<=6.5){measuredKmh=Math.round(speed*10)/10;savePreferences();}}
  function selectMeasured(){const speed=recorder?.speed(),value=Number.isFinite(speed)&&speed>=2.5&&speed<=6.5?Math.round(speed*10)/10:measuredKmh;
    if(value===null)return false;ui["custom-walking-speed"].value=value.toFixed(1);ui["custom-walking-speed"].dispatchEvent(new Event("input",{bubbles:true}));return true;}
  $("walk-avoid").addEventListener("change",()=>{avoid=$("walk-avoid").checked;savePreferences(tellBook);});
  $("walk-use-speed").addEventListener("click",()=>{const speed=recorder?.speed();if(!Number.isFinite(speed)||speed<2.5||speed>6.5)return;
    rememberMeasured();selectMeasured();
    ui["walking-settings-form"].requestSubmit();document.querySelector('[data-view="map"]').click();tell(`歩く速さを時速${(Math.round(speed*10)/10).toFixed(1)}kmに設定しました。`);});
  $("walk-save").addEventListener("click",()=>{if(!recorder||recorder.running||!(recorder.distanceMeters>=5||recorder.elapsed()>0))return;
    try{const record=recorder.record({name:$("walk-record-name").value.trim()||"散歩の記録",note:$("walk-record-note").value,weightKg:weight});book.add(record);
      recorder=null;if(typeof WalkPedometer!=="undefined")WalkPedometer.reset();try{localStorage.removeItem(draftKey);}catch{tell("記録は保存しましたが、途中データを削除できませんでした。",true);history();paint();return;}
      $("walk-record-name").value="";$("walk-record-note").value="";track?.remove();track=null;history();paint();tell("記録を保存しました。");
    }catch(e){tell(e.message||"保存できません。空き容量を確認してください。",true);}});
  $("walk-discard").addEventListener("click",()=>{try{localStorage.removeItem(draftKey);}catch{tell("途中データを削除できません。",true);return;}recorder=null;if(typeof WalkPedometer!=="undefined")WalkPedometer.reset();draftBlocked=false;track?.remove();track=null;paint();tell("");});
  $("walk-save-plan").addEventListener("click",()=>{const route=currentRoute();if(!route){tellBook("先にルートを地図に表示してください。",true);return;}
    try{book.add(Core.validate({version:1,id:`plan-${Date.now()}`,name:route.name.slice(0,120),date:new Date().toISOString(),source:"plan",distanceMeters:route.distance,durationSeconds:route.duration,movingSeconds:0,weightKg:null,note:"",segments:Core.compact([route.points])}));history();tellBook("表示中のルートを保存しました。");}catch(e){tellBook(e.message||"保存できませんでした。",true);}});
  $("close-walk").addEventListener("click",()=>document.querySelector('[data-view="map"]').click());
  const speedMeasure=textElement("button","歩く速さを計測する","secondary");speedMeasure.type="button";
  speedMeasure.addEventListener("click",()=>nav.click());document.querySelector(".settings-actions").before(speedMeasure);
  const measuredChoice=textElement("button","計測した速さを選ぶ（未計測）","secondary");measuredChoice.id="use-measured-walking-speed";measuredChoice.type="button";
  measuredChoice.addEventListener("click",()=>{rememberMeasured();selectMeasured();});speedMeasure.after(measuredChoice);
  const badge=textElement("button","計測中","walk-recording-badge");badge.type="button";badge.hidden=true;badge.addEventListener("click",()=>nav.click());appShell.append(badge);
  setInterval(()=>{if(recorder?.running){paint();persistDraft();}badge.hidden=!recorder?.running;},1000);
  document.addEventListener("visibilitychange",()=>{if(document.hidden)pause("画面を離れたため一時停止しました。再開できます。");});
  window.addEventListener("pagehide",()=>{pause("");persistDraft(true);});
  history();paint();if(!book.readable){tell("保存したルートを読み込めません。既存データは上書きしていません。",true);tellBook("保存したルートを読み込めません。既存データは上書きしていません。",true);}
  else if(draftBlocked)tell("途中の計測を読み込めません。「計測を破棄」で削除してから始めてください。",true);
  else if(recorder)tell("途中の計測があります。「再開」で続けられます。");
  return {open(){screen.hidden=false;paint();},close(){screen.hidden=true;},
    stepsChanged(){persistDraft();paint();},
    fix(position){if(recorder?.running){const before=recorder.distanceMeters,from=recorder.anchor?.t;
      if(recorder.fix(position)){if(typeof WalkPedometer!=="undefined")WalkPedometer.gps(recorder.distanceMeters-before,from,position.timestamp);drawTrack();persistDraft();}paint();}},
    choose(routes){return book.choose(routes,avoid);},historyKey(){return `${avoid}/${book.revision}/${book.records.length}`;},
    get hasHistory(){return avoid&&book.records.length>0;},get recorder(){return recorder;},get records(){return book.records;}};
})();
