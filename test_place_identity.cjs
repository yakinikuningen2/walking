const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const id=require('./static/js/place-identity.js');
const place=(name='中央公園',offset=0,extra={})=>({name,lat:35+offset/111195,lng:139,kindId:'park',...extra});
const attach=(p,tags={},type='node',number=1)=>id.attach(p,{type,id:number,tags});

test('names normalize Unicode widths, case, punctuation, spaces and brackets without stripping branch names',()=>{
  assert.equal(id.normalize(' ＡＢＣ・公園（東） '),id.normalize('abc 公園(東)'));
  assert.notEqual(id.normalize('店舗 東口店'),id.normalize('店舗 西口店'));
  assert.equal(id.dedupe([place('ＡＢＣ・公園',0),place('abc 公園',65)]).length,1);
});
test('declared official, short and English aliases identify a facility without hardcoded names',()=>{
  const a=attach(place('○○市立歴史博物館',0,{kindId:'culture'}),{tourism:'museum',short_name:'歴博', 'name:en':'Example History Museum'});
  const b=attach(place('歴博',40,{kindId:'culture'}),{tourism:'museum'},'way',2);
  assert.equal(id.dedupe([a,b,attach(place('Example History Museum',45,{kindId:'culture'}),{tourism:'museum'},'relation',3)]).length,1);
});
test('strong IDs join node, way, relation and bundled data while retaining aliases and image references',()=>{
  const a=attach(place('公園A',0,{key:'node/1',photoHints:{wikidata:'Q12'}}),{wikidata:'Q12',leisure:'park'});
  const b=attach(place('Park A',140,{key:'way/2',address:'東京都某市1-2',photoHints:{image:'File:Park A.jpg',wikimedia_commons:'Category:Park A'}}),{wikidata:'Q12',leisure:'park'},'way',2);
  const merged=id.dedupe([a,b])[0];assert.equal(id.dedupe([a,b]).length,1);
  assert.equal(merged.name,'Park A');assert.equal(merged.photoHints.wikidata,'Q12');assert.equal(merged.photoHints.image,'File:Park A.jpg');
  assert.deepEqual(merged.facilityIdentity.ids,['osm:node/1','osm:way/2']);assert.equal(merged.key,'node/1');
  assert.equal(merged.lat,a.lat,'node routing point is retained instead of polygon centre');
  assert.equal(id.dedupe([merged,a,b]).length,1,'idempotent across caches and streaming updates');
});
test('source identity includes OSM element type and does not confuse external numeric identifiers',()=>{
  const a=attach(place('A'),{leisure:'park'},'node',7),b=attach(place('B'),{leisure:'park'},'way',7);
  assert.equal(id.same(a,b),false);
  assert.equal(id.same(a,attach(place('Different spelling',20),{leisure:'park'},'node',7)),true);
  assert.equal(id.same(a,id.attach(place('Other'),{source:'mlit',type:'station',id:7,tags:{railway:'station'}})),false);
});
test('Wikipedia title normalization supports explicit identity and preserves language distinctions',()=>{
  const a=attach(place('A'),{leisure:'park',wikipedia:'ja:公園_A'});
  const b=attach(place('B',50),{leisure:'park','wikipedia:ja':'公園 A'},'way',3);
  assert.equal(id.explain(a,b),'wikipedia');
  assert.equal(id.same(a,attach(place('A'),{leisure:'park',wikipedia:'ja:公園B'},'node',4)),false);
});
test('nearby chain branches remain separate without a precise address, even when brand and brand Wikidata agree',()=>{
  const tags={shop:'convenience',brand:'Example', 'brand:wikidata':'Q99'};
  const a=attach(place('Example',0,{kindId:'convenience'}),tags);
  const b=attach(place('Example',4,{kindId:'convenience'}),tags,'way',2);
  assert.equal(id.dedupe([a,b]).length,2);
  const c=attach(place('Example 東店',0,{kindId:'convenience'}),tags);
  const d=attach(place('Example 西店',2,{kindId:'convenience'}),tags,'way',3);
  assert.equal(id.same(c,d),false);
  assert.equal(id.same(place('Example Coffee East 1',0,{kindId:'cafe',address:'某市1-2'}),place('Example Coffee East 2',1,{kindId:'cafe',address:'某市1-2'})),false);
});
test('same store records need a matching precise address or structural node/polygon evidence',()=>{
  const p=place('珈琲店',0,{kindId:'cafe',address:'東京都某市中央1-2'});
  assert.equal(id.same(attach(p,{amenity:'cafe'}),attach({...p,lat:p.lat+.0001},{amenity:'cafe'},'node',2)),true);
  assert.equal(id.same(attach(place('喫茶葵',0,{kindId:'cafe'}),{amenity:'cafe'}),attach(place('喫茶葵',3,{kindId:'cafe'}),{amenity:'cafe'},'way',2)),true);
});
test('university/library, park/cafe, station/mall and adjacent distinct facilities remain separate',()=>{
  for(const [left,right] of [[{amenity:'university'},{amenity:'library'}],[{leisure:'park'},{amenity:'cafe'}],[{railway:'station'},{shop:'mall'}]]) {
    const a=attach(place('同じ名称'),left),b=attach(place('同じ名称',0),right,'way',2);
    assert.equal(id.same(a,b),false);
  }
  assert.equal(id.same(place('東公園'),place('西公園',1)),false);
  assert.equal(id.same(attach(place('○○大学'),{amenity:'university'}),attach(place('○○大学附属図書館'),{amenity:'library'},'way',2)),false);
});
test('conflicting addresses or Wikidata IDs veto a name match; faraway same-name facilities never merge',()=>{
  assert.equal(id.same(place('中央公園',0,{address:'東京都某市1-2'}),place('中央公園',3,{address:'東京都某市1-3'})),false);
  assert.equal(id.same(attach(place(),{wikidata:'Q1'}),attach(place(),{wikidata:'Q2'},'way',2)),false);
  assert.equal(id.same(place(),place('中央公園',700)),false);
  assert.equal(id.same(attach(place(),{'addr:city':'市A'}),attach(place(),{'addr:city':'市B'},'way',2)),false);
});
test('category-dependent thresholds allow park centres but separate small facilities and opposite bus stops',()=>{
  assert.equal(id.same(place(),place('中央公園',180)),true);
  assert.equal(id.same(place('珈琲店',0,{kindId:'cafe'}),place('珈琲店',180,{kindId:'cafe'})),false);
  const a=attach(place('中央通り',0,{kindId:'bus_stop'}),{highway:'bus_stop',local_ref:'1'});
  assert.equal(id.same(a,attach(place('中央通り',2,{kindId:'bus_stop'}),{highway:'bus_stop',local_ref:'2'},'node',2)),false);
  assert.equal(id.same(a,attach(place('中央通り',18,{kindId:'bus_stop'}),{highway:'bus_stop'},'node',3)),false);
});
test('similar names require precise matching address; a similar name and proximity alone are insufficient',()=>{
  const a=place('中央文化歴史資料博物館'),b=place('中央文化歴史資料博物舘',5);
  assert.equal(id.same(a,b),false);
  const address='東京都某市1-2';assert.equal(id.same({...a,address},{...b,address}),true);
});
test('a transitive alias or coordinate bridge cannot absorb conflicting distinct facilities',()=>{
  const a=place('中央公園',0),b=place('中央公園',200),c=place('中央公園',400);
  assert.equal(id.dedupe([a,b,c]).length,2);
  const first=attach(place('A'),{wikidata:'Q1',alt_name:'B'}),middle=place('B'),last=attach(place('B'),{wikidata:'Q2'});
  assert.equal(id.dedupe([first,middle,last]).length,2);
});
test('routing coordinates prefer mapped pedestrian access and keep corresponding metrics together',()=>{
  const a=place('森',0,{kindId:'forest',key:'original',distance:900,duration:800,accessStatus:'unknown',accessAnchor:{type:'way',id:1},photoHints:{wikidata:'Q10'}});
  const b=place('森',40,{kindId:'forest',distance:950,duration:850,accessStatus:'mapped',accessAnchor:{type:'way',id:2},photoHints:{wikidata:'Q10'}});
  const out=id.dedupe([a,b])[0];assert.equal(out.lat,b.lat);assert.equal(out.distance,950);assert.equal(out.duration,850);assert.equal(out.accessAnchor.id,2);assert.equal(out.key,'original');
});
test('unknown anonymous places and distinct named nature do not merge solely because they share coordinates or an access path',()=>{
  const a=id.attach(place('森',0,{kindId:'forest'}),{type:'way',id:1,naturalAccess:{unnamed:true,anchorType:'way',anchorId:10},tags:{}});
  const b=id.attach(place('森',0,{kindId:'forest'}),{type:'way',id:2,naturalAccess:{unnamed:true,anchorType:'way',anchorId:11},tags:{}});
  assert.equal(id.same(a,b),false);
  assert.equal(id.same(place('第一の森',0,{kindId:'forest',accessAnchor:{type:'way',id:10}}),place('第二の森',0,{kindId:'forest',accessAnchor:{type:'way',id:10}})),false);
});
test('merged metadata survives tour cleanup and rebuild rejects a second record of an existing waypoint',async()=>{
  const core=require('./static/js/tour-core.js'),origin={lat:34.99,lng:139};
  const a=attach(place('Central park',0,{key:'one'}),{leisure:'park',wikidata:'Q100'}),b=attach(place('中央公園',30,{key:'two'}),{leisure:'park',wikidata:'Q100'},'way',2);
  const candidates=core.candidates([a,b],origin);assert.equal(candidates.length,1);assert.equal(candidates[0].facilityIdentity.wikidata[0],'Q100');
  const engine=core.createEngine({search:async()=>[a,b],route:async()=>{throw Error('must not route duplicates');}});
  const settings={minutes:60,speed:4,count:2,theme:'any',returnToStart:true};
  await assert.rejects(engine.generate(settings,origin),{code:'INSUFFICIENT'});
  await assert.rejects(engine.rebuild({settings,start:origin},[a,b]),{code:'INPUT'});
});
test('Photon conversion keeps OSM IDs, aliases and tags before common deduplication',()=>{
  const source=fs.readFileSync(`${__dirname}/static/js/app.js`,'utf8');
  const c=vm.createContext({PlaceIdentity:id,PlacePhotos:require('./static/js/place-photos.js'),SEARCH_LIMIT:50,DISCOVERY_KINDS:{park:{label:'公園',tags:{leisure:['park']}}},
    validCoordinates:(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng),japaneseCountry:()=>'',discoveryKindMatches:(t,k)=>t.leisure==='park'});
  vm.runInContext(source.slice(source.indexOf('function photonPlaces('),source.indexOf('function createSearchContext(')),c);
  const feature=(type,number,name,offset=0)=>({geometry:{type:'Point',coordinates:[139,35+offset/111195]},properties:{osm_type:type,osm_id:number,name,osm_key:'leisure',osm_value:'park',extra:{wikidata:'Q200'}}});
  const result=c.photonPlaces({features:[feature('N',1,'中央公園'),feature('W',2,'Central Park',80)]});
  assert.equal(result.length,1);assert.equal(result[0].facilityIdentity.ids.length,2);assert.equal(result[0].photoHints.wikidata,'Q200');
});
test('spatial cell borders and longitudes do not hide strong identity matches',()=>{
  const a=attach({...place(),lat:35.00999,lng:139.00999},{wikidata:'Q9'}),b=attach({...place(),lat:35.01001,lng:139.01001},{wikidata:'Q9'},'way',3);
  assert.equal(id.dedupe([a,b]).length,1);
  assert.equal(id.dedupe([null,{},place('invalid',0,{lat:NaN}),a]).length,1);
});
test('numeric address boundaries cannot collapse different buildings or shops in the same district',()=>{
  assert.equal(id.same(place('同名店',0,{kindId:'cafe',address:'東京都某市1-23'}),place('同名店',2,{kindId:'cafe',address:'東京都某市12-3'})),false);
  assert.equal(id.same(place('同名店',0,{kindId:'cafe',address:'東京都某市1丁目'}),place('同名店',2,{kindId:'cafe',address:'東京都某市1丁目'})),false);
  assert.equal(id.same(place('同名店',0,{kindId:'cafe',address:'東京都某市1丁目2番3号'}),place('同名店',2,{kindId:'cafe',address:'東京都某市1-2-3'})),true);
});
test('station suffix normalization is limited to stations and platform numbers are not aliases',()=>{
  assert.equal(id.same(place('中央',0,{kindId:'station'}),place('中央駅',50,{kindId:'station'})),true);
  const a=attach(place('丸ノ内線;中央;1番線'),{railway:'platform',name:'丸ノ内線;中央;1番線'});
  const b=attach(place('丸ノ内線;中央;2番線',2),{railway:'platform',name:'丸ノ内線;中央;2番線'},'way',2);
  assert.equal(id.same(a,b),false);
  assert.equal(id.same(attach(place('中央'),{railway:'stop'}),attach(place('中央',3),{railway:'stop'},'node',9)),false);
});
test('mapped large facility outlines permit in-bounds records beyond the default category distance, without absorbing an adjacent cafe',()=>{
  const a=id.attach(place('大きな公園'),{type:'way',id:1,tags:{leisure:'park'},bounds:{minlat:35,maxlat:35.005,minlon:139,maxlon:139.005}});
  const b=place('大きな公園',450);assert.equal(id.same(a,b),true);
  assert.equal(id.same(a,{...b,kindId:'cafe'}),false);
  assert.equal(id.same(a,place('大きな公園',600)),false);
});
test('repeated OSM classifications keep the known category available when matching a bundled record',()=>{
  const a=attach({...place('公園'),kindId:undefined},{},'way',1),b=attach(place('公園'),{leisure:'park'},'way',1);
  const c=id.attach(place('公園',260),{type:'wikidata',id:'Q30',source:'bundled:wikidata',tags:{leisure:'park',wikidata:'Q30'}});
  const out=id.dedupe([a,b,c]);assert.equal(out.length,1);assert.equal(out[0].facilityIdentity.ids.length,2);
});
test('an anonymous nature fragment cannot bridge two distinct named forests into one result',()=>{
  const withAccess=(name,number,unnamed)=>id.attach(place(name,0,{kindId:'forest'}),{type:'way',id:number,tags:{name},naturalAccess:{anchorType:'way',anchorId:10,unnamed}});
  assert.equal(id.dedupe([withAccess('森',1,true),withAccess('北の森',2,false),withAccess('南の森',3,false)]).length,2);
});
test('repeated provider responses retain useful tags even when a sparse later response omits them',()=>{
  const source=fs.readFileSync(`${__dirname}/static/js/app.js`,'utf8'),c=vm.createContext({Map});
  vm.runInContext(source.slice(source.indexOf('function mergeDiscoveryElements('),source.indexOf('function discoveryBounds(')),c);
  const out=c.mergeDiscoveryElements([{type:'node',id:1,tags:{name:'A',wikidata:'Q1',alt_name:'B'}}],[{type:'node',id:1,tags:{name:'A',wikidata:undefined,alt_name:''}}]);
  assert.equal(out.length,1);assert.equal(out[0].tags.wikidata,'Q1');assert.equal(out[0].tags.alt_name,'B');
});

test('station buildings and station nodes can use different adjacent streets without duplicating the facility',()=>{
  const a=id.attach(place('山麓駅',0,{kindId:'station',address:'某市甲通り'}),{type:'way',id:1,extent:[138.999,35.001,139.001,34.999],tags:{building:'train_station','addr:city':'某市','addr:street':'甲通り'}});
  const b=id.attach(place('山麓',25,{kindId:'station',address:'某市乙通り'}),{type:'node',id:2,tags:{railway:'station','addr:city':'某市','addr:street':'乙通り'}});
  assert.equal(id.dedupe([a,b]).length,1);
  const other=id.attach(place('山麓',25,{kindId:'station',address:'別市乙通り'}),{type:'node',id:3,tags:{railway:'station','addr:city':'別市','addr:street':'乙通り'}});
  assert.equal(id.same(a,other),false);
  assert.equal(id.same(a,{...b,lat:35.01}),false);
});

test('station boarding positions are suppressed only when the actual station is available',()=>{
  const station=attach(place('中央駅',0,{kindId:'station'}),{railway:'station'});
  const stop=attach(place('中央',10),{railway:'stop'},'node',2),platform=attach(place('中央',20),{railway:'platform'},'way',3);
  const bus=attach(place('中央駅',30,{kindId:'bus_stop'}),{highway:'bus_stop'},'node',4);
  const exit=attach(place('中央駅',5),{railway:'subway_entrance'},'node',5);
  assert.equal(id.searchResults([station,stop,platform,bus,exit]).length,3);
  assert.equal(id.searchResults([stop,platform]).length,2);
});

test('Takao actual OSM building/node records become one station, while its namesake bus stop stays labelled separately',()=>{
  // Small regression extract from Photon/OSM (ODbL): ways/180390778,
  // nodes/6003241794, 2204440499, 6003241793; full responses are not bundled.
  const source=fs.readFileSync(`${__dirname}/static/js/app.js`,'utf8');
  const c=vm.createContext({PlaceIdentity:id,PlacePhotos:require('./static/js/place-photos.js'),SEARCH_LIMIT:15,DISCOVERY_KINDS:{park:{label:'公園',tags:{leisure:['park']}}},
    validCoordinates:(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng),japaneseCountry:()=>'',discoveryKindMatches:t=>t.leisure==='park'});
  vm.runInContext(source.slice(source.indexOf('function photonPlaces('),source.indexOf('function createSearchContext(')),c);
  const f=(osm_type,osm_id,name,osm_key,osm_value,lng,lat,street,extra={})=>({geometry:{type:'Point',coordinates:[lng,lat]},properties:{osm_type,osm_id,name,osm_key,osm_value,street,city:'東京都',district:'八王子市',locality:'初沢町',postcode:'193-0844',...extra}});
  const result=c.photonPlaces({features:[
    f('W',180390778,'高尾山口駅','building','train_station',139.2699798,35.6322938,'甲州街道',{extent:[139.2697608,35.6325814,139.2701158,35.6320781]}),
    f('N',2204440499,'高尾山口駅','highway','bus_stop',139.2704364,35.6327894,'西氷川橋'),
    f('N',6003241794,'高尾山口','railway','station',139.2699078,35.6325002,'西氷川橋'),
    f('N',6003241793,'高尾山口','railway','stop',139.2700446,35.6325743,'西氷川橋')]});
  assert.equal(result.length,2);assert.equal(result.filter(p=>p.kindId==='station').length,1);
  const station=result.find(p=>p.kindId==='station');assert.equal(station.kindLabel,'駅');assert.equal(station.facilityIdentity.ids.length,2);
  assert.equal(result.find(p=>p.kindId==='bus_stop').kindLabel,'バス停');
});
