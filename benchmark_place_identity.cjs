// No requests unless --live is explicitly supplied. Does not modify app data.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {performance}=require('node:perf_hooks');
const I=require('./static/js/place-identity.js');
const vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'static/js/app.js'),'utf8');
const converter=vm.createContext({PlaceIdentity:{...I,dedupe:rows=>rows,searchResults:rows=>rows},PlacePhotos:require('./static/js/place-photos.js'),SEARCH_LIMIT:10000,
  validCoordinates:(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180,
  japaneseCountry:p=>p.countrycode?new Intl.DisplayNames(['ja'],{type:'region'}).of(p.countrycode.toUpperCase()):p.country||''});
vm.runInContext(app.slice(app.indexOf('const DISCOVERY_DISTANCE_FACTOR'),app.indexOf('const WALKING_SETTINGS_KEY')),converter);
vm.runInContext(app.slice(app.indexOf('function discoveryTagFilters('),app.indexOf('function discoverySurroundings(')),converter);
vm.runInContext(app.slice(app.indexOf('function photonPlaces('),app.indexOf('function createSearchContext(')),converter);
function fixture() {
  const rows=[];let entity=0;
  const add=(name,kindId,offset,extra={})=>{const p={name,kindId,lat:35+Math.floor(entity/25)*.02+offset/111195,lng:139+(entity%25)*.02,key:`record/${rows.length}`,...extra};rows.push({...p,expected:String(entity)});};
  for(let n=0;n<100;n++,entity++) {
    add(`第${n}中央公園`,'park',0);add(`第${n} 中央・公園`,'park',80);add(`Park ${n}`,'park',90,{photoHints:{official_name:`第${n}中央公園`}});
  }
  for(let n=0;n<50;n++){add('Example Coffee','cafe',0,{photoHints:{'brand:wikidata':'Q100'}});const p=rows.at(-1);entity++;add('Example Coffee','cafe',2,{lat:p.lat+2/111195,lng:p.lng});entity++;}
  for(let n=0;n<25;n++){add(`学園${n}`,'university',0);const p=rows.at(-1);entity++;add(`学園${n}`,'library',0,{lat:p.lat,lng:p.lng});entity++;}
  for(let n=0;n<25;n++){add(`庭園${n}`,'park',0);const p=rows.at(-1);entity++;add(`庭園${n}`,'cafe',1,{lat:p.lat+1/111195,lng:p.lng});entity++;}
  for(let n=0;n<25;n++,entity++){add(`第${n}中央文化歴史資料博物館`,'museum',0,{address:`東京都某市${n}-2`});add(`第${n}中央文化歴史資料博物舘`,'museum',5,{address:`東京都某市${n}-2`});}
  for(let n=0;n<25;n++,entity++){add(`神社${n}`,'shrine',0,{photoHints:{wikidata:`Q${n+1000}`}});add(`Shrine ${n}`,'shrine',70,{photoHints:{wikidata:`Q${n+1000}`}});}
  return rows;
}
function legacy(rows,mode) {
  const out=[];
  for(const p of rows){if(out.some(q=>mode==='name' ? q.name===p.name&&q.lat===p.lat&&q.lng===p.lng
    :mode==='tour' ? q.key===p.key || q.name===p.name&&I.meters(q,p)<80
      :(q.osmType&&q.osmId&&q.osmType===p.osmType&&q.osmId===p.osmId) || q.name.normalize('NFKC').replace(/\s/g,'').toLowerCase()===p.name.normalize('NFKC').replace(/\s/g,'').toLowerCase()&&I.meters(q,p)<30))continue;out.push(p);}
  return out;
}
function metrics(input,output) {
  // expected labels are synthetic ground truth; do not infer accuracy from live data.
  if(input.every(p=>p.expected!==undefined)) {
    const truth=new Set(input.map(p=>p.expected));let duplicates=0,missing=0;
    for(const e of truth){const n=output.filter(p=>p.expected===e).length;duplicates+=Math.max(0,n-1);if(!n)missing++;}
    return {input:input.length,results:output.length,duplicatesRemaining:duplicates,falseMergedFacilities:missing};
  }
  return {input:input.length,results:output.length,recordsCombined:input.length-output.length};
}
function timed(rows,run,repeats=15) {
  run(rows);const times=[];let output;
  for(let n=0;n<repeats;n++){const t=performance.now();output=run(rows);times.push(performance.now()-t);}
  times.sort((a,b)=>a-b);return {...metrics(rows,output),medianMs:Number(times[Math.floor(times.length/2)].toFixed(3))};
}
function fromPhoton(data) {
  return converter.photonPlaces(data);
}
async function live() {
  const rows=[],responses=[],snapshots=[];
  for(const q of ['井の頭恩賜公園','新宿御苑','明治神宮','秋津駅']) {
    const url=new URL('https://photon.komoot.io/api/');url.search=new URLSearchParams({q,limit:'40',lang:'default'});
    try{const r=await fetch(url,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error(String(r.status));const data=await r.json(),places=fromPhoton(data);snapshots.push({provider:'Photon',query:q,data});rows.push(...places);responses.push({provider:'Photon',query:q,records:places.length});}
    catch(e){responses.push({provider:'Photon',query:q,error:e.message});}
    await new Promise(r=>setTimeout(r,1000));
  }
  const query='[out:json][timeout:8];nwr[leisure=park](around:700,35.7009,139.5742);out center tags 80;';
  try {
    const r=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:new URLSearchParams({data:query}),signal:AbortSignal.timeout(14000)});
    if(!r.ok)throw Error(String(r.status));const data=await r.json();if(data.remark)throw Error(data.remark);
    snapshots.push({provider:'Overpass',query,data});
    const places=fromOverpass(data);
    rows.push(...places);responses.push({provider:'Overpass',query:'井の頭公園周辺700m・公園・最大80件',records:places.length});
  }catch(e){responses.push({provider:'Overpass',error:e.message});}
  // Raw responses remain outside the repository; only summary and source refs are reported.
  const file=path.join(os.tmpdir(),'walking-facility-dedup-live.json');fs.writeFileSync(file,JSON.stringify({responses,rows,snapshots},null,2));
  return summarizeLive(rows,responses,file);
}
function fromOverpass(data) {return (data.elements||[]).flatMap(e=>{const lat=e.lat??e.center?.lat,lng=e.lon??e.center?.lon;return Number.isFinite(lat)&&Number.isFinite(lng)?[I.attach({name:e.tags?.['name:ja']||e.tags?.name||'',lat,lng,kindId:'park',key:`${e.type}/${e.id}`},e)]:[];});}
function summarizeLive(input,responses,file){
  const local=[],configs=[['static/discovery-wikidata-jp-2026-11-13-v1/park.json','wikidata','park'],['static/discovery-geonames-jp-2026-11-13-v1/park.json','geonames','park'],['static/shrines-jp-2026-11-13-v1.json','wikidata','shrine']];
  for(const [name,source,kindId] of configs)for(const r of JSON.parse(fs.readFileSync(path.join(__dirname,name),'utf8')).places){
    const p={name:r[1],lat:r[2],lng:r[3],kindId,key:`${source}/${r[0]}`};
    if(!input.some(q=>I.meters(p,q)<1000))continue;
    const tags={name:p.name,...(source==='wikidata'?{wikidata:r[0]}:{}),...(kindId==='shrine'?{amenity:'place_of_worship',religion:'shinto'}:{leisure:'park'})};
    local.push(I.attach(p,{type:source,id:r[0],source:`bundled:${source}`,tags}));
  }
  const rows=[...input,...local];
  if(process.argv.includes('--inspect'))console.error(JSON.stringify(local.flatMap(p=>input.filter(q=>I.normalize(p.name)===I.normalize(q.name)&&I.meters(p,q)<500).map(q=>({name:p.name,meters:I.meters(p,q),decision:I.explain(p,q),local:I.identity(p),external:I.identity(q)}))),null,2));
  return {responses,localRecords:local.length,legacyName:timed(rows,r=>legacy(r,'name')),legacyConditions:timed(rows,r=>legacy(r,'conditions')),common:timed(rows,I.dedupe),
    merged:I.dedupe(rows).filter(p=>p.facilityIdentity.ids.length>1).map(p=>({name:p.name,ids:p.facilityIdentity.ids,lat:p.lat,lng:p.lng})),rawTemporaryFile:file};
}
(async()=>{
 const rows=fixture();const report={date:'2026-11-15',synthetic:{legacyName:timed(rows,r=>legacy(r,'name')),legacyConditions:timed(rows,r=>legacy(r,'conditions')),legacyTour:timed(rows,r=>legacy(r,'tour')),common:timed(rows,I.dedupe)}};
 const large=Array.from({length:1000},(_,n)=>({name:`Place ${n}`,kindId:'park',lat:35+(n%20)*.0001,lng:139+Math.floor(n/20)*.0001}));
 report.dense1000={legacyConditions:timed(large,r=>legacy(r,'conditions')),common:timed(large,I.dedupe)};
 if(process.argv.includes('--live'))report.live=await live();
 if(process.argv.includes('--replay')){const file=path.join(os.tmpdir(),'walking-facility-dedup-live.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
   report.live=summarizeLive(saved.snapshots.flatMap(s=>s.provider==='Photon'?fromPhoton(s.data):fromOverpass(s.data)),saved.responses,file);}
 if(process.argv.includes('--report'))fs.writeFileSync(path.join(__dirname,'benchmarks/facility-dedup-results.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
