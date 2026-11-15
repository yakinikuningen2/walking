const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('./static/js/candidate-distances.js');
const start={lat:35.68,lng:139.76},end={lat:35.69,lng:139.77};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('road metrics use provider values, deduplicate requests and cache no geometry',async()=>{
  let calls=0,release;
  const service=create({route:async()=>{calls++;await new Promise(r=>release=r);return {distance:2345,duration:2100,points:[[0,0],[1,1]]};}});
  const a=service.get(start,end,4),b=service.get(start,end,4);release();
  assert.deepEqual(await a,{distance:2345,duration:2100});assert.deepEqual(await b,await a);
  assert.deepEqual(await service.get(start,end,4),await a);assert.equal(calls,1);
});

test('changed start, destination and speed cannot reuse old distances; cache is bounded and expires',async()=>{
  let calls=0;
  const service=create({route:async()=>({distance:++calls,duration:60}),limit:2,ttl:10});
  await service.get(start,end,4);await service.get(start,end,5);await service.get({...start,lat:35.67},end,4);
  await service.get(start,end,4);assert.equal(calls,4);
  await service.get(start,{...end,lng:139.78},4);assert.equal(calls,5);
  await new Promise(r=>setTimeout(r,15));await service.get(start,{...end,lng:139.78},4);assert.equal(calls,6);
});

test('only one request runs at a time and cancelled queued cards never call the API',async()=>{
  let release,calls=0;
  const service=create({route:async()=>{calls++;await new Promise(r=>release=r);return {distance:700,duration:500};}});
  const a=service.get(start,end,4),abort=new AbortController();
  const b=service.get(start,{...end,lat:35.7},4,abort.signal);assert.equal(calls,1);
  abort.abort();await assert.rejects(b,{name:'AbortError'});release();await a;await tick();assert.equal(calls,1);
});

test('cancelling one subscriber keeps another alive, while late cancelled responses never enter cache',async()=>{
  let release,calls=0;
  const service=create({route:async()=>{calls++;await new Promise(r=>release=r);return {distance:700,duration:500};}});
  const first=new AbortController(),a=service.get(start,end,4,first.signal),b=service.get(start,end,4);
  first.abort();await assert.rejects(a,{name:'AbortError'});release();await b;assert.equal(calls,1);
  const stop=new AbortController(),late=service.get(start,end,5,stop.signal),oldRelease=release;
  stop.abort();await assert.rejects(late,{name:'AbortError'});await tick();oldRelease();await tick();
  const fresh=service.get(start,end,5);assert.equal(calls,3);release();await fresh;
});

test('API errors, invalid metrics and noncooperative timeouts are never represented by estimated distances',async()=>{
  for(const route of [async()=>{throw Error('offline')},async()=>({distance:NaN,duration:50}),async()=>({distance:50,duration:-1}),()=>new Promise(()=>{})]){
    let calls=0;const service=create({timeout:15,route:(...args)=>{calls++;return route(...args)}});
    await assert.rejects(service.get(start,end,4));await assert.rejects(service.get(start,end,4));assert.equal(calls,2);
  }
});

test('blue route stays on top after incremental alternatives and removal',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(`${__dirname}/static/js/app.js`,'utf8');
  const stack=[],choices=new Map([['standard',{route:{points:[]}}]]),layers=new Map();
  const context=vm.createContext({routeChoices:choices,routeLayers:layers,activeRouteKind:'standard',routeLayer:null,
    ROUTE_KINDS:[{id:'standard',color:'blue'},{id:'nature',color:'green'}],
    map:{getPane:()=>({style:{}})},L:{polyline:(points,options)=>({addTo(){stack.push(options.color);return this},bringToFront(){stack.splice(stack.indexOf(options.color),1);stack.push(options.color)},remove(){stack.splice(stack.indexOf(options.color),1)}})}});
  vm.runInContext(source.slice(source.indexOf('function syncRouteLayers('),source.indexOf('function renderRouteChoices(')),context);
  context.syncRouteLayers();choices.set('nature',{route:{points:[]}});context.syncRouteLayers();assert.deepEqual(stack,['green','blue']);
  context.activeRouteKind='nature';context.syncRouteLayers();assert.equal(stack.at(-1),'blue');
  choices.delete('nature');context.syncRouteLayers();assert.deepEqual(stack,['blue']);
});
