const assert=require('node:assert/strict'),{test}=require('node:test'),{readFileSync}=require('node:fs'),{join}=require('node:path'),vm=require('node:vm');
const source=readFileSync(join(__dirname,'static/js/app.js'),'utf8');
function clock(minHours=0,minMinutes=0,hours=1,minutes=0){
 const ui={};for(const prefix of ['discovery','random'])for(const [key,value]of Object.entries({'min-hours':minHours,'min-minutes':minMinutes,hours,minutes}))ui[`${prefix}-${key}`]={valueAsNumber:value};
 const c=vm.createContext({ui});vm.runInContext(source.slice(source.indexOf('function discoveryTimeWindow('),source.indexOf('function updateDiscoveryTimeRange(')),c);return c;
}
test('both search modes initially use 00:00 as lower bound and the entered maximum without padding',()=>{
 const c=clock();for(const random of [false,true])assert.deepEqual(JSON.parse(JSON.stringify(c.discoveryTimeWindow(random))),{minMinutes:0,minutes:60});
 for(const file of ['index.html','templates/index.html']){
  const html=readFileSync(join(__dirname,file),'utf8');
  for(const prefix of ['discovery','random'])for(const suffix of ['hours','minutes'])assert.match(html,new RegExp(`id="${prefix}-min-${suffix}"[^>]*value="00"`));
 }
});
test('arbitrary lower/upper hours and minutes, zero lower, equal bounds and long durations are accepted',()=>{
 for(const [a,b,x,y]of [[0,45,2,0],[6,0,6,30],[0,0,0,5],[1,0,1,0],[24,0,100,30]]){
  const c=clock(a,b,x,y);assert.equal(c.discoveryTimeWindow().minMinutes,a*60+b);assert.equal(c.discoveryTimeWindow().minutes,x*60+y);
 }
});
test('reversed, fractional, negative, blank, invalid minute and too-short maximum values are rejected',()=>{
 for(const args of [[2,0,1,0],[-1,0,1,0],[0,-1,1,0],[0,60,1,0],[0,0,0,4],[0,0,1,60],[0,0,1.5,0],[NaN,0,1,0],[0,0,NaN,30],[0,0,Number.MAX_SAFE_INTEGER,0]])assert.equal(clock(...args).discoveryTimeWindow(),null,String(args));
});
function history(entry){
 const c=vm.createContext({localStorage:{getItem:()=>JSON.stringify({version:1,searches:[entry]})},DISCOVERY_HISTORY_KEY:'history',DISCOVERY_HISTORY_LIMIT:12,DISCOVERY_RESULT_LIMIT:250,
  DISCOVERY_KINDS:{park:{tags:{leisure:['park']}}},DISCOVERY_DIRECTIONS:{any:{}},validCoordinates:()=>true,validWalkingSpeed:()=>true,validDiscoveryElevation:Number.isFinite});
 vm.runInContext(source.slice(source.indexOf('function loadDiscoveryHistory('),source.indexOf('function rememberDiscoverySearch(')),c);return c.loadDiscoveryHistory();
}
const entry={id:'saved',at:1763827200000,start:{lat:35,lng:139},criteria:{kind:'park',ambience:'any',direction:'any',keyword:'',speed:4,minMinutes:45,minutes:120},elapsedSeconds:1,
 places:[{key:'p',name:'公園',address:'',ambienceNote:'',lat:35,lng:139,kindId:'park',duration:6000,distance:6000,preferenceScore:0}]};
test('new freely chosen ranges and historical ±30-minute ranges retain version-one compatibility',()=>{
 assert.equal(history(entry).length,1);assert.equal(history({...entry,criteria:{...entry.criteria,minMinutes:360,minutes:420}}).length,1);
 assert.equal(history({...entry,criteria:{...entry.criteria,minMinutes:0,minutes:5}}).length,1);
 for(const [minMinutes,minutes]of [[121,120],[-1,120],[0,4],[NaN,120],[1.2,60]])assert.equal(history({...entry,criteria:{...entry.criteria,minMinutes,minutes}}).length,0);
});


test('clock formatting retains leading zeroes and durations beyond 24 hours',()=>{
 const c=vm.createContext({});vm.runInContext(source.slice(source.indexOf('function discoveryClockValue('),source.indexOf('function loadDiscoveryHistory(')),c);
 for(const [minutes,text]of [[0,'00:00'],[5,'00:05'],[60,'01:00'],[390,'06:30'],[1530,'25:30'],[6030,'100:30']])assert.equal(c.discoveryClockValue(minutes),text);
});
