// Conservative, offline facility identity matching shared by all search paths.
((root) => {
  "use strict";
  const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\p{S}\s]/gu, "");
  // Keep numeric address boundaries: 1-23 and 12-3 are different buildings.
  const normalizeAddress = value => String(value || "").normalize("NFKC").toLowerCase().replace(/(\d+)(?:丁目|番地?|号)/g,"$1-")
    .replace(/[‐‑‒–—−]/g,"-").replace(/[\s、,，。]/g,"").replace(/-$/g,"");
  const text = value => typeof value === "string" ? value.trim().slice(0, 1000) : "";
  const unique = values => [...new Set(values.filter(Boolean))];
  const point = p => Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  function meters(a, b) {
    if (!point(a) || !point(b)) return Infinity;
    const r = Math.PI / 180, h = Math.sin((a.lat-b.lat)*r/2)**2 + Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin((a.lng-b.lng)*r/2)**2;
    return 12742000*Math.asin(Math.sqrt(Math.min(1,h)));
  }
  function category(p, tags) {
    if (tags.amenity === "place_of_worship") return tags.religion === "shinto" ? "shinto" : tags.religion === "buddhist" ? "buddhist" : "worship";
    if (tags.amenity) return ({toilets:"toilet",bus_station:"bus_stop"})[tags.amenity] || tags.amenity;
    if (tags.shop) return `shop:${tags.shop}`;
    if (tags.building === "train_station") return "station";
    if (["station","halt"].includes(tags.railway)) return "station";
    if (tags.railway) return `railway:${tags.railway}`;
    if (tags.highway === "bus_stop" || tags.public_transport === "platform") return "bus_stop";
    if (tags.leisure) return ["park","garden","nature_reserve"].includes(tags.leisure) ? "park" : tags.leisure;
    if (tags.tourism) return tags.tourism;
    return ({convenience:"shop:convenience",forest:"forest",waterside:"waterside",coast:"coast"})[p.kindId] || p.kindId || "";
  }
  function identity(p, raw = p) {
    const tags = {...raw.photoHints, ...raw.extra, ...raw.tags};
    const old = p.facilityIdentity;
    if (old?.version === 1 && ["names","ids","wikidata","wikipedia","sources"].every(k=>Array.isArray(old[k]))
      && typeof old.category === "string" && old.address && typeof old.fullAddress === "string") return old;
    const type = raw.osmType || raw.osm_type || raw.type, id = raw.osmId ?? raw.osm_id ?? raw.id;
    const osmType = ({N:"node",W:"way",R:"relation"})[type] || type;
    const source = text(raw.source);
    const ids = [];
    if (["node","way","relation"].includes(osmType) && /^[1-9]\d*$/.test(String(id))) ids.push(`osm:${osmType}/${id}`);
    else if (source && id !== undefined) ids.push(`${source}:${type}/${id}`);
    const names = unique([raw.naturalAccess?.featureName || p.name, ...["name","name:ja","name:en"].map(key=>text(tags[key] || raw[key])),
      ...["official_name","alt_name","short_name"].flatMap(key => text(tags[key] || raw[key]).split(";"))].map(normalize)).slice(0, 20);
    const kind=category(p,tags);
    if(kind === "station") for(const n of [...names]) if(n.endsWith("駅") && n.length>1 && !names.includes(n.slice(0,-1))) names.push(n.slice(0,-1));
    const address = {};
    for (const key of ["country","province","city","suburb","quarter","neighbourhood","street","housenumber","postcode","unit"]) {
      const value = tags[`addr:${key}`]; if (text(value)) address[key] = normalizeAddress(value);
    }
    const q = text(tags.wikidata || raw.wikidata || (osmType === "wikidata" ? id : ""));
    const jaWiki = tags["wikipedia:ja"] || raw["wikipedia:ja"];
    const wiki = [tags.wikipedia || raw.wikipedia, jaWiki && `ja:${jaWiki}`].filter(Boolean)
      .map(v => text(v).replace(/_/g," ")).map(v => { const at=v.indexOf(":"); return at>0 ? `${v.slice(0,at).toLowerCase()}:${normalize(v.slice(at+1))}` : ""; });
    let bounds=raw.bounds;
    if(!bounds && Array.isArray(raw.extent) && raw.extent.length===4 && raw.extent.every(Number.isFinite)) {
      bounds={minlon:raw.extent[0],maxlat:raw.extent[1],maxlon:raw.extent[2],minlat:raw.extent[3]};
    }
    if(!bounds && Array.isArray(raw.geometry) && raw.geometry.length>2 && raw.geometry.length<=2048 && raw.geometry.every(p=>Number.isFinite(p?.lat)&&Number.isFinite(p?.lon))) {
      bounds={minlat:Math.min(...raw.geometry.map(p=>p.lat)),maxlat:Math.max(...raw.geometry.map(p=>p.lat)),minlon:Math.min(...raw.geometry.map(p=>p.lon)),maxlon:Math.max(...raw.geometry.map(p=>p.lon))};
    }
    if(!bounds || ![bounds.minlat,bounds.maxlat,bounds.minlon,bounds.maxlon].every(Number.isFinite) || bounds.minlat>bounds.maxlat || bounds.minlon>bounds.maxlon) bounds=null;
    return {version:1, ids, names, category:kind, wikidata:/^Q[1-9]\d*$/.test(q) ? [q] : [], wikipedia:unique(wiki),bounds,
      address, fullAddress:["mlit","mlit-bus"].includes(source) ? "" : normalizeAddress(p.address || tags["addr:full"]), brand:normalize(tags["brand:ja"] || tags.brand),
      platform:normalize(tags.local_ref || tags.ref || tags.direction),
      stationRole:tags.building === "train_station" ? "building" : ["station","halt"].includes(tags.railway) ? "station" : "",
      unnamed:!!raw.naturalAccess?.unnamed || names.length === 0,
      anchor:raw.naturalAccess ? `${raw.naturalAccess.anchorType}/${raw.naturalAccess.anchorId}` : p.accessAnchor ? `${p.accessAnchor.type}/${p.accessAnchor.id}` : "",
      access:raw.naturalAccess?.status || p.accessStatus || (tags.entrance && !["no","private"].includes(tags.access) && tags.foot!=="no" ? "entrance" : ""), osmType,
      sources:unique([source || (ids.some(i=>i.startsWith("osm:")) ? "osm" : "")])};
  }
  function attach(p, raw = p) { const info=identity(p,raw);return p.facilityIdentity === info ? p : {...p,facilityIdentity:info}; }
  const intersects = (a,b) => a.some(v=>b.includes(v));
  function compatible(a,b) {
    if (!a || !b) return true;
    return a === b || ["sakura","autumn","sightseeing","places","any"].includes(a) || ["sakura","autumn","sightseeing","places","any"].includes(b)
      || (["shinto","buddhist"].includes(a) && ["shrine","worship"].includes(b)) || (["shinto","buddhist"].includes(b) && ["shrine","worship"].includes(a));
  }
  function radius(kind) {
    if (["park","university"].includes(kind)) return 300;
    if (kind === "forest") return 250;
    if (kind === "station") return 180;
    if (["shinto","buddhist","shrine","worship"].includes(kind)) return 180;
    if (["museum","waterside","coast"].includes(kind)) return 100;
    return kind === "bus_stop" ? 10 : 35;
  }
  function similarity(a,b) {
    if (Math.min(a.length,b.length)<6) return 0;
    const grams = s => { const m=new Map();for(let i=1;i<s.length;i++){const g=s.slice(i-1,i+1);m.set(g,(m.get(g)||0)+1);}return m; };
    const left=grams(a),right=grams(b);let shared=0;for(const [g,n] of left)shared+=Math.min(n,right.get(g)||0);
    return 2*shared/(a.length+b.length-2);
  }
  function pairRadius(a,b) {
    const x=identity(a),y=identity(b);let limit=x.category && y.category ? Math.min(radius(x.category),radius(y.category)) : radius(x.category || y.category);
    for(const [i,p] of [[x,b],[y,a]])if(["park","university","forest","shinto","buddhist","shrine","worship"].includes(i.category) && i.bounds
      && p.lat>=i.bounds.minlat && p.lat<=i.bounds.maxlat && p.lng>=i.bounds.minlon && p.lng<=i.bounds.maxlon) {
      const diagonal=meters({lat:i.bounds.minlat,lng:i.bounds.minlon},{lat:i.bounds.maxlat,lng:i.bounds.maxlon});
      limit=Math.max(limit,Math.min(500,diagonal));
    }
    return limit;
  }
  function conflict(a,b) {
    const x=identity(a),y=identity(b);
    if (!compatible(x.category,y.category)) return true;
    const stationBuilding=x.category === "station" && y.category === "station" && intersects(x.names,y.names)
      && !x.address.housenumber && !y.address.housenumber && [[x,y,b],[y,x,a]].some(([building,other,p])=>building.stationRole === "building" && other.stationRole === "station"
        && meters(a,b)<=100 && (building.bounds ? p.lat>=building.bounds.minlat && p.lat<=building.bounds.maxlat && p.lng>=building.bounds.minlon && p.lng<=building.bounds.maxlon : meters(a,b)<=40));
    for (const key of Object.keys(x.address || {})) if (y.address?.[key] && x.address[key] !== y.address[key] && !(stationBuilding && key === "street")) return true;
    const fullSame=!!x.fullAddress && x.fullAddress===y.fullAddress;
    if (x.fullAddress && y.fullAddress && !fullSame && !x.fullAddress.includes(y.fullAddress) && !y.fullAddress.includes(x.fullAddress) && !stationBuilding) return true;
    if (x.wikidata.length && y.wikidata.length && !intersects(x.wikidata,y.wikidata)) return true;
    if ((x.category === "bus_stop" || x.category.startsWith("railway:")) && x.platform && y.platform && x.platform !== y.platform) return true;
    const distance=meters(a,b),limit=pairRadius(a,b);
    return !Number.isFinite(distance) || distance>(intersects(x.ids,y.ids)?1000:intersects(x.wikidata,y.wikidata)?Math.max(limit,400):intersects(x.wikipedia,y.wikipedia)?Math.max(limit,250):limit);
  }
  function explain(a,b) {
    const x=identity(a),y=identity(b),distance=meters(a,b),limit=pairRadius(a,b);
    if (conflict(a,b)) return "";
    const fullSame=!!x.fullAddress && x.fullAddress===y.fullAddress;
    if (intersects(x.ids,y.ids) && distance<=1000) return "source-id";
    // Platforms, railway stops and entrances may share a station name/ID but
    // are separate boarding/access points. Preserve them unless the OSM ID agrees.
    if (x.category.startsWith("railway:") || y.category.startsWith("railway:")) return "";
    if (intersects(x.wikidata,y.wikidata) && distance<=Math.max(limit,400)) return "wikidata";
    if (intersects(x.wikipedia,y.wikipedia) && distance<=Math.max(limit,250)) return "wikipedia";
    for (const wiki of x.wikipedia) if (y.wikipedia.some(v=>v.split(":")[0]===wiki.split(":")[0] && v!==wiki)) return "";
    if (distance>limit || !x.category || !y.category) return "";
    if (x.category === "bus_stop" && x.platform && y.platform && x.platform !== y.platform) return "";
    // One displayed walking access point can represent an unnamed fragment of
    // the same forest/coast; never collapse two distinct named natural features.
    if (["forest","waterside","coast"].includes(x.category) && x.category===y.category && x.anchor && x.anchor===y.anchor && distance<5 && (x.unnamed || y.unnamed)) return "shared-access";
    // Anonymous forests sharing one access path do not identify a whole facility.
    if (x.unnamed || y.unnamed) return "";
    const exact=intersects(x.names,y.names);
    const store = x.category.startsWith("shop:") || ["cafe","restaurant","fast_food","bus_stop","toilet"].includes(x.category);
    const preciseAddress=(fullSame && /\d+-\d+/.test(x.fullAddress)) || (!!x.address.housenumber && x.address.housenumber===y.address.housenumber && !!x.address.street && x.address.street===y.address.street);
    if (exact) {
      // A brand name alone is not a branch identity. Opposite bus platforms stay separate.
      if (store && !preciseAddress && !(x.category === "bus_stop" && distance<=5) && !(x.osmType !== y.osmType && [x.osmType,y.osmType].includes("node") && [x.osmType,y.osmType].some(t=>["way","relation"].includes(t)) && distance<=8)) return "";
      if ((x.names.includes(x.brand) || y.names.includes(y.brand)) && !preciseAddress) return "";
      return "name-category-distance";
    }
    if (!store && preciseAddress && distance<=Math.min(30,limit) && x.names.some(n=>y.names.some(m=>(n.match(/\d+/g)||[]).join("/")===(m.match(/\d+/g)||[]).join("/") && similarity(n,m)>=.9))) return "similar-name-address";
    return "";
  }
  function score(p) {
    const i=identity(p);return (i.category?2:0)+(p.address?3:0)+(p.description?2:0)+(Object.keys(p.photoHints||{}).length)+i.names.length+i.ids.length+i.wikidata.length*3;
  }
  function accessScore(p) {
    const i=identity(p);return i.access === "mapped" ? 100 : i.access === "unknown" ? 90 : i.access === "entrance" ? 80 : i.osmType === "node" ? 20 : 0;
  }
  function merge(a,b) {
    const rich=score(b)>score(a)?b:a,other=rich===a?b:a,route=accessScore(b)>accessScore(a)?b:a;
    const out={...other,...rich,key:a.key || rich.key};
    for (const [k,v] of Object.entries(other)) if (out[k] === "" || out[k] == null) out[k]=v;
    out.photoHints={...other.photoHints,...rich.photoHints};
    for(const k of ["alt_name","official_name","short_name"])if(other.photoHints?.[k] && rich.photoHints?.[k]) out.photoHints[k]=unique([...other.photoHints[k].split(";"),...rich.photoHints[k].split(";")]).join(";").slice(0,1000);
    for (const k of ["lat","lng","distance","directDistance","duration","alongRoute","distanceFromRoute","accessAnchor","accessStatus","accessNote","naturalUnnamed","elevation","ambienceNote","ruralMatch","ruralRejected","preferenceScore"]) {
      // Metrics must refer to the same selected route point, never mix centres and entrances.
      delete out[k]; if (route[k] !== undefined) out[k]=route[k];
    }
    const x=identity(a),y=identity(b);
    out.facilityIdentity={...identity(route),category:identity(rich).category || x.category || y.category,unnamed:x.unnamed && y.unnamed,
      names:unique([...x.names,...y.names]).slice(0,20), ids:unique([...x.ids,...y.ids]),wikidata:unique([...x.wikidata,...y.wikidata]),wikipedia:unique([...x.wikipedia,...y.wikipedia]),
      address:{...identity(other).address,...identity(rich).address},fullAddress:identity(rich).fullAddress || identity(other).fullAddress,sources:unique([...x.sources,...y.sources])};
    return out;
  }
  function dedupe(input) {
    // Index names/addresses inside geographic cells; different names do not
    // trigger all-pairs comparisons even in a dense city. IDs have their own index.
    const groups=[],cells=new Map(),ids=new Map();
    const cell=p=>[Math.floor(p.lat*100),Math.floor(p.lng*100)];
    const tokens=i=>unique([...i.names.map(n=>`name:${n}`), i.fullAddress && /\d/.test(i.fullAddress) ? `address:${i.fullAddress}` : "",
      i.address.street && i.address.housenumber ? `house:${i.address.street}/${i.address.housenumber}` : "",i.anchor ? `anchor:${i.anchor}` : ""]);
    function index(p,g) {
      const [lat,lng]=cell(p),i=identity(p);
      for(const token of tokens(i)){const key=`${lat}/${lng}/${token}`;if(!cells.has(key))cells.set(key,new Set());cells.get(key).add(g);}
      for(const id of [...i.ids,...i.wikidata,...i.wikipedia]){if(!ids.has(id))ids.set(id,new Set());ids.get(id).add(g);}
    }
    for (const raw of input || []) {
      if (!point(raw)) continue;
      const p=attach(raw),i=identity(p),near=new Set(),[lat,lng]=cell(p);
      const dx=Math.ceil(1/Math.max(.02,Math.cos(p.lat*Math.PI/180)));
      for(const token of tokens(i))for(let y=lat-1;y<=lat+1;y++)for(let x=lng-dx;x<=lng+dx;x++)for(const g of cells.get(`${y}/${x}/${token}`)||[])near.add(g);
      for(const id of [...i.ids,...i.wikidata,...i.wikipedia])for(const g of ids.get(id)||[])near.add(g);
      // Require consistency with every original member: no transitive "bridge" merges.
      const match=[...near].sort((a,b)=>a-b).find(g=>explain(groups[g].place,p) && groups[g].members.every(other=>!conflict(other,p)));
      if(match===undefined){const g=groups.length;groups.push({place:p,members:[p]});index(p,g);}
      else {groups[match].place=merge(groups[match].place,p);groups[match].members.push(p);index(p,match);}
    }
    return groups.map(g=>g.place);
  }
  // Reorder only the slots occupied by the same normalized display name.
  // A global "same name ? distance : relevance" comparator is not transitive.
  function prioritizeSameNames(input, origin) {
    const ordered = [...input];
    if (!point(origin)) return ordered;
    const groups = new Map();
    ordered.forEach((place, index) => {
      const name = normalize(place?.name);
      if (!name) return;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push({ place, index, distance: meters(origin, place) });
    });
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const nearest = [...group].sort((a, b) => a.distance - b.distance || a.index - b.index);
      group.forEach((slot, index) => { ordered[slot.index] = nearest[index].place; });
    }
    return ordered;
  }
  function searchResults(input) {
    const places=dedupe(input),stations=places.filter(p=>identity(p).category === "station");
    // Boarding positions are not separate walking destinations when their
    // parent station is already present. Keep explicitly searchable entrances.
    return places.filter(p=>!["railway:stop","railway:platform"].includes(identity(p).category) || !stations.some(s=>meters(s,p)<180
      && identity(p).names.some(n=>identity(s).names.some(name=>name.length>=2 && n === name))));
  }
  const api={normalize,meters,identity,attach,explain,prioritizeSameNames,same:(a,b)=>!!explain(a,b),merge,dedupe,searchResults};
  if(typeof module==="object"&&module.exports)module.exports=api;else root.PlaceIdentity=api;
})(typeof globalThis!=="undefined"?globalThis:this);
