var CACHE='tracker-v4';
var FILES=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','icon-maskable-512.png'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(FILES);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k.indexOf('tracker-v')===0&&k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;
  e.respondWith(fetch(e.request).then(function(r){var copy=r.clone();caches.open(CACHE).then(function(c){c.put(e.request,copy);});return r;}).catch(function(){return caches.match(e.request,{ignoreSearch:true}).then(function(m){return m||caches.match('index.html');});}));
});
function localDate(){var d=new Date();function p(n){return n<10?'0'+n:''+n;}return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}
function compose(type,status){
  var fresh=status&&status.date===localDate();
  if(type==='test')return {t:'Notifications are working',b:'You will get reminders at the times you picked, only when something is missing.'};
  if(type==='trades')return {t:'Hey, you haven\u2019t entered any trades today',b:'Log your trades, or mark today as a no trade day.'};
  if(type==='water')return {t:'Hey, don\u2019t forget your water',b:'You\u2019re under your water goal for today.'};
  if(type==='finish'){var n=fresh?status.remaining:0;return {t:n?'You still have '+n+(n===1?' thing':' things')+' left today':'You still have a few things left today',b:'Open your tracker to finish your day.'};}
  return {t:'Hey, you haven\u2019t checked in today',b:'Open your tracker and log your day.'};
}
self.addEventListener('push',function(e){
  e.waitUntil((async function(){
    var data={};
    try{var c=await caches.open('tracker-data');var r=await c.match('/__state');if(r)data=await r.json();}catch(err){}
    var type='checkin';
    try{if(e.data){var j=e.data.json();if(j&&j.type)type=j.type;}}catch(err){}
    try{if(type==='checkin'&&data.url&&data.id){var pr=await fetch(data.url+'/pending?id='+encodeURIComponent(data.id));type=(await pr.json()).type||'checkin';}}catch(err){}
    var m=compose(type,data.status);
    return self.registration.showNotification(m.t,{body:m.b,icon:'icon-192.png',badge:'icon-192.png',tag:'tracker-'+type,data:{url:'./'}});
  })());
});
self.addEventListener('notificationclick',function(e){
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(cs){for(var i=0;i<cs.length;i++){if('focus' in cs[i])return cs[i].focus();}return self.clients.openWindow('./');}));
});
