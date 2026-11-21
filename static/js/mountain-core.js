// Mountain identity, real OSM access points and conservative routing policy.
// No I/O: coordinates of summits are never replaced by access-point coordinates.
((root) => {
  "use strict";
  const LIMITS={radius:15000,elements:160,results:30,timeoutMs:16000,cache:24,ttl:300000};
  const LABELS={summit:"山・山頂",trailhead:"登山口",fifth:"五合目"};
  const SAFETY="徒歩経路が表示されても、登山の安全性は保証されません。通行規制・開山期間・天候は別途確認してください。";
  const point=p=>!!p&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180;
  const normalize=s=>typeof s==="string"?s.normalize('NFKC').replace(/\s+/g,'').toLowerCase():"";
  function meters(a,b){if(!point(a)||!point(b))return Infinity;const r=Math.PI/180,h=Math.sin((b.lat-a.lat)*r/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin((b.lng-a.lng)*r/2)**2;return 12742000*Math.asin(Math.sqrt(Math.min(1,h)));}
  function type(place,tags={}) {
    if(!place)return "";
    if(Object.hasOwn(LABELS,place.mountainType))return place.mountainType;
    const kind={mountain:"summit",mountain_trailhead:"trailhead",mountain_fifth:"fifth"}[place.kindId];
    if(kind)return kind;
    const t={...place.photoHints,...place.tags,...tags},name=normalize(t['name:ja']||t.name||place.name);
    if(['peak','volcano'].includes(t.natural)||['peak','volcano','mountain'].includes(place.facilityIdentity?.category))return 'summit';
    const facility=t.historic||t.shop||t.amenity&&!['bus_station','parking'].includes(t.amenity)||t.tourism&&['hotel','guest_house','alpine_hut','wilderness_hut'].includes(t.tourism);
    if(!facility&&/(?:五|5)合目|5th(?:station|stage)/i.test(name)&&(t.place||['trailhead','bus_stop'].includes(t.highway)||t.public_transport||t.railway==='station'))return 'fifth';
    if(t.highway==='trailhead'||t.information==='trailhead')return 'trailhead';
    if(!facility&&/登山口|trailhead/i.test(name)&&(t.highway||t.tourism==='information'||t.place||t.public_transport))return 'trailhead';
    return '';
  }
  function metadata(place,tags={}) {
    const kind=type(place,tags);return kind?{mountainType:kind,kindId:kind==='summit'?'mountain':`mountain_${kind}`,kindLabel:LABELS[kind],...((place.mountainRestricted===true||kind!=='summit'&&!allowed({...place.photoHints,...place.tags,...tags}))?{mountainRestricted:true}:{})}:{};
  }
  const decorate=(place,tags={})=>({...place,...metadata(place,tags)});
  const summit=place=>type(place)==='summit';
  const access=place=>['trailhead','fifth'].includes(type(place));
  const related=(...places)=>places.flat().some(p=>!!type(p));
  function allowed(t={}) {
    const denied=/^(no|private|permit|customers|members|military|agricultural|forestry|restricted|official|emergency|delivery|use_sidepath)$/;
    return !denied.test(t.access||'')&&!denied.test(t.foot||'')&&t.locked!=='yes'&&t.opening_hours!=='closed'
      &&!['yes','true'].includes(t.disused)&&!['yes','true'].includes(t.abandoned)&&!t.construction&&!t.proposed
      &&!t['access:conditional']&&!t['foot:conditional']&&!t.via_ferrata_scale&&!t.climbing
      &&(!t.sac_scale||t.sac_scale==='no')&&!t['disused:highway']&&!t['abandoned:highway'];
  }
  function query(origin) {
    if(!point(origin))throw Error('Invalid mountain coordinates');
    const area=`(around:${LIMITS.radius},${origin.lat.toFixed(6)},${origin.lng.toFixed(6)})`;
    return `[out:json][timeout:7];(nwr${area}[highway=trailhead];nwr${area}[information=trailhead];nwr${area}[name~"登山口|五合目|5合目|５合目|5th[ _-]*(station|stage)",i];);out center tags ${LIMITS.elements+1};`;
  }
  function parse(elements,origin) {
    if(!point(origin)||!Array.isArray(elements))throw Error('Invalid mountain access response');
    const candidates=[],seen=new Set();
    for(const e of elements.slice(0,LIMITS.elements)){
      if(!e||!['node','way','relation'].includes(e.type)||!Number.isSafeInteger(e.id)||e.id<=0||!allowed(e.tags))continue;
      const t=e.tags||{},p={lat:e.lat??e.center?.lat,lng:e.lon??e.center?.lon};
      if(!point(p)||meters(p,origin)>LIMITS.radius)continue;
      const name=t['name:ja']||t.name||'',kind=type({name},t);if(!['trailhead','fifth'].includes(kind))continue;
      const id=`${e.type}/${e.id}`;if(seen.has(id))continue;seen.add(id);
      const named=typeof name==='string'&&name.trim(),label=named?name.trim().slice(0,120):'名前のない登山口';
      if(candidates.some(other=>normalize(other.name)===normalize(label)&&meters(other,p)<60))continue;
      candidates.push({...p,name:label,address:typeof t['addr:full']==='string'?t['addr:full'].slice(0,300):'',
        ...metadata({mountainType:kind}),key:`osm:${id}`,osmType:e.type,osmId:e.id,sourceUrl:`https://www.openstreetmap.org/${id}`,
        mountainOrigin:{name:String(origin.name||'山').slice(0,120),lat:origin.lat,lng:origin.lng},mountainDistance:meters(origin,p),
        photoHints:Object.fromEntries(Object.entries(t).filter(([k,v])=>['wikidata','wikipedia','wikimedia_commons','image','name:en','alt_name'].includes(k)&&typeof v==='string'&&v.length<=1000))});
    }
    candidates.sort((a,b)=>a.mountainDistance-b.mountainDistance);
    return {places:candidates.slice(0,LIMITS.results),limited:elements.length>LIMITS.elements||candidates.length>LIMITS.results};
  }
  function photonElements(data) {
    if(!data||!Array.isArray(data.features)||data.error)throw Error('Invalid mountain search response');
    return data.features.flatMap(f=>{
      const p=f?.properties||{},coordinates=f?.geometry?.coordinates,type=({N:'node',W:'way',R:'relation'})[p.osm_type]||p.osm_type;
      if(!Array.isArray(coordinates)||!point({lat:coordinates[1],lng:coordinates[0]})||!['node','way','relation'].includes(type)||!Number.isSafeInteger(p.osm_id)||p.osm_id<=0)return [];
      return [{type,id:p.osm_id,lat:coordinates[1],lon:coordinates[0],tags:{...p.extra,...(typeof p.osm_key==='string'?{[p.osm_key]:p.osm_value}:{}),name:typeof p.name==='string'?p.name:''}}];
    });
  }
  function error(code,message){return Object.assign(new Error(message),{routeCode:code,userMessage:message});}
  function guard(start,end,via=[]) {
    if([start,end,...(Array.isArray(via)?via:[via])].some(summit))throw error('MOUNTAIN_SUMMIT','山頂は地点情報のみ表示します。徒歩で向かう登山口・五合目を選んでください。');
    if([start,end,...(Array.isArray(via)?via:[via])].some(p=>access(p)&&p.mountainRestricted===true))throw error('MOUNTAIN_ACCESS_RESTRICTED','通行制限のある登山口・五合目のため、徒歩ルートを案内できません。');
  }
  function routeError(cause,place) {
    if(['MOUNTAIN_SUMMIT','MOUNTAIN_ACCESS_RESTRICTED'].includes(cause?.routeCode))return cause;
    const label=LABELS[type(place)]||'登山口・五合目',code=String(cause?.routeCode||''),timeout=cause?.name==='AbortError'||/TIMEOUT|Timeout/.test(code);
    const busy=[429,502,503,504].includes(cause?.httpStatus),none=['NoRoute','NoSegment','170','171','172','442','ORS_NO_ROUTE'].includes(code);
    const text=timeout?`${label}までの徒歩ルートの検索がタイムアウトしました。`
      :busy?`${label}までの徒歩ルートを取得できませんでした。検索サービスに接続できません。`
      :none?`${label}まで散歩向けの条件で歩ける経路が見つかりませんでした。`
      :`${label}までの徒歩ルートを取得できませんでした。登山道の制限を維持した条件では案内できません。`;
    return Object.assign(error('MOUNTAIN_ROUTE',text),{cause});
  }
  const api={LIMITS,LABELS,SAFETY,type,metadata,decorate,summit,access,related,allowed,query,parse,photonElements,point,meters,guard,routeError};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.MountainCore=api;
})(globalThis);
