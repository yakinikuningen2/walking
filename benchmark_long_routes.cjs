// Explicit opt-in live probe against the existing Valhalla service. Raw route
// data stays in the OS temporary directory, never in the repository.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const R=require('./static/js/long-routes.js');
const source=fs.readFileSync(path.join(__dirname,'static/js/app.js'),'utf8');
const folder=path.join(os.tmpdir(),'walking-long-routes');
function context(){
 const calls=[],routeData=[],c=vm.createContext({URL,URLSearchParams,AbortController,DOMException,setTimeout,clearTimeout,Date,Math,Number,Map,Set,
   LongRoutes:R,ROUTE_ENDPOINT:'https://valhalla1.openstreetmap.de/route',ROUTE_ACCESS_ENDPOINT:'https://app.test/access',MAP_PROXY_ENDPOINT:'http://127.0.0.1:8000/api/overpass',
   routeAccessCache:JSON.parse(fs.readFileSync(path.join(__dirname,'static/route-access.json'),'utf8')),routeTurn:Promise.resolve(),lastRouteAt:-Infinity,
   validCoordinates:(lat,lng)=>R.valid({lat,lng}),map:{distance:(a,b)=>R.meters(Array.isArray(a)?{lat:a[0],lng:a[1]}:a,Array.isArray(b)?{lat:b[0],lng:b[1]}:b)},
   DISCOVERY_MAP_ENDPOINTS:[],fetchMapProxy:async()=>null,
   fetch:async(url,options)=>{const t=performance.now();try{const response=await fetch(url,options);const data=await response.clone().json();
     const routePath=url.pathname==='/api/valhalla'?'/'+JSON.parse(options.body).action:url.pathname;
     calls.push({path:routePath,http:response.status,seconds:Number(((performance.now()-t)/1000).toFixed(3)),code:data.error_code||data.code});routeData.push(data);return response;
   }catch(error){calls.push({path:url.pathname,error:error.name});throw error;}}});
 const load=(first,next)=>vm.runInContext(source.slice(source.indexOf(first),source.indexOf(next)),c);
 load('function abortableRouteDelay(','async function fetchMapProxy(');
 load('async function fetchRouteJson(','async function waitForRouteTurn(');
 load('async function waitForRouteTurn(','async function loadRouteAccess(');
 load('async function loadRouteAccess(','async function calculateWalkingRoute(');
 load('async function calculateWalkingRoute(','async function findNatureWaypoint(');
 load('function parseWalkingRoute(','function syncRouteLayers(');
 return {c,calls,routeData};
}
(async()=>{
 if(!process.argv.includes('--live-split')){console.log('Live requests are disabled. Run node benchmark_long_routes.cjs --live-split [--start=lat,lng --end=lat,lng] to test one route.');return;}
 fs.mkdirSync(folder,{recursive:true});
 const beyond=process.argv.includes('--beyond-limit');
 const station=beyond?JSON.parse(fs.readFileSync(path.join(__dirname,'static/stations-jp-2025-v1.json'),'utf8')).stations.find(r=>r[0]==='那須塩原'):null;
 const coordinate=flag=>{const arg=process.argv.find(s=>s.startsWith(flag+'='));if(!arg)return null;
   const values=arg.slice(flag.length+1).split(',');const p={lat:Number(values[0]),lng:Number(values[1])};
   if(values.length!==2||values.some(s=>!s.trim())||!R.valid(p))throw Error('Invalid '+flag+' coordinate');return p;};
 const customStart=coordinate('--start'),customEnd=coordinate('--end');
 if(Boolean(customStart)!==Boolean(customEnd))throw Error('Provide both --start and --end');
 const prefix=customStart?'extended':beyond?'beyond':'split';
 const {c,calls,routeData}=context(),start=customStart||{lat:35.681236,lng:139.767125},end=customEnd||(beyond?{lat:station[1],lng:station[2]}:{lat:36.5592,lng:139.8987}),controller=new AbortController();
 let primary;
 if(beyond||customStart)try{const result=await c.calculateWalkingRoute(start,end,'standard',4,{controller,longDistance:true});primary={ok:true,distance:result.distance};}
 catch(error){primary={ok:false,code:error.routeCode,http:error.httpStatus};}
 const t=performance.now();let result;
 try{
 const route=await R.segmented({start,end,signal:controller.signal,progress:msg=>console.error(msg),
   locate:async(points,signal)=>{const req={controller:{signal}};await c.waitForRouteTurn(req);const url=new URL('/locate',c.ROUTE_ENDPOINT);
     url.searchParams.set('json',JSON.stringify({locations:points.map(p=>({lat:p.lat,lon:p.lng,search_cutoff:1200})),verbose:true,costing:'pedestrian',costing_options:{pedestrian:{max_hiking_difficulty:0,use_ferry:0,private_access_penalty:43200}}}));return c.fetchRouteJson(url,req,15000);},
   route:(a,b,signal)=>c.calculateWalkingRoute(a,b,'standard',4,{controller:{signal},routeTimeoutMs:30000})});
 result={ok:true,distance:route.distance,duration:route.duration,points:route.points.length,segments:route.segmentCount};
 fs.writeFileSync(path.join(folder,prefix+'-route.json'),JSON.stringify(route));
 }catch(error){result={ok:false,code:error.routeCode,error:error.userMessage||error.message};}
 result={...result,start,end,primary,seconds:Number(((performance.now()-t)/1000).toFixed(3)),calls};
 fs.writeFileSync(path.join(folder,prefix+'-summary.json'),JSON.stringify(result,null,2));
 fs.writeFileSync(path.join(folder,prefix+'-raw.json'),JSON.stringify(routeData));
 console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1});
