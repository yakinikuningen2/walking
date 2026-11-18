const WalkPedometer = (() => {
  "use strict";
  const Core=WalkStepsCore,$=id=>document.getElementById(id),prefKey="walking.steps.preferences.v1";
  let goal=6000,strideCm=70,counter=null,record=null,generation=0,watchdog=null,lastEvent=0,notice="",listening=false;
  const detector=new Core.Detector();
  try{const p=JSON.parse(localStorage.getItem(prefKey));if(p?.version===1){
    if(Number.isInteger(p.goal)&&p.goal>=1&&p.goal<=100000)goal=p.goal;
    if(Number.isInteger(p.strideCm)&&p.strideCm>=30&&p.strideCm<=150)strideCm=p.strideCm;
  }}catch{}
  const metrics=$('walk-screen').querySelector('.walk-live-metrics'),steps=document.createElement('div');steps.className='walk-steps-metric';
  steps.innerHTML='<span>歩数 <small id="walk-step-source"></small></span><output id="walk-steps">0 歩</output>';
  metrics.prepend(steps);
  const settings=document.createElement('section');settings.className='walk-step-settings';
  settings.innerHTML=`<div class="step-setting-fields"><div><label for="walk-step-goal">歩数目標（1回の散歩）</label><input id="walk-step-goal" type="number" min="1" max="100000" step="1" inputmode="numeric"/></div><div><label for="walk-stride">歩幅（cm）</label><input id="walk-stride" type="number" min="30" max="150" step="1" inputmode="numeric"/></div></div>
    <progress id="walk-step-progress" max="6000" value="0" aria-label="歩数目標の進捗"></progress><p id="walk-step-progress-text" class="walk-help"></p>
    <p id="walk-step-status" class="walk-help" role="status" aria-live="polite"></p>
    <details class="walk-sensor-help"><summary>計測について</summary><p>開始時に動作センサーの許可を求める場合があります。加速度は端末内で処理し、保存・送信しません。歩数・距離・時間などの記録はこのブラウザに保存します。</p><p>センサーを利用できない場合は、有効な移動距離と歩幅から歩数を推定します。歩幅の初期値は70cmです。変更は次の新しい散歩から反映します。目標は計測中も変更できます。</p><p>持ち方や振動によって誤差が生じます。画面を閉じる・ロックする際は一時停止し、未計測区間は補完しません。</p><a href="${new URL('../privacy.html',document.currentScript.src).href}" id="walk-step-privacy">プライバシーポリシー</a></details>`;
  metrics.after(settings);$('walk-step-goal').value=goal;$('walk-stride').value=strideCm;
  const stats=$('walk-month').closest('section');
  stats.innerHTML=`<div class="results-heading"><h3>散歩の記録</h3></div><div class="step-stat-filters"><label>表示<select id="walk-stat-period"><option value="day">日別</option><option value="week">週間</option><option value="month">月間</option></select></label><label>日付<input id="walk-stat-date" type="date"/></label></div><p id="walk-stat-summary" class="walk-help"></p><figure class="step-chart"><figcaption id="walk-chart-caption"></figcaption><svg id="walk-step-chart" viewBox="0 0 340 152" role="img" aria-labelledby="walk-chart-caption"></svg><p class="walk-help step-chart-legend"><span>計測</span><span>推定</span></p></figure><p id="walk-stat-missing" class="walk-help"></p><details><summary>歩数の内訳</summary><div class="step-table-scroll"><table class="step-data-table"><thead><tr><th scope="col">日時</th><th scope="col">計測</th><th scope="col">推定</th></tr></thead><tbody id="walk-stat-table"></tbody></table></div></details><ul id="walk-stat-records" class="place-list" aria-label="期間内の散歩記録"></ul><p class="walk-help">歩数は計測した日時、距離・時間・回数は散歩の開始日で集計します。保存済みの記録（予定を除く、ルートと合わせて最大40件）が対象です。</p>`;
  $('walk-stat-date').value=Core.dateKey(new Date());$('walk-stat-period').value='week';
  const nf=n=>n.toLocaleString('ja-JP'),clock=n=>`${Math.floor(n/3600)?`${Math.floor(n/3600)}時間`:''}${Math.floor(n/60)%60}分${Math.floor(n)%60}秒`;
  function paint(){
    const data=counter?.data,total=counter?.total||0,target=data?.goal||goal;
    $('walk-steps').textContent=`${nf(total)} 歩`;
    $('walk-step-source').textContent=data?.estimatedSteps?data.sensorSteps?'一部推定':'推定':counter?.mode==='gps'?'推定':'';
    $('walk-step-progress').max=target;$('walk-step-progress').value=Math.min(total,target);
    $('walk-step-progress').setAttribute('aria-valuetext',`${nf(total)}歩 / ${nf(target)}歩`);
    $('walk-step-progress-text').textContent=`目標 ${nf(target)}歩 ／ ${Math.min(100,Math.floor(total/target*100))}%${total>=target?' ・達成':''}`;
    $('walk-step-status').textContent=counter?.mode==='pending'?'動作センサーの利用を確認しています。':notice;
  }
  function sync(){if(record&&counter){record.steps=counter.snapshot();WalkingSession.stepsChanged();}paint();}
  function detach(){if(listening)window.removeEventListener('devicemotion',motion);listening=false;clearInterval(watchdog);watchdog=null;detector.reset();}
  function fallback(text){detach();if(!counter||!record?.running)return;counter.setMode('gps',Date.now());notice=`${text} 有効な移動距離から歩数を推定します（歩幅${counter.data.strideCm}cm）。`;sync();}
  function motion(event){
    if(!record?.running||document.hidden||!counter||!['pending','sensor'].includes(counter.mode))return;
    const now=Date.now(),sample=detector.sample(event,now);
    if(!sample.valid)return;lastEvent=now;
    if(counter.mode==='pending'){counter.setMode('sensor',now);notice='歩数を計測中。歩行のリズムを確認してから反映します。';paint();}
    if(sample.steps&&counter.sensor(sample.steps,now))sync();
  }
  function start(recorder){
    detach();record=recorder;counter=new Core.Counter(recorder.steps||null,{goal,strideCm});counter.data.goal=goal;
    counter.setMode('pending',Date.now());notice='';sync();const token=++generation;
    const Motion=window.DeviceMotionEvent;
    if(window.isSecureContext===false||!Motion){fallback('この環境は動作センサーに対応していません。');return;}
    // requestPermission must be called synchronously within the Start/Resume gesture.
    let permission;try{permission=typeof Motion.requestPermission==='function'?Motion.requestPermission():Promise.resolve('granted');}
    catch{fallback('動作センサーを利用できません。');return;}
    Promise.resolve(permission).then(result=>{
      if(token!==generation||!record?.running||document.hidden)return;
      if(result!=='granted'){fallback('動作センサーの利用が許可されていません。');return;}
      lastEvent=Date.now();listening=true;window.addEventListener('devicemotion',motion,{passive:true});
      watchdog=setInterval(()=>{if(Date.now()-lastEvent>2500)fallback('動作センサーのデータを受信できません。');},500);
    },()=>{if(token===generation&&record?.running)fallback('動作センサーを利用できません。');});
  }
  function pause(){generation++;detach();if(counter){counter.setMode('paused',Date.now());notice='一時停止中';sync();}}
  function reset(){generation++;detach();record=null;counter=null;notice='';paint();history();}
  function gps(distance,from,to){if(counter?.gps(distance,from,to,Date.now()))sync();}
  function saveSettings(){
    const g=Number($('walk-step-goal').value),s=Number($('walk-stride').value);
    if(!Number.isInteger(g)||g<1||g>100000||!Number.isInteger(s)||s<30||s>150){notice='目標は1〜100,000歩、歩幅は30〜150cmの整数で入力してください。';paint();return;}
    goal=g;strideCm=s;if(counter){counter.data.goal=goal;sync();}else paint();
    try{localStorage.setItem(prefKey,JSON.stringify({version:1,goal,strideCm}));}
    catch{notice='歩数の設定を保存できません。空き容量やブラウザの設定を確認してください。';paint();}
  }
  $('walk-step-goal').addEventListener('change',saveSettings);$('walk-stride').addEventListener('change',saveSettings);
  const ns='http://www.w3.org/2000/svg';
  function svg(tag,attrs){const el=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);return el;}
  function history(){
    let result;try{result=Core.statistics(WalkingSession.records,$('walk-stat-period').value,$('walk-stat-date').value);}catch{return;}
    const total=result.sensorSteps+result.estimatedSteps;
    $('walk-stat-summary').textContent=`${result.count}回 ／ ${nf(total)}歩${result.estimatedSteps?`（推定 ${nf(result.estimatedSteps)}歩を含む）`:''} ／ ${routeDistance(result.distanceMeters)} ／ ${clock(result.durationSeconds)}`;
    $('walk-chart-caption').textContent=`${result.start}${result.end!==result.start?`〜${result.end}`:''}の歩数`;
    $('walk-stat-missing').textContent=result.missingSteps?`歩数未記録の散歩が${result.missingSteps}件あります。`:!result.count&&!total?'この期間の記録はありません。':'';
    const chart=$('walk-step-chart');chart.replaceChildren();const max=Math.max(1,...result.bars.map(b=>b.sensorSteps+b.estimatedSteps)),width=310/result.bars.length;
    const maxText=svg('text',{x:6,y:12,class:'step-chart-label'});maxText.textContent=`最大 ${nf(max===1&&!total?0:max)}歩`;chart.append(maxText,svg('line',{x1:16,x2:326,y1:126,y2:126,class:'step-chart-axis'}));
    $('walk-stat-table').replaceChildren();
    result.bars.forEach((bar,i)=>{
      const x=17+i*width,h=bar.sensorSteps/max*100,e=bar.estimatedSteps/max*100;
      const group=svg('g',{}),title=svg('title',{});title.textContent=`${bar.label}: ${nf(bar.sensorSteps)}歩 / 推定${nf(bar.estimatedSteps)}歩`;group.append(title);
      if(h)group.append(svg('rect',{x,y:126-h,width:Math.max(1,width-2),height:h,class:'step-chart-measured'}));
      if(e)group.append(svg('rect',{x,y:126-h-e,width:Math.max(1,width-2),height:e,class:'step-chart-estimated'}));
      if(i===0||i===result.bars.length-1||i%(result.bars.length>12?6:1)===0){const label=svg('text',{x:x+width/2,y:144,'text-anchor':'middle',class:'step-chart-label'});label.textContent=bar.label;group.append(label);}chart.append(group);
      const row=document.createElement('tr');for(const text of [bar.label,nf(bar.sensorSteps),nf(bar.estimatedSteps)])row.append(textElement('td',text));$('walk-stat-table').append(row);
    });
    $('walk-stat-records').replaceChildren();
    for(const r of result.rows){const li=textElement('li','','walk-history-card'),s=r.steps;
      li.append(textElement('strong',r.name),textElement('p',`${new Date(r.date).toLocaleString('ja-JP')} ／ ${s?`${nf(s.sensorSteps+s.estimatedSteps)}歩${s.estimatedSteps?`（推定 ${nf(s.estimatedSteps)}歩）`:''}`:'歩数未記録'}`,'walk-help'),textElement('p',`${routeDistance(r.distanceMeters)} ／ ${clock(r.durationSeconds)}`));$('walk-stat-records').append(li);
    }
  }
  $('walk-stat-period').addEventListener('change',history);$('walk-stat-date').addEventListener('change',history);
  if(WalkingSession.recorder){record=WalkingSession.recorder;counter=new Core.Counter(record.steps||null,{goal,strideCm});notice='途中の計測があります。「再開」で続けられます。';}
  paint();history();
  return {start,pause,reset,gps,history,get counter(){return counter;}};
})();
