/* KINGBOT FINTECH — conservative PWA cache */
const CACHE="kingbot-static-v5-theme";
const STATIC=[
  "./",
  "./index.html",
  "./system/platform.css",
  "./system/navigation.js",
  "./system/site-performance.js",
  "./system/ui-runtime.js",
  "./manifest.webmanifest"
];
self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(STATIC).catch(()=>{})).then(()=>self.skipWaiting()));
});
self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch",event=>{
  const req=event.request;
  if(req.method!=="GET")return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  if(url.pathname.includes("/api/")){
    event.respondWith(fetch(req,{cache:"no-store"}).catch(()=>new Response(JSON.stringify({ok:false,error:"OFFLINE"}),{status:503,headers:{"Content-Type":"application/json"}})));
    return;
  }
  if(req.mode==="navigate"){
    event.respondWith(fetch(req).then(response=>{
      const copy=response.clone();
      caches.open(CACHE).then(cache=>cache.put(req,copy)).catch(()=>{});
      return response;
    }).catch(()=>caches.match(req).then(cached=>cached||caches.match("./index.html"))));
    return;
  }
  const sharedUi=/\/system\/(ui-runtime|navigation|platform\.css|site-performance)\.js$|\/system\/platform\.css$/.test(url.pathname);
  if(sharedUi){
    event.respondWith(fetch(req,{cache:"no-store"}).then(response=>{
      if(response.ok) caches.open(CACHE).then(cache=>cache.put(req,response.clone())).catch(()=>{});
      return response;
    }).catch(()=>caches.match(req)));
    return;
  }
  event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(response=>{
    if(response.ok) caches.open(CACHE).then(cache=>cache.put(req,response.clone())).catch(()=>{});
    return response;
  })));
});