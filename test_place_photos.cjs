const {test}=require('node:test');
const assert=require('node:assert/strict');
const {hints,payload,createService,validPhoto}=require('./static/js/place-photos.js');
const point={name:'日比谷公園',lat:35.674,lng:139.756,photoHints:{wikidata:'Q123'}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const none={status:'none',photo:null};
const photo={thumbnail:'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Park.jpg/640px-Park.jpg',sourceUrl:'https://commons.wikimedia.org/wiki/File:Park.jpg',author:'A',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',title:'Park',displayNote:'表示枠に合わせてトリミング',nearby:false};

test('photo references survive index, OSM, photo payload, records and tour sanitization without private notes',()=>{
  assert.deepEqual(hints({type:'wikidata',id:'Q123'}),{wikidata:'Q123'});
  assert.deepEqual(hints({tags:{wikidata:'Q123',wikimedia_commons:'File:Park.jpg',note:'private'}}),{wikimedia_commons:'File:Park.jpg',wikidata:'Q123'});
  assert.deepEqual(payload({...point,note:'private',date:'2026-11-15'}),{name:point.name,lat:point.lat,lng:point.lng,hints:{wikidata:'Q123'}});
  assert.deepEqual(payload({...payload(point)}).hints,{wikidata:'Q123'});
  const core=require('./static/js/tour-core.js');
  const result=core.candidates([{...point,photoHints:{wikidata:'Q123',note:'private'},key:'a'}],{lat:35.67,lng:139.75});
  assert.deepEqual(result[0].photoHints,{wikidata:'Q123'});
});

test('deduplication and caching are shared between cards and detail screens',async()=>{
  let calls=0,release;
  const service=createService({request:async()=>{calls++;await new Promise(r=>release=r);return none;}});
  const a=service.get(point),b=service.get(point);await tick();release();
  assert.deepEqual(await a,none);await b;assert.deepEqual(await service.get(point),none);assert.equal(calls,1);
});

test('only two requests run; cancelled queued or obsolete results never overwrite new places',async()=>{
  let calls=0;const releases=[];
  const service=createService({request:async()=>{calls++;await new Promise(r=>releases.push(r));return none;}});
  const a=service.get(point),b=service.get({...point,name:'別の公園'}),cancel=new AbortController();
  const c=service.get({...point,name:'第3の公園'},cancel.signal);await tick();assert.equal(calls,2);
  cancel.abort();await assert.rejects(c,{name:'AbortError'});releases.forEach(r=>r());await Promise.all([a,b]);await tick();assert.equal(calls,2);
});

test('cancelling one screen keeps another subscriber alive',async()=>{
  let release,calls=0;const service=createService({request:async()=>{calls++;await new Promise(r=>release=r);return none;}});
  const cancel=new AbortController(),a=service.get(point,cancel.signal),b=service.get(point);
  await tick();cancel.abort();await assert.rejects(a,{name:'AbortError'});release();assert.deepEqual(await b,none);assert.equal(calls,1);
});

test('failed requests are not cached as no photo and noncooperative API timeouts finish',async()=>{
  let calls=0;const service=createService({request:async()=>{calls++;throw Error('offline')}});
  await assert.rejects(service.get(point));await assert.rejects(service.get(point));assert.equal(calls,2);
  const slow=createService({request:()=>new Promise(()=>{}),timeout:15});
  await assert.rejects(slow.get(point),{name:'AbortError'});
});

test('cached metadata expires and cache size remains bounded',async()=>{
  let now=0,calls=0;const service=createService({limit:1,now:()=>now,request:async()=>{calls++;return none}});
  await service.get(point);await service.get(point);assert.equal(calls,1);
  now=600001;await service.get(point);assert.equal(calls,2);
  await service.get({...point,name:'別の公園'});await service.get(point);assert.equal(calls,4);
});

test('manual retry rechecks a cached missing photo and asks the server to refresh only on request',async()=>{
  const calls=[];const service=createService({request:async(data)=>{calls.push(data);return none}});
  await service.get(point);await service.get(point);assert.equal(calls.length,1);
  await service.get(point,undefined,{refresh:true});assert.equal(calls.length,2);assert.equal(calls[1].refresh,true);
  assert.equal(calls[0].refresh,undefined);await service.get(point);assert.equal(calls.length,2);
});

test('validated photo metadata survives a reload in the same tab but still expires and refreshes',async()=>{
  const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
  let now=0,calls=0;const request=async()=>{calls++;return {status:'found',photo}};
  const first=createService({request,storage,now:()=>now});await first.get(point);assert.equal(calls,1);
  const second=createService({request,storage,now:()=>now});assert.equal((await second.get(point)).photo.author,'A');assert.equal(calls,1);
  await second.get(point,undefined,{refresh:true});assert.equal(calls,2);
  now=86400001;await createService({request,storage,now:()=>now}).get(point);assert.equal(calls,3);
});

test('negative results, invalid metadata and unavailable storage never poison the persistent photo cache',async()=>{
  const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
  let calls=0;const request=async()=>{calls++;return none};
  await createService({request,storage}).get(point);await createService({request,storage}).get(point);assert.equal(calls,2);
  const bad={version:3,entries:[{key:JSON.stringify(payload(point)),until:Date.now()+10000,result:{status:'found',photo:{...photo,thumbnail:'https://evil.test/a.jpg'}}}]};
  values.set('walking.photo-metadata.v3',JSON.stringify(bad));await createService({request,storage}).get(point);assert.equal(calls,3);
  const broken={getItem(){throw Error('blocked')},setItem(){throw Error('quota')}};
  const service=createService({request,storage:broken});await service.get(point);await service.get(point);assert.equal(calls,4);
});

test('persistent metadata is bounded and does not save notes or walking records',async()=>{
  let saved;const storage={getItem:()=>null,setItem:(k,v)=>saved=JSON.parse(v)};
  const service=createService({request:async()=>({status:'found',photo}),storage,persistLimit:2});
  for(let i=0;i<3;i++)await service.get({...point,name:'Park '+i,note:'private note',walk:{distance:9}});
  assert.equal(saved.entries.length,2);assert.equal(JSON.stringify(saved).includes('private note'),false);
  assert.equal(JSON.stringify(saved).includes('"walk"'),false);
});

test('retry after an incomplete lookup can reuse server metadata while bypassing a destination cache',async()=>{
  const calls=[];
  const service=createService({request:async data=>{calls.push(data);if(calls.length===1)throw Object.assign(Error('timeout'),{photoCode:'PhotoTimeout'});return {status:'found',photo};}});
  await assert.rejects(service.get(point),{photoCode:'PhotoTimeout'});
  await service.get(point,undefined,{refresh:true,reuseMetadata:true});
  assert.equal(calls[1].refresh,true);assert.equal(calls[1].reuseMetadata,true);
  await service.get(point);assert.equal(calls.length,2);
  await service.get(point,undefined,{refresh:true});assert.equal(calls[2].refresh,true);assert.equal(calls[2].reuseMetadata,undefined);
});

test('only trusted thumbnail, source and attribution URLs are rendered',async()=>{
  assert.equal(validPhoto(photo),true);
  assert.equal(validPhoto({...photo,thumbnail:'https://evil.test/a.jpg'}),false);
  assert.equal(validPhoto({...photo,sourceUrl:'javascript:alert(1)'}),false);
  assert.equal(validPhoto({...photo,largeThumbnail:'https://evil.test/a.jpg'}),false);
  const service=createService({request:async()=>({status:'found',photo:{...photo,author:''}})});
  await assert.rejects(service.get(point));
});

test('official, short and English names plus address survive records and tours, without visit notes',()=>{
  const place={...point,address:'東京都、世田谷区、桜上水',kindId:'culture',tags:{official_name:'正式な名称',short_name:'略称','name:en':'English Name',alt_name:'別名;別の呼び名'}};
  const data=payload(place);
  assert.equal(data.address,place.address);assert.equal(data.kindId,'culture');
  assert.equal(data.hints['name:en'],'English Name');assert.equal(data.hints.short_name,'略称');
  const core=require('./static/js/tour-core.js');
  const entry=core.candidates([{...point,photoHints:data.hints}],{lat:35.67,lng:139.75})[0];
  assert.equal(entry.photoHints['name:en'],'English Name');
  assert.equal(payload({...data,note:'private'}).note,undefined);
});
