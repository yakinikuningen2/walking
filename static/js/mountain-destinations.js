// Explicit choice of a real mountain access point. No summit coordinate rewriting.
const MountainDestinations = (() => {
  'use strict';
  const C=MountainCore,cache=new Map();let current=null,pending=null,version=0;
  const markers=L.layerGroup().addTo(map),panel=document.createElement('section');
  panel.id='mountain-panel';panel.className='mountain-panel';panel.hidden=true;panel.setAttribute('role','region');panel.setAttribute('aria-labelledby','mountain-heading');
  panel.innerHTML=`<header><div><span class="section-label">山の目的地</span><h2 id="mountain-heading"></h2></div><button id="mountain-close" type="button" class="secondary" aria-label="山の目的地を閉じる">閉じる</button></header><div class="mountain-content"><p class="mountain-help">山頂は地点情報のみ表示します。徒歩で向かう場所は、下の候補から選んでください。</p><button id="mountain-summit" type="button" class="secondary">山・山頂の地点情報を見る</button><h3>周辺の登山口・五合目</h3><p class="mountain-help">山の検索地点から15km以内の周辺候補です。同じ山の入口か確認できない場合があるため、名称と地図を確認して選んでください。</p><p id="mountain-status" class="status" role="status" aria-live="polite"></p><div class="mountain-search-actions"><button id="mountain-retry" type="button" class="secondary">候補を再検索</button><button id="mountain-cancel" type="button" class="secondary" hidden>中止</button></div><ul id="mountain-results" class="place-list"></ul><p class="mountain-safety"></p><p class="mountain-help">出典：© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>（ODbL）。地図データに登録された地点を表示しています。</p></div>`;
  appShell.append(panel);
  const $=id=>document.getElementById(id),tell=(text,error=false)=>message($('mountain-status'),text,error);
  panel.querySelector('.mountain-safety').textContent=C.SAFETY;
  $('mountain-summit').after(panel.querySelector('.mountain-safety'));
  function cancel(){pending?.controller.abort();pending=null;$('mountain-cancel').hidden=true;$('mountain-retry').disabled=false;}
  function close(){version++;cancel();panel.hidden=true;markers.clearLayers();current=null;}
  function info(){
    if(!current)return;focusPlace(current,{keepZoom:true});
    const popup=document.createElement('div');popup.append(textElement('strong',current.name),textElement('p','山・山頂（地点情報のみ）'),textElement('p','山頂の座標は変更していません。登山口・五合目への案内は候補から選択してください。','mountain-help'));
    const save=textElement('button','地点登録','secondary');save.type='button';save.onclick=()=>{const place=current;close();selectPlace(place);};popup.append(save);
    L.popup({autoPan:false}).setLatLng([current.lat,current.lng]).setContent(popup).openOn(map);
    if(typeof PlacePhotos!=='undefined')PlacePhotos.mount(popup,current);
  }
  function choose(place,route){
    const goal={...place};close();setDestination(goal);if(route)beginWalkingRoute('standard');
  }
  function render(result){
    $('mountain-results').replaceChildren();markers.clearLayers();if(!current)return;
    L.circleMarker([current.lat,current.lng],{radius:8,color:'#fff',weight:2,fillColor:'#75857D',fillOpacity:1,bubblingMouseEvents:false}).addTo(markers).bindTooltip(textElement('span',`${current.name}（山・山頂）`));
    for(const place of result.places){
      const item=textElement('li','','mountain-candidate'),title=textElement('button',place.name,'mountain-place-name');title.type='button';
      const show=()=>focusPlace(place,{keepZoom:true});title.onclick=show;
      item.append(title,textElement('p',`${place.kindLabel} ／ 山の検索地点から直線 ${(place.mountainDistance/1000).toFixed(1)} km`,'mountain-help'));
      const source=textElement('a','OSMの地点情報');source.href=place.sourceUrl;source.target='_blank';source.rel='noopener';
      const actions=textElement('div','','mountain-candidate-actions'),set=textElement('button','目的地に指定','secondary'),route=textElement('button','徒歩ルートを表示');
      set.type=route.type='button';set.onclick=()=>choose(place,false);route.onclick=()=>choose(place,true);actions.append(set,route);item.append(source,actions);$('mountain-results').append(item);
      const popup=document.createElement('div');popup.append(textElement('strong',place.name),textElement('p',place.kindLabel),textElement('p',C.SAFETY,'mountain-help'));
      const pick=textElement('button','目的地に指定','secondary');pick.type='button';pick.onclick=()=>choose(place,false);popup.append(pick);
      L.circleMarker([place.lat,place.lng],{radius:7,color:'#fff',weight:2,fillColor:'#245744',fillOpacity:1,bubblingMouseEvents:false}).addTo(markers).bindTooltip(textElement('span',place.name)).bindPopup(popup,{autoPan:false});
    }
    tell(result.places.length?`${result.places.length}件${result.backup?'（予備検索）':result.limited?'（範囲・件数を制限して表示）':''}`:'検索した範囲では、徒歩で向かう候補の登山口・五合目が見つかりませんでした。');
  }
  async function backupSearch(origin,request){
    const elements=[];
    for(const query of ['登山口','五合目']){
      if(request.controller.signal.aborted)throw new DOMException('Aborted','AbortError');
      await abortableRouteDelay(Math.max(0,1000-(Date.now()-lastSearchAt)),request.controller.signal);
      const controller=new AbortController(),abort=()=>controller.abort();request.controller.signal.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(3000,request.deadlineAt-Date.now())));
      try{
        lastSearchAt=Date.now();const url=new URL(SEARCH_ENDPOINT);url.search=new URLSearchParams({q:query,lat:String(origin.lat),lon:String(origin.lng),limit:'30',lang:'default'}).toString();
        const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw Error('Mountain backup search unavailable');
        elements.push(...C.photonElements(await response.json()));
      }catch(error){if(request.controller.signal.aborted)throw error;}
      finally{clearTimeout(timer);request.controller.signal.removeEventListener('abort',abort);}
    }
    const result=C.parse(elements,origin);if(!result.places.length)throw Error('No backup access candidates');
    return {...result,limited:true,backup:true};
  }
  async function search(){
    cancel();if(!current)return;const selected=current,token=version,key=`${selected.lat.toFixed(5)},${selected.lng.toFixed(5)}`;
    const hit=cache.get(key);if(hit&&Date.now()-hit.at<(hit.result.places.length?C.LIMITS.ttl:30000)){render(hit.result);return;}
    const request={controller:new AbortController(),deadlineAt:Date.now()+C.LIMITS.timeoutMs},timer=setTimeout(()=>request.controller.abort(),C.LIMITS.timeoutMs);pending=request;
    $('mountain-retry').disabled=true;$('mountain-cancel').hidden=false;tell('登山口・五合目を検索中…');
    try{
      let result;
      try{const elements=await fetchDiscoveryMapData(C.query(selected),{...request,deadlineAt:Math.min(request.deadlineAt,Date.now()+8000)},7000,false,{providerDelayMs:600});result=C.parse(elements,selected);}
      catch(error){if(request.controller.signal.aborted)throw error;try{result=await backupSearch(selected,request);}catch(backupError){if(request.controller.signal.aborted)throw backupError;throw error;}}
      if(pending!==request||token!==version||request.controller.signal.aborted)return;
      cache.set(key,{at:Date.now(),result});while(cache.size>C.LIMITS.cache)cache.delete(cache.keys().next().value);render(result);
    }catch(error){if(pending===request&&token===version)tell(error.name==='AbortError'||error.routeCode==='MapTimeout'||error.httpStatus===504?'候補の検索がタイムアウトしました。':error.httpStatus===429||error.httpStatus===503?'検索先が混み合っているため、候補を取得できませんでした。':'通信エラーにより候補を取得できませんでした。',true);}
    finally{clearTimeout(timer);if(pending===request){pending=null;$('mountain-retry').disabled=false;$('mountain-cancel').hidden=true;}}
  }
  function open(place){
    if(!C.summit(place)||!C.point(place))return;
    close();document.querySelector('button[data-view="map"]').click();current=C.decorate({...place});$('mountain-heading').textContent=current.name||'山・山頂';
    $('mountain-results').replaceChildren();panel.hidden=false;render({places:[],limited:false});tell('');focusPlace(current,{keepZoom:true});$('mountain-close').focus({preventScroll:true});search();
  }
  function destinationChanged(place){
    if(!panel.hidden)close();let note=$('mountain-route-notice');
    if(!note){note=textElement('p','','mountain-safety');note.id='mountain-route-notice';ui['destination-name'].after(note);}
    note.hidden=!C.access(place);note.textContent=C.access(place)?`${C.LABELS[C.type(place)]}を目的地に設定しています。${C.SAFETY}`:'';
  }
  $('mountain-close').onclick=close;$('mountain-summit').onclick=info;$('mountain-retry').onclick=()=>{if(current)cache.delete(`${current.lat.toFixed(5)},${current.lng.toFixed(5)}`);search();};
  $('mountain-cancel').onclick=()=>{cancel();tell('候補の検索を中止しました。');};
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.stopPropagation();close();}});
  document.addEventListener('click',event=>{if(event.target.closest?.('button[data-view]'))close();});
  return {open,close,destinationChanged,get current(){return current;}};
})();
