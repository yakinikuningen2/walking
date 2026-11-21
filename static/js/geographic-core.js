// Rule-based geographic intent. No generated facilities, coordinates or claimed views.
(function(root) {
  'use strict';
  const LIMITS = { radius: 8000, mountainRadius: 30000, features: 48, accessFeatures: 12, centers: 16, results: 16,
    timeoutMs: 26000, mapTimeoutMs: 6500, cache: 24, ttl: 300000 };
  const normalized = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const point = p => p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 85 && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180;
  function parse(value) {
    const query = normalized(value);
    if (!query || query.length > 180) return null;
    const forms = [
      ['foothill', /^(.+?)(?:の)?(?:ふもと|麓|山麓)(?:で|にある|に行きたい|を歩きたい|の場所|の公園|の散歩先)?$/],
      ['mountain', /^(.+?山)(?:の)?(?:周辺|近く)(?:で|を歩きたい|の場所|の散歩先)?$/],
      ['river', /^(.*?)(?:川沿い|川辺|河川敷)(?:を歩きたい|を散歩したい|を散歩|で散歩|の場所|の散歩先)?$/],
      ['sea', /^(.*?)(?:海が見える|海の近く|海辺|海沿い)(?:場所|を歩きたい|を散歩したい|で散歩|の散歩先)?$/],
      ['forest', /^(.*?)(?:森の中|森の近く|林の中)(?:を歩きたい|を散歩したい|の場所|の散歩先)?$/],
      ['mountain', /^(.*?)(?:山の周辺)(?:を歩きたい|を散歩したい|の場所|の散歩先)?$/]
    ];
    for (const [kind, pattern] of forms) {
      const match = query.match(pattern); if (!match) continue;
      let region = match[1].replace(/(?:周辺の|付近の|の|で)$/, '').trim();
      if (kind === 'river' && region && !/(?:の|で)$/.test(match[1]) && query.includes('川沿い')) region += '川';
      return { query, kind, region, wantsView: kind === 'sea' && query.includes('見える') };
    }
    return null;
  }
  function meters(a,b) {
    const r=Math.PI/180, s=Math.sin((b.lat-a.lat)*r/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin((b.lng-a.lng)*r/2)**2;
    return 12742000*Math.asin(Math.sqrt(Math.min(1,s)));
  }
  const osmType = value => ({N:'node',W:'way',R:'relation',node:'node',way:'way',relation:'relation'})[value];
  function photon(data) {
    if (!Array.isArray(data?.features)) throw Error('Invalid geographic search response');
    return data.features.flatMap(f => {
      const p=f.properties || {}, xy=f.geometry?.coordinates, type=osmType(p.osm_type), id=Number(p.osm_id);
      if (!Array.isArray(xy) || !point({lat:xy[1],lng:xy[0]}) || !type || !Number.isSafeInteger(id) || id<=0) return [];
      const tags={...p.extra, ...(p.osm_key ? {[p.osm_key]:p.osm_value} : {}), ...(p.name ? {name:p.name} : {})};
      for (const [key, val] of Object.entries({province:p.state,city:p.city,suburb:p.district,street:p.street})) if(val) tags[`addr:${key}`]=val;
      return [{type,id,tags,lat:type==='node'?xy[1]:undefined,lon:type==='node'?xy[0]:undefined,
        center:{lat:xy[1],lon:xy[0]},extent:p.extent,photonOnly:true}];
    });
  }
  const location = e => {
    const p={lat:e?.lat ?? e?.center?.lat,lng:e?.lon ?? e?.center?.lon};if(point(p))return p;
    // Overpass `out geom` does not include `center`. A mapped vertex is used
    // only to scope/rank the feature; it remains informational until road access is resolved.
    const vertex=(e?.geometry || e?.members?.flatMap(m=>m.geometry||[]) || []).find(q=>point({lat:q?.lat,lng:q?.lon}));
    return vertex?{lat:vertex.lat,lng:vertex.lon}:null;
  };
  const title = e => normalized(e?.tags?.['name:ja'] || e?.tags?.name);
  function regions(elements,intent) {
    const result=[], term=normalized(intent.region).replace(/\s/g,'');
    for (const e of elements) {
      const p=location(e), t=e.tags||{}, name=title(e);
      if (!p || !name || !name.replace(/\s/g,'').includes(term)) continue;
      if (['foothill','mountain'].includes(intent.kind) && !['peak','volcano','mountain_range'].includes(t.natural)) continue;
      if (t.railway || t.shop || t.amenity || t.highway || t.building) continue;
      if (result.some(other=>meters(other,p)<1500)) continue;
      const extent=Array.isArray(e.extent)&&e.extent.length===4&&e.extent.every(Number.isFinite)?e.extent:null;
      const broad=extent && meters({lat:extent[1],lng:extent[0]},{lat:extent[3],lng:extent[2]})>60000;
      result.push({...p,name,tags:t,type:e.type,id:e.id,extent,broad:!!broad,
        address:[t['addr:province'],t['addr:city']].filter(Boolean).join('、')});
    }
    return result.slice(0,6);
  }
  function scope(intent,region) {
    if (!point(region)) throw Error('Missing geographic region');
    return {...region,lat:Math.round(region.lat*1000)/1000,lng:Math.round(region.lng*1000)/1000,
      radius:['foothill','mountain'].includes(intent.kind)?LIMITS.mountainRadius:LIMITS.radius};
  }
  function tagsFor(intent) {
    return {river:['waterway:river','waterway:stream'],sea:['natural:beach','natural:coastline','leisure:marina'],
      forest:['natural:wood','landuse:forest'],foothill:['leisure:park','leisure:garden','natural:water','tourism:attraction','tourism:viewpoint'],
      mountain:['leisure:park','leisure:garden','natural:water','tourism:attraction','tourism:viewpoint']}[intent.kind] || [];
  }
  const denied='[access!~"^(no|private|permit|customers|members|military|restricted|forestry|agricultural|official|emergency|delivery)$"][foot!~"^(no|private|permit|customers|members|military|restricted|official|emergency|delivery)$"]';
  function featureQuery(intent,area) {
    if (!point(area) || !Number.isFinite(area.radius) || area.radius>LIMITS.mountainRadius || area.radius<=0) throw Error('Invalid geographic bounds');
    // Values come only from this allowlist; the input sentence never becomes Overpass QL.
    const tags=tagsFor(intent), perTag=Math.floor(LIMITS.features/tags.length);
    const clauses=tags.map((tag,index)=>{
      const [k,v]=tag.split(':'),limit=perTag+(index<LIMITS.features%tags.length?1:0);
      return `nwr(around:${area.radius},${area.lat},${area.lng})[${k}="${v}"]${denied};out body geom ${limit};`;
    });
    // A large count of viewpoints must not consume the parks/lakes allocation.
    return `[out:json][timeout:6][maxsize:8388608];${clauses.join('')}`;
  }
  function accessQuery(centers,bounds) {
    if (!Array.isArray(centers) || centers.length>LIMITS.centers || centers.some(p=>!point(p))) throw Error('Invalid access query');
    return '[out:json][timeout:6][maxsize:8388608];'+centers.map(p=>{
      const b=bounds(p,450);
      return `(way(${b})[highway~"^(footway|path|pedestrian|steps|track|residential|living_street|service|unclassified)$"];`
        +`node(${b})[entrance];node(${b})[barrier];nwr(${b})[access~"^(private|no|permit|customers|members|military|restricted|forestry|agricultural|official|emergency|delivery)$"];`
        +`nwr(${b})[foot~"^(private|no|permit|customers|members|military|restricted|official|emergency|delivery)$"];node(${b})[locked=yes];);out count;out body geom(${b}) 100;`;
    }).join('');
  }
  function kind(e) {
    const t=e?.tags || {};
    if (['wood'].includes(t.natural) || t.landuse==='forest') return 'forest';
    if (['river','stream','riverbank'].includes(t.waterway) || t.natural==='water') return 'waterside';
    if (['beach','coastline'].includes(t.natural) || t.harbour==='yes' || t.leisure==='marina') return 'coast';
    if (['park','garden','nature_reserve'].includes(t.leisure)) return 'park';
    if (['viewpoint','attraction'].includes(t.tourism)) return 'sightseeing';
    return '';
  }
  function accept(e,intent,area,allowed=()=>true) {
    const p=location(e), t=e?.tags||{}, k=kind(e);
    if(!['node','way','relation'].includes(e?.type) || !Number.isSafeInteger(e.id) || e.id<=0 || !p || !k || !allowed(t))return false;
    const gap=meters(p,area); if(gap>area.radius+250) return false;
    if(intent.kind==='river' && !['river','stream','riverbank'].includes(t.waterway)) return false;
    if(intent.kind==='sea' && (k!=='coast' || t.salt==='no' || t.freshwater==='yes' || ['lake','pond','reservoir'].includes(t.water)))return false;
    if(intent.kind==='forest' && k!=='forest')return false;
    if(['mountain','foothill'].includes(intent.kind)) {
      if(!['park','waterside','sightseeing'].includes(k) || gap<3000)return false;
      const height=Number(String(t.ele||'').replace(/\s*m$/,'')), summit=Number(area.tags?.ele);
      if(height>0 && summit>0 && height>summit*.55)return false;
      if(t.tourism==='viewpoint' && gap<10000 && !(height>0 && summit>0 && height<summit*.55))return false;
    }
    return true;
  }
  function relevance(intent,area,verified) {
    const prefix=area.name ? `${area.name}周辺` : '指定地点の周辺';
    const detail={river:'OSMに登録された河川沿い',sea:intent.wantsView?'浜辺・港の候補・海の眺望は未確認':'OSMに登録された浜辺・港の候補',forest:'OSMに登録された森林の周辺',
      foothill:'山麓を探す範囲の候補・標高帯は未確認',mountain:'山の周辺の散歩先候補'}[intent.kind];
    return `${prefix}・${detail}${verified?'・地図上の道を目的地に使用':'・徒歩アクセス未確認'}`;
  }
  // Distinguish unavailable access data from an empty geographic result; never turn a centre into a route endpoint.
  const unresolved = p => p?.geographicSearch===true && p?.geoAccess!==true;
  const api={LIMITS,parse,normalized,point,meters,photon,location,title,regions,scope,tagsFor,featureQuery,accessQuery,kind,accept,relevance,unresolved};
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.GeographicCore=api;
})(globalThis);
