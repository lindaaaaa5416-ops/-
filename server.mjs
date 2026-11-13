import {createRecordArchive} from './record-archive.mjs';
import {toIcs,sessionEvent} from './src/ics.ts';
import {createAssetRoutes} from './asset-routes.mjs';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {seed,scheduleService,reviewService,knowledgeService,normalizeDb,profileService} from './src/service.ts';
if(existsSync('.env.local'))process.loadEnvFile('.env.local');
const dir=resolve(process.env.DATA_DIR||'server-data');mkdirSync(dir,{recursive:true});
const db=new DatabaseSync(resolve(dir,'workspace.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE,name TEXT,role TEXT,teacher TEXT,salt TEXT,hash TEXT,active INTEGER); CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user TEXT,expires INTEGER); CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY,revision INTEGER,body TEXT); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,time TEXT,user TEXT,action TEXT);`);
if(!db.prepare('SELECT id FROM state').get())db.prepare('INSERT INTO state VALUES(1,1,?)').run(JSON.stringify(seed()));
db.exec('CREATE TABLE IF NOT EXISTS bootstrap(key TEXT PRIMARY KEY,value TEXT)');
const needsSetup=!db.prepare('SELECT id FROM users').get();
const migrateRow=db.prepare('SELECT body FROM state WHERE id=1').get();const migrated=JSON.stringify(normalizeDb(JSON.parse(migrateRow.body)));if(migrated!==migrateRow.body)db.prepare('UPDATE state SET body=?,revision=revision+1 WHERE id=1').run(migrated);
const setupCode=process.env.SETUP_CODE||db.prepare("SELECT value FROM bootstrap WHERE key='setup-code'").get()?.value||randomBytes(16).toString('hex');
if(needsSetup)db.prepare("INSERT OR REPLACE INTO bootstrap VALUES('setup-code',?)").run(setupCode);else db.prepare('DELETE FROM bootstrap').run();
const port=Number(process.env.PORT||3001);const secure=process.env.COOKIE_SECURE==='true';const publicOrigin=process.env.APP_ORIGIN;
if(!db.prepare('SELECT id FROM users').get())console.log('首次管理员设置码（仅用于首次创建管理员）：'+setupCode);
const hash=(v)=>createHash('sha256').update(v).digest('hex');
const publicUser=u=>({id:u.id,username:u.username,name:u.name,role:u.role,teacher:u.teacher,active:!!u.active});
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status})};
const assets=createAssetRoutes({db,dir,fail});
const recordArchive=createRecordArchive({db,fail});
function authenticate(req){const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('km_session='))?.slice(11);const session=token&&db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(hash(token),Date.now());const user=session&&db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(session.user);if(!user)fail('请先登录，或登录已过期',401);return user}
const password=(p)=>{if(typeof p!=='string'||p.length<12||p.length>128)fail('密码需为 12—128 位');return p};
function createUser(body){const username=String(body.username||'').trim();if(!/^[a-zA-Z0-9_.-]{3,50}$/.test(username))fail('账号需为 3—50 位字母、数字、点、横线或下划线');if(!String(body.name||'').trim())fail('请填写姓名');if(!['admin','operator','teacher'].includes(body.role))fail('请选择有效角色');const data=JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body);if(body.role==='teacher'&&!data.teachers.some(t=>t.id===body.teacher))fail('请绑定授课老师');const salt=randomBytes(16).toString('hex');const derived=scryptSync(password(body.password),salt,64).toString('hex');try{db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,1)').run(crypto.randomUUID(),username,String(body.name).trim(),body.role,body.role==='teacher'?body.teacher:'',salt,derived)}catch(e){if(String(e).includes('UNIQUE'))fail('该账号已存在');throw e}}
const attempts=new Map();const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function validateChange(old,next,user){
 if(!next||next.schemaVersion!==1)fail('资料格式不支持');
 for(const key of Object.keys(old)){if(key==='schemaVersion')continue;if(!Array.isArray(next[key]))fail('资料不完整');const ids=next[key].map(x=>x.id);if(new Set(ids).size!==ids.length)fail('存在重复记录')}
 if(Object.keys(next).sort().join()!==Object.keys(old).sort().join())fail('资料结构不匹配');
 for(const key of ['teachers','venues']){for(const item of old[key])if(!equal(item,next[key].find(x=>x.id===item.id)))fail('已有老师和场地记录不能修改');const names=next[key].map(x=>String(x.name||'').trim().replace(/\s+/g,' '));if(names.some(x=>!x)||new Set(names).size!==names.length)fail('老师或场地名称无效或重复');}if(!equal(old.templates,next.templates))fail('当前不能修改课程模板');
 for(const key of ['profiles','sessions'])for(const item of old[key]){const after=next[key].find(x=>x.id===item.id);if(!after)fail('请使用删除按钮管理记录');if(Boolean(item.archived)!==Boolean(after.archived))fail('请使用专用删除或恢复入口');}
 for(const key of ['profiles','sessions'])for(const item of next[key])if(item.archived&&!old[key].some(x=>x.id===item.id&&x.archived))fail('新增记录不能标记为已删除');
 if(user.role==='teacher'){
  for(const key of Object.keys(old).filter(k=>!['reviews','materials','participations'].includes(k)))if(!equal(old[key],next[key]))fail('老师只能维护自己负责课程的资料、出席和复盘',403);
  const owns=sid=>old.sessions.some(s=>s.id===sid&&s.teacher===user.teacher);
  for(const key of ['reviews','materials','participations'])for(const id of new Set([...old[key],...next[key]].map(x=>x.id))){const before=old[key].find(x=>x.id===id),after=next[key].find(x=>x.id===id);if(!equal(before,after)&&(!owns((after||before).session)||(before&&!owns(before.session))))fail('只能维护自己负责的课程',403)}
 }
 for(const m of old.materials.filter(m=>m.storedFile)){const after=next.materials.find(x=>x.id===m.id);if(!equal(m,after))fail('请到资料中心管理已保存的原文件')}
 for(const m of next.materials.filter(m=>m.storedFile))if(!db.prepare('SELECT id FROM files WHERE id=? AND removed=0').get(m.id))fail('原文件不存在，请重新上传');
 for(const p of next.profiles)profileService.save(structuredClone(next),structuredClone(p));
 for(const s of next.sessions){if(!next.teachers.some(t=>t.id===s.teacher)||!next.venues.some(v=>v.id===s.venue)||!next.templates.some(t=>t.id===s.template))fail('排课引用无效');if(new Set(s.people).size!==s.people.length||!s.people.every(id=>next.profiles.some(p=>p.id===id&&p.type==='个人')))fail('参与人无效');const before=old.sessions.find(x=>x.id===s.id);if(before&&!equal(before.refs,s.refs))fail('历史课程知识版本不能改变');if(!before||!equal(before,s))scheduleService.save(structuredClone(next),structuredClone(s));if(!s.refs.every(id=>next.versions.some(v=>v.id===id)))fail('知识引用不存在')}
 if(next.executions.length!==next.sessions.length||next.sessions.some(s=>next.executions.filter(e=>e.session===s.id).length!==1))fail('每场课必须有唯一执行记录');
 if(next.participations.some(p=>!next.sessions.some(s=>s.id===p.session&&s.people.includes(p.person))||!['待确认','已出席','缺席'].includes(p.attendance)))fail('参与记录无效');
 if(next.sessions.some(s=>s.people.some(id=>next.participations.filter(p=>p.session===s.id&&p.person===id).length!==1)))fail('参与记录不完整');
 if(next.materials.some(m=>!next.sessions.some(s=>s.id===m.session&&(m.category!=='学员产出'||s.people.includes(m.person)))))fail('资料所属场次或参与人无效');
 if(new Set(next.reviews.map(r=>r.session)).size!==next.reviews.length)fail('每场课只能有一份复盘');for(const r of next.reviews){if(!next.sessions.some(s=>s.id===r.session))fail('复盘场次不存在');reviewService.save(structuredClone(next),structuredClone(r),r.submitted)}
 for(const k of next.knowledge){const versions=next.versions.filter(v=>v.knowledge===k.id);if(versions.filter(v=>v.status==='现行').length>1||versions.filter(v=>v.status==='草稿').length>1)fail('每个条目只能有一份现行版本和待处理草稿')}
 for(const v of old.versions){const after=next.versions.find(x=>x.id===v.id);if(!after)fail('历史知识版本不能删除');if(v.status!=='草稿'){const expected={...v,status:after.status};if(!equal(expected,after)||!(after.status===v.status||(v.status==='现行'&&after.status==='已归档')))fail('已发布知识内容不能覆盖')}}
 for(const v of next.versions){if(!next.knowledge.some(k=>k.id===v.knowledge))fail('知识条目不存在');const before=old.versions.find(x=>x.id===v.id);if(v.status==='现行'&&before?.status!=='现行'){if(!before||before.status!=='草稿')fail('请先保存草稿，再确认发布');const copy=structuredClone(old);Object.assign(copy.versions.find(x=>x.id===v.id),{content:v.content,change:v.change});knowledgeService.publish(copy,v.id);if(!equal(copy.versions.filter(x=>x.knowledge===v.knowledge),next.versions.filter(x=>x.knowledge===v.knowledge)))fail('发布内容不一致')}if(!before&&v.status!=='草稿')fail('新版本必须从草稿建立')}
}
const server=createServer(async(req,res)=>{
 const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))};
 try{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/calendar/feed.ics'){
  const secret=process.env.CALENDAR_TOKEN||'';const given=url.searchParams.get('token')||'';
  if(!secret||given.length!==secret.length||!timingSafeEqual(Buffer.from(hash(given),'hex'),Buffer.from(hash(secret),'hex')))return send(404,{error:'日历订阅未开启或订阅令牌无效'});
  const data=JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body);const cutoff=Date.now()-30*86400000;
  const list=data.sessions.filter(s=>!s.cancelled||new Date(s.start).getTime()>=cutoff);
  const text=toIcs(list.map(s=>sessionEvent(data,{...s,cancelled:s.cancelled||Boolean(s.archived)})),{calName:'核心方法排期（订阅）',reminderMinutes:30});
  res.writeHead(200,{'Content-Type':'text/calendar; charset=utf-8','Cache-Control':'max-age=300','X-Content-Type-Options':'nosniff'});res.end(text);return;
 }
 if(!url.pathname.startsWith('/api/')){const file=resolve('dist',url.pathname==='/'?'index.html':'.'+url.pathname);const root=resolve('dist');if(!file.startsWith(root+'/')&&!file.startsWith(root+'\\'))return send(404,{error:'页面不存在'});const actual=existsSync(file)?file:resolve(root,'index.html');res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png'})[extname(actual)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(readFileSync(actual));return}
 if(!['GET','HEAD'].includes(req.method)){const origin=req.headers.origin;const expected=publicOrigin||`http://${req.headers.host}`;if(origin!==expected)fail('请求来源不受支持',403);if(url.pathname!=='/api/files/upload'&&req.headers['content-type']?.split(';')[0]!=='application/json')fail('提交格式不支持',415)}
 if(url.pathname==='/api/files/upload'&&req.method==='POST'){const user=authenticate(req);await assets.upload(req,res,url,user,send);return}
 let body={};if(req.method!=='GET'){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4_000_000)fail('提交资料过大',413)}try{body=raw?JSON.parse(raw):{}}catch{fail('无法读取提交内容')}}
 const path=url.pathname;
 if(path==='/api/auth/status'&&req.method==='GET')return send(200,{needsSetup:!db.prepare('SELECT id FROM users').get()});
 if(path==='/api/auth/setup'&&req.method==='POST'){if(db.prepare('SELECT id FROM users').get())fail('管理员已建立',409);if(typeof body.code!=='string'||!timingSafeEqual(Buffer.from(hash(body.code.replace(/[\s\u200b-\u200d\ufeff]/g,'')),'hex'),Buffer.from(hash(setupCode),'hex')))fail('首次设置码不正确',403);createUser({...body,role:'admin'});db.prepare('DELETE FROM bootstrap').run();return send(201,{ok:true})}
 if(path==='/api/auth/login'&&req.method==='POST'){
  const key=req.socket.remoteAddress;const entry=attempts.get(key)||{count:0,until:0};if(entry.until>Date.now())fail('尝试次数过多，请 15 分钟后再试',429);
  const u=db.prepare('SELECT * FROM users WHERE username=?').get(String(body.username||''));const derived=scryptSync(String(body.password||'').slice(0,128),u?.salt||'missing-user-salt',64);const valid=timingSafeEqual(derived,Buffer.from(u?.hash||'00'.repeat(64),'hex'));
  if(!u||!valid||!u.active){entry.count++;if(entry.count>=5)entry.until=Date.now()+900000;attempts.set(key,entry);fail('账号或密码不正确，或账号已停用',401)}attempts.delete(key);
  const token=randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),u.id,Date.now()+8*3600000);res.setHeader('Set-Cookie',`km_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure?'; Secure':''}`);return send(200,{user:publicUser(u)})
 }
 const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('km_session='))?.slice(11);const session=token&&db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(hash(token),Date.now());const user=session&&db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(session.user);if(!user)fail('请先登录，或登录已过期',401);
 if(path==='/api/auth/me'&&req.method==='GET')return send(200,{user:publicUser(user)});
 if(path==='/api/calendar/feed'&&req.method==='GET'){
  const secret=process.env.CALENDAR_TOKEN||'';
  if(!secret)return send(200,{enabled:false});
  const base=(publicOrigin||`http://${req.headers.host}`).replace(/\/+$/,'');
  const qs='/calendar/feed.ics?token='+encodeURIComponent(secret);
  return send(200,{enabled:true,http:base+qs,webcal:'webcal://'+base.replace(/^https?:\/\//,'')+qs,reminderMinutes:30});
 }
 if(path==='/api/auth/logout'&&req.method==='POST'){db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token));res.setHeader('Set-Cookie',`km_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure?'; Secure':''}`);return send(200,{ok:true})}
 if(path==='/api/auth/password'&&req.method==='POST'){if(!timingSafeEqual(scryptSync(String(body.oldPassword||''),user.salt,64),Buffer.from(user.hash,'hex')))fail('当前密码不正确');const salt=randomBytes(16).toString('hex');db.prepare('UPDATE users SET salt=?,hash=? WHERE id=?').run(salt,scryptSync(password(body.password),salt,64).toString('hex'),user.id);db.prepare('DELETE FROM sessions WHERE user=?').run(user.id);return send(200,{ok:true})}
 if(path==='/api/users'){
  if(user.role!=='admin')fail('仅管理员可管理账号',403);
  if(req.method==='GET')return send(200,{users:db.prepare('SELECT * FROM users ORDER BY rowid').all().map(publicUser)});
  if(req.method==='POST'){createUser(body);return send(201,{ok:true})}
  if(req.method==='PATCH'){const target=db.prepare('SELECT * FROM users WHERE id=?').get(body.id);if(!target)fail('账号不存在');if(target.id===user.id)fail('不能停用当前管理员');if(target.role==='admin'&&db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get().n<=1)fail('必须保留一位管理员');db.prepare('UPDATE users SET active=? WHERE id=?').run(body.active?1:0,body.id);db.prepare('DELETE FROM sessions WHERE user=?').run(body.id);return send(200,{ok:true})}
 }
 if(recordArchive(req,res,url,user,body,send))return;
 if(await assets.route(req,res,url,user,body,send))return;
 if(path==='/api/data'&&req.method==='GET')return send(200,db.prepare('SELECT revision,body FROM state WHERE id=1').get());
 if(path==='/api/data'&&req.method==='PUT'){const row=db.prepare('SELECT revision,body FROM state WHERE id=1').get();if(body.revision!==row.revision)fail('其他成员已更新资料，请刷新后重新操作',409);validateChange(JSON.parse(row.body),body.data,user);db.prepare('UPDATE state SET revision=revision+1,body=? WHERE id=1').run(JSON.stringify(body.data));db.prepare('INSERT INTO audit(time,user,action) VALUES(?,?,?)').run(new Date().toISOString(),user.id,'save');return send(200,{revision:row.revision+1})}
 if(path==='/api/data/reset'&&req.method==='POST'){if(user.role!=='admin')fail('仅管理员可以重置资料',403);const row=db.prepare('SELECT revision FROM state WHERE id=1').get();const data=normalizeDb(seed());db.prepare('UPDATE state SET revision=revision+1,body=? WHERE id=1').run(JSON.stringify(data));return send(200,{data,revision:row.revision+1})}
 send(404,{error:'未找到此操作'});
 }catch(e){const status=e.status||400;send(status,{error:status>=500&&!e.expose?'保存失败，请稍后重试':e.message,...(e.expose&&e.code?{code:e.code}:{})})}
});
server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`服务已启动：http://127.0.0.1:${port}`));
