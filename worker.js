import {DurableObject} from 'cloudflare:workers';
import CAT from '../public/catalog.json';
import MAPS from '../public/maps.json';
const ITEM=Object.fromEntries(CAT.items.map(i=>[i.id,i])),OUT=Object.fromEntries(CAT.outfits.map(o=>[o.id,o])),MAPBY=Object.fromEntries(MAPS.map(m=>[m.id,m]));
const SPECIES=['dog','cat','bunny','fox','panda','bear'],UN=/^[A-Za-z0-9_]{3,16}$/,HEX=/^#[0-9a-f]{6}$/i;
const DEF='{"sp":"dog","fur":"#ffb86b","eye":"#2b6bff","it":{}}';
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const rid=n=>hex(crypto.getRandomValues(new Uint8Array(n)));
async function hashPw(pw,salt){const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new TextEncoder().encode(salt),iterations:100000},k,256))}
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'Content-Type':'application/json'}});
const outCost=(o,owned)=>Math.round(.8*o.items.filter(i=>!owned.includes(i)).reduce((a,i)=>a+ITEM[i].p,0));
function cleanLook(l,owned){
  if(!l||!SPECIES.includes(l.sp)||!HEX.test(l.fur)||!HEX.test(l.eye))return null;
  const it={};for(const[s,id]of Object.entries(l.it||{})){const i=ITEM[id];if(!i||i.s!==s||(owned&&!owned.includes(id)))return null;it[s]=id}
  return{sp:l.sp,fur:l.fur,eye:l.eye,it};
}
export class Registry extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.sql=ctx.storage.sql;
    ctx.blockConcurrencyWhile(async()=>{
      for(const s of[
        "CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE COLLATE NOCASE,salt TEXT,hash TEXT,coins INTEGER DEFAULT 200,owned TEXT DEFAULT '[]',look TEXT,looks TEXT DEFAULT '[]',role TEXT DEFAULT 'player',online TEXT,seen INTEGER DEFAULT 0)",
        "CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,uid INTEGER,exp INTEGER,adm INTEGER DEFAULT 0)",
        "CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT)",
        "CREATE TABLE IF NOT EXISTS fails(k TEXT PRIMARY KEY,n INTEGER,until INTEGER)"])this.sql.exec(s);
      await this.seed();
    })}
  async seed(){if(this.q('SELECT 1 FROM users WHERE id=1').length||!this.env.ADMIN_PASSWORD)return;
    const salt=rid(16);this.sql.exec("INSERT OR IGNORE INTO users(id,username,salt,hash,coins,role,look) VALUES(1,'Admin',?,?,100000,'admin',?)",salt,await hashPw(this.env.ADMIN_PASSWORD,salt),DEF)}
  q(s,...a){return this.sql.exec(s,...a).toArray()}
  pub(uid){const r=this.q('SELECT * FROM users WHERE id=?',uid)[0];return r&&{id:r.id,username:r.username,coins:r.coins,owned:JSON.parse(r.owned),look:JSON.parse(r.look),looks:JSON.parse(r.looks),role:r.role}}
  mkSession(uid){const token=rid(24);this.sql.exec('INSERT INTO sessions(token,uid,exp) VALUES(?,?,?)',token,uid,Date.now()+30*864e5);return{token,me:this.pub(uid)}}
  fail(k){const f=this.q('SELECT n FROM fails WHERE k=?',k)[0],n=(f?f.n:0)+1;this.sql.exec('INSERT OR REPLACE INTO fails VALUES(?,?,?)',k,n>=5?0:n,n>=5?Date.now()+300000:0)}
  locked(k){const f=this.q('SELECT until FROM fails WHERE k=?',k)[0];return f&&f.until>Date.now()}
  async signup(u,p){await this.seed();
    u=String(u||'');p=String(p||'');
    if(!UN.test(u)||p.length<6||p.length>64)return{error:'Username: 3-16 letters, numbers or _. Password: 6+ characters.'};
    if(!this.q('SELECT 1 FROM users WHERE id=1').length)return{error:'Server is not set up yet (admin secret missing).'};
    if(this.q('SELECT 1 FROM users WHERE username=?',u).length)return{error:'That username is taken.'};
    const salt=rid(16),h=await hashPw(p,salt);
    try{this.sql.exec('INSERT INTO users(username,salt,hash,look) VALUES(?,?,?,?)',u,salt,h,DEF)}catch{return{error:'That username is taken.'}}
    return this.mkSession(this.q('SELECT id FROM users WHERE username=?',u)[0].id)}
  async login(u,p){await this.seed();
    u=String(u||'');const k='l:'+u.toLowerCase();
    if(this.locked(k))return{error:'Too many attempts. Try again in 5 minutes.'};
    const r=this.q('SELECT * FROM users WHERE username=?',u)[0];
    if(!r||await hashPw(String(p||''),r.salt)!==r.hash){this.fail(k);return{error:'Wrong username or password.'}}
    this.sql.exec('DELETE FROM fails WHERE k=?',k);return this.mkSession(r.id)}
  logout(t){this.sql.exec('DELETE FROM sessions WHERE token=?',t)}
  session(t){const s=this.q('SELECT uid,exp,adm FROM sessions WHERE token=?',String(t||''))[0];if(!s||s.exp<Date.now())return null;
    this.sql.exec('UPDATE users SET seen=? WHERE id=?',Date.now(),s.uid);const u=this.pub(s.uid);return u&&{uid:s.uid,name:u.username,look:u.look,role:u.role,adm:s.adm>Date.now()}}
  me(t){const s=this.session(t);return s&&this.pub(s.uid)}
  save(uid,look,looks){const u=this.pub(uid),l=cleanLook(look,u.owned);if(!l)return{error:'Invalid look'};
    const ls=(Array.isArray(looks)?looks:[]).slice(0,10).map(x=>({n:String(x.n||'Look').slice(0,20),look:cleanLook(x.look,null)})).filter(x=>x.look);
    this.sql.exec('UPDATE users SET look=?,looks=? WHERE id=?',JSON.stringify(l),JSON.stringify(ls),uid);return{me:this.pub(uid)}}
  buy(uid,id){const u=this.pub(uid),it=ITEM[id],ou=OUT[id];let cost,add;
    if(it){if(u.owned.includes(id))return{error:'Already owned'};cost=it.p;add=[id]}
    else if(ou){add=ou.items.filter(i=>!u.owned.includes(i));if(!add.length)return{error:'Already owned'};cost=outCost(ou,u.owned)}
    else return{error:'Unknown item'};
    if(u.coins<cost)return{error:'Not enough coins'};
    this.sql.exec('UPDATE users SET coins=coins-?,owned=? WHERE id=?',cost,JSON.stringify([...u.owned,...add]),uid);return{me:this.pub(uid)}}
  addCoins(uid,v){this.sql.exec('UPDATE users SET coins=coins+? WHERE id=?',v,uid);return this.q('SELECT coins FROM users WHERE id=?',uid)[0].coins}
  setOnline(uid,m,was){if(m||!was||this.q('SELECT online FROM users WHERE id=?',uid)[0]?.online===was)this.sql.exec('UPDATE users SET online=?,seen=? WHERE id=?',m,Date.now(),uid)}
  info(){const g=k=>this.q('SELECT v FROM kv WHERE k=?',k)[0]?.v;return{announce:g('announce')||'',locked:g('locked')==='1'}}
  kvSet(k,v){this.sql.exec('INSERT OR REPLACE INTO kv VALUES(?,?)',k,v)}
  isAdmin(t){const s=this.session(t);return!!(s&&s.role==='admin'&&s.adm)}
  unlock(t,code){const s=this.session(t);if(!s||s.role!=='admin')return{error:'Forbidden'};const k='c:'+s.uid;
    if(this.locked(k))return{error:'Too many attempts. Try again in 5 minutes.'};
    if(!this.env.ADMIN_CODE||String(code)!==this.env.ADMIN_CODE){this.fail(k);return{error:'Wrong code'}}
    this.sql.exec('UPDATE sessions SET adm=? WHERE token=?',Date.now()+36e5,t);return{ok:1}}
  players(){return this.q('SELECT id,username,coins,online,seen,role FROM users ORDER BY id').map(r=>({...r,online:r.online&&Date.now()-r.seen<90000?r.online:null}))}
  adminCoins(id,op,n){if(!Number.isInteger(id)||!Number.isInteger(n)||n<0||n>1e9)return{error:'Bad id or amount'};
    if(!this.q('SELECT 1 FROM users WHERE id=?',id).length)return{error:'No such player'};
    this.sql.exec(op==='set'?'UPDATE users SET coins=? WHERE id=?':op==='add'?'UPDATE users SET coins=MIN(coins+?,2000000000) WHERE id=?':'UPDATE users SET coins=MAX(coins-?,0) WHERE id=?',n,id);
    return{id,coins:this.q('SELECT coins FROM users WHERE id=?',id)[0].coins}}
  async resetPw(id,pw){if(pw.length<6||pw.length>64)return{error:'Password must be 6-64 characters'};
    if(!this.q('SELECT 1 FROM users WHERE id=?',id).length)return{error:'No such player'};
    const salt=rid(16);this.sql.exec('UPDATE users SET salt=?,hash=? WHERE id=?',salt,await hashPw(pw,salt),id);this.sql.exec('DELETE FROM sessions WHERE uid=?',id);return{ok:1}}
}
export class MapRoom extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.pl=new Map();this.coins=[];this.seq=0;this.timer=null}
  count(){return this.pl.size}
  send(o,ex){const s=JSON.stringify(o);for(const p of this.pl.values())if(p!==ex){try{p.ws.send(s)}catch{}}}
  spawn(m){const s=m.spawns[Math.random()*m.spawns.length|0],c={id:++this.seq,x:s[0],y:s[1],v:Math.random()<.12?5:1};this.coins.push(c);this.send({t:'coin',c})}
  reset(reason){this.coins=[];for(const p of[...this.pl.values()]){try{p.ws.send(JSON.stringify({t:'kicked',reason}));p.ws.close(1000,'reset')}catch{}}}
  async fetch(req){
    const map=MAPBY[new URL(req.url).searchParams.get('map')];if(!map)return new Response('bad map',{status:400});
    const uid=+req.headers.get('x-uid'),name=req.headers.get('x-name'),look=JSON.parse(req.headers.get('x-look')||'{}');
    const old=this.pl.get(uid);if(old){this.pl.delete(uid);try{old.ws.close(1000,'dup')}catch{}}
    if(this.pl.size>=10)return new Response('full',{status:409});
    const[client,ws]=Object.values(new WebSocketPair());ws.accept();
    const me={ws,uid,name,look,x:map.start[0],y:map.start[1],ts:Date.now()},reg=this.env.REG.get(this.env.REG.idFromName('main'));let n=0;
    this.pl.set(uid,me);reg.setOnline(uid,map.id);
    if(!this.timer)this.timer=setInterval(()=>{if(this.coins.length<20)this.spawn(map)},2000);
    while(this.coins.length<15)this.spawn(map);
    const list={};for(const p of this.pl.values())list[p.uid]={name:p.name,look:p.look,x:p.x,y:p.y};
    ws.send(JSON.stringify({t:'init',you:uid,players:list,coins:this.coins}));
    this.send({t:'join',p:{id:uid,name,look,x:me.x,y:me.y}},me);
    let hb=0;const rate=setInterval(()=>{n=0;if(++hb%30===0)reg.setOnline(uid,map.id)},1000);
    ws.addEventListener('message',async ev=>{
      if(++n>40)return ws.close(1008,'rate');
      let m;try{m=JSON.parse(ev.data)}catch{return}
      if(m.t==='move'){
        const now=Date.now(),dt=Math.max(.05,(now-me.ts)/1000),x=+m.x,y=+m.y;me.ts=now;
        if(Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-me.x)<=600*dt+40&&Math.abs(y-me.y)<=1500*dt+80&&x>=0&&x<=map.w&&y>-200&&y<1200){
          me.x=x;me.y=y;this.send({t:'move',id:uid,x,y,f:m.f===-1?-1:1},me)}
        else ws.send(JSON.stringify({t:'fix',x:me.x,y:me.y}));
      }else if(m.t==='pick'){
        const i=this.coins.findIndex(c=>c.id===m.id),c=this.coins[i];
        if(c&&Math.abs(c.x-me.x)<60&&Math.abs(c.y-(me.y-28))<70){
          this.coins.splice(i,1);this.send({t:'gone',id:c.id});
          ws.send(JSON.stringify({t:'award',v:c.v,coins:await reg.addCoins(uid,c.v)}));
        }}
    });
    const bye=()=>{clearInterval(rate);if(this.pl.get(uid)!==me)return;this.pl.delete(uid);reg.setOnline(uid,null,map.id);this.send({t:'leave',id:uid});
      if(!this.pl.size){clearInterval(this.timer);this.timer=null}};
    ws.addEventListener('close',bye);ws.addEventListener('error',bye);
    return new Response(null,{status:101,webSocket:client});
  }
}
export default{async fetch(req,env){
  const u=new URL(req.url),p=u.pathname,reg=env.REG.get(env.REG.idFromName('main')),room=id=>env.ROOMS.get(env.ROOMS.idFromName(id));
  const tok=u.searchParams.get('token')||(req.headers.get('Authorization')||'').replace('Bearer ','');
  if(p==='/ws'){
    if(req.headers.get('Upgrade')!=='websocket')return new Response('Expected websocket',{status:426});
    const s=await reg.session(tok);if(!s)return new Response('Sign in first',{status:401});
    if((await reg.info()).locked&&s.role!=='admin')return new Response('locked',{status:423});
    const m=u.searchParams.get('map');if(!MAPBY[m])return new Response('bad map',{status:400});
    const h=new Headers(req.headers);h.set('x-uid',s.uid);h.set('x-name',s.name);h.set('x-look',JSON.stringify(s.look));
    return room(m).fetch(new Request(req,{headers:h}));
  }
  if(!p.startsWith('/api/'))return new Response('Not found',{status:404});
  const b=req.method==='POST'?await req.json().catch(()=>({})):{},a=p.slice(5),R=r=>r.error?J(r,400):J(r);
  if(a==='signup')return R(await reg.signup(b.username,b.password));
  if(a==='login')return R(await reg.login(b.username,b.password));
  if(a==='status'){const c=await Promise.all(MAPS.map(m=>room(m.id).count())),i=await reg.info();return J({maps:Object.fromEntries(MAPS.map((m,k)=>[m.id,c[k]])),...i})}
  const s=await reg.session(tok);if(!s)return J({error:'Please sign in'},401);
  if(a==='me')return J({me:await reg.me(tok)});
  if(a==='logout'){await reg.logout(tok);return J({ok:1})}
  if(a==='save')return R(await reg.save(s.uid,b.look,b.looks));
  if(a==='buy')return R(await reg.buy(s.uid,String(b.id)));
  if(a==='admin/unlock')return(r=>r.error?J(r,403):J(r))(await reg.unlock(tok,b.code));
  if(a.startsWith('admin/')){
    if(!await reg.isAdmin(tok))return J({error:'Forbidden'},403);
    const x=a.slice(6);
    if(x==='players')return J({players:await reg.players()});
    if(x==='coins')return R(await reg.adminCoins(+b.id,b.op,+b.amount));
    if(x==='resetpw')return R(await reg.resetPw(+b.id,String(b.password||'')));
    if(x==='announce'){await reg.kvSet('announce',String(b.text||'').slice(0,200));return J({ok:1})}
    if(x==='lock'){await reg.kvSet('locked',b.locked?'1':'0');if(b.locked)await Promise.all(MAPS.map(m=>room(m.id).reset('Servers locked')));return J({ok:1})}
    if(x==='resetservers'){await Promise.all(MAPS.map(m=>room(m.id).reset('Server reset')));return J({ok:1})}
  }
  return J({error:'Not found'},404);
}};
