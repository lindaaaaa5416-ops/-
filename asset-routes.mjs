import {createFileTrash} from './file-trash.mjs';
import {DIMENSIONS,VOCAB} from './tag-vocabulary.mjs';
import {createDocumentPipeline} from './agent-pipeline.mjs';
import {tagFile,parseTags,patchManualTags,semanticQuery} from './asset-intelligence.mjs';
import {extractDocument,summarizeWithQwen} from './qwen-service.mjs';
import {usageStore} from './usage-store.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {open,unlink,readFile} from 'node:fs/promises';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
export function createAssetRoutes({db,dir,fail}){
 const folder=join(dir,'uploads');mkdirSync(folder,{recursive:true});
 db.exec(`CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,name TEXT,type TEXT,size INTEGER,digest TEXT,category TEXT,session TEXT,person TEXT,knowledge TEXT,notes TEXT,owner TEXT,created TEXT,removed INTEGER DEFAULT 0,requestKey TEXT); CREATE UNIQUE INDEX IF NOT EXISTS upload_request ON files(owner,requestKey); CREATE TABLE IF NOT EXISTS agent_jobs(id TEXT PRIMARY KEY,owner TEXT,title TEXT,task TEXT,instruction TEXT,sources TEXT,result TEXT,created TEXT,requestKey TEXT); CREATE UNIQUE INDEX IF NOT EXISTS agent_request ON agent_jobs(owner,requestKey);`);
 if(!db.prepare('PRAGMA table_info(agent_jobs)').all().some(x=>x.name==='mode'))db.exec("ALTER TABLE agent_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'demo'");
 for(const [name,sql] of [['tags',"ALTER TABLE files ADD COLUMN tags TEXT DEFAULT '[]'"],['summary',"ALTER TABLE files ADD COLUMN summary TEXT DEFAULT ''"]])if(!db.prepare('PRAGMA table_info(files)').all().some(x=>x.name===name))db.exec(sql);
 const persistTags=(f,result,user,action)=>{const latest=lookup(f.id);if(!latest||!canEdit(latest,user))fail('资料已移除或权限已变化');if(!db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(user.id))fail('账号已停用',401);let tags=result.tags;if(action!=='tag-manual'){const manual=parseTags(latest.tags).filter(t=>t.source==='manual');tags=[...manual,...tags.filter(t=>!manual.some(m=>m.label===t.label))].slice(0,12)}db.prepare('UPDATE files SET tags=?,summary=? WHERE id=?').run(JSON.stringify(tags),result.summary,f.id);db.prepare('INSERT INTO audit(time,user,action) VALUES(?,?,?)').run(new Date().toISOString(),user.id,action+':'+f.id)};
 const usage=usageStore(db);
 const state=()=>JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body);
 const lookup=id=>db.prepare('SELECT * FROM files WHERE id=? AND removed=0').get(id);
 const canEdit=(f,user)=>user.role!=='teacher'||(f.owner===user.id&&(!f.session||state().sessions.some(s=>s.id===f.session&&s.teacher===user.teacher)));
 const summary=f=>({...f,tags:parseTags(f.tags),summary:f.summary||'',ownerName:db.prepare('SELECT name FROM users WHERE id=?').get(f.owner)?.name||'成员'});
 const inflight=new Map();
 const categories=['课程资料','方法文档','学员产出','照片记录','其他资料'];
 async function readSource(f){if(!/\.(txt|md|csv)$/i.test(f.name))return null;if(f.size>200000)return null;return (await readFile(join(folder,f.id))).toString('utf8')}
 const trashRoute=createFileTrash({db,fail,canEdit,lookup});
 const processDocument=createDocumentPipeline({db,dir,fail,canEdit,lookup,usage,summary});
 return {
 async upload(req,res,url,user,send){
  const q=url.searchParams;const name=(q.get('name')||'').trim();const category=q.get('category')||'课程资料';const sid=q.get('session')||'',person=q.get('person')||'',knowledge=q.get('knowledge')||'',notes=(q.get('notes')||'').trim();const requestKey=req.headers['x-upload-key'];
  if(!name||name.length>180||/[\x00-\x1f/\\]/.test(name))fail('文件名无效或过长');if(!/\.(pdf|doc|docx|ppt|pptx|xls|xlsx|txt|md|csv|png|jpg|jpeg|webp|zip)$/i.test(name))fail('暂不支持该文件类型');if(!categories.includes(category))fail('请选择有效分类');if(notes.length>2000)fail('资料说明最多 2000 字');if(typeof requestKey!=='string'||!/^[\w-]{16,80}$/.test(requestKey))fail('请重新选择文件后上传');
  const existing=db.prepare('SELECT * FROM files WHERE owner=? AND requestKey=? AND removed=0').get(user.id,requestKey);if(existing){req.resume();return send(200,{file:summary(existing),duplicate:true})}
  const data=state();const s=data.sessions.find(s=>s.id===sid);if(sid&&!s)fail('关联课程不存在');if(person&&(!s||!s.people.includes(person)))fail('请选择本场课程的参与人');if(category==='学员产出'&&(!sid||!person))fail('学员产出必须关联课程和具体参与人');if(knowledge&&!data.knowledge.some(k=>k.id===knowledge))fail('关联知识条目不存在');if(user.role==='teacher'&&sid&&s.teacher!==user.teacher)fail('只能为自己负责的课程上传资料',403);
  const id=randomUUID();let size=0;let oversized=false;const digest=createHash('sha256');let handle;let committed=false;
  try{
   handle=await open(join(folder,id),'wx');for await(const chunk of req){size+=chunk.length;if(size>20*1024*1024){oversized=true;continue}digest.update(chunk);await handle.writeFile(chunk)}await handle.close();handle=null;if(oversized)fail('单个文件不能超过 20 MB',413);if(!size)fail('不能上传空文件');if(req.aborted)fail('上传已取消');
   // Recheck account and associations after streaming, then commit file metadata and course registration together.
   if(!db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(user.id))fail('账号已停用',401);
   const latest=state();const course=latest.sessions.find(x=>x.id===sid);if(sid&&(!course||(person&&!course.people.includes(person))))fail('课程或参与人已变化，请刷新后上传');if(user.role==='teacher'&&sid&&course.teacher!==user.teacher)fail('该课程已不再由你负责',403);
   const sha=digest.digest('hex');const duplicate=db.prepare('SELECT * FROM files WHERE digest=? AND name=? AND owner=? AND category=? AND session=? AND person=? AND knowledge=? AND removed=0').get(sha,name,user.id,category,sid,person,knowledge);if(duplicate)return send(200,{file:summary(duplicate),duplicate:true});
   const type=(req.headers['content-type']||'application/octet-stream').slice(0,150);const created=new Date().toISOString();
   db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO files(id,name,type,size,digest,category,session,person,knowledge,notes,owner,created,removed,requestKey) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?)').run(id,name,type,size,sha,category,sid,person,knowledge,notes,user.id,created,requestKey);
    if(sid){latest.materials.push({id,storedFile:true,session:sid,category:category==='课程资料'?(q.get('courseCategory')==='课上 PPT'?'课上 PPT':'课前准备资料'):category==='学员产出'?'学员产出':category==='照片记录'?'照片记录':'课前准备资料',person,name,size,type});db.prepare('UPDATE state SET revision=revision+1,body=? WHERE id=1').run(JSON.stringify(latest))}
    if(sid)usage.add({file:lookup(id),user,kind:'course',target:sid,targetName:course.name,created});if(knowledge)usage.add({file:lookup(id),user,kind:'knowledge',target:knowledge,targetName:latest.knowledge.find(k=>k.id===knowledge).name,created});
    db.prepare('INSERT INTO audit(time,user,action) VALUES(?,?,?)').run(created,user.id,'upload:'+id);db.exec('COMMIT');committed=true;
   }catch(e){db.exec('ROLLBACK');throw e}
   return send(201,{file:summary(lookup(id)),duplicate:false});
  }finally{if(handle)await handle.close();if(!committed)await unlink(join(folder,id)).catch(()=>{})}
 },
 async route(req,res,url,user,body,send){
  if(await trashRoute(req,res,url,user,body,send))return true;
  if(url.pathname==='/api/files/tag-vocabulary'&&req.method==='GET'){send(200,{groups:DIMENSIONS.map(d=>({name:d.key,tags:VOCAB[d.key].map(t=>d.key+':'+t)}))});return true}
  if(await processDocument(req,res,url,user,body,send))return true;
  const path=url.pathname;
  if(path==='/api/file-usage'&&req.method==='GET'){send(200,usage.list(url,user));return true}
  if(path==='/api/files'&&req.method==='GET'){const stats=usage.summaries(user);send(200,{files:db.prepare('SELECT * FROM files WHERE removed=0 ORDER BY created DESC').all().map(f=>({...summary(f),usage:stats[f.id]||{count:0,people:[],latest:''}}))});return true}
  if(path==='/api/files/tag'&&req.method==='POST'){
   const f=lookup(String(body.id||''));if(!f)fail('资料不存在或已移除',404);if(!canEdit(f,user))fail('没有权限修改该资料标签',403);
   const result=await tagFile({file:f,folder,data:state()});persistTags(f,result,user,'tag');
   send(200,{file:summary(lookup(f.id)),...result});return true;
  }
  if(path==='/api/files/tag-batch'&&req.method==='POST'){
   if(Array.isArray(body.ids)&&body.ids.length>100)fail('一次最多处理100份资料');const rows=Array.isArray(body.ids)?body.ids.map(id=>lookup(String(id))).filter(Boolean):db.prepare("SELECT * FROM files WHERE removed=0 AND (tags='[]' OR tags IS NULL OR tags='')").all();
   let done=0,failed=0;const skipped=[];
   for(const f of rows.slice(0,100)){
    if(!canEdit(f,user)){failed++;skipped.push({id:f.id,reason:'无权限'});continue}
    try{const result=await tagFile({file:f,folder,data:state()});persistTags(f,result,user,'tag-batch');done++}
    catch(e){failed++;skipped.push({id:f.id,reason:String(e.message||'打标失败').slice(0,60)})}
   }
   send(200,{done,failed,total:rows.length,skipped});return true;
  }
  if(path==='/api/files/tags'&&req.method==='PATCH'){
   const f=lookup(String(body.id||''));if(!f)fail('资料不存在或已移除',404);if(!canEdit(f,user))fail('没有权限修改该资料标签',403);
   if((body.add!==undefined&&typeof body.add!=='string')||(body.remove!==undefined&&typeof body.remove!=='string'))fail('标签参数无效');
   const next=patchManualTags(parseTags(f.tags),{add:body.add,remove:body.remove});
   const result={tags:next,summary:f.summary||''};persistTags(f,result,user,'tag-manual');
   send(200,{file:summary(lookup(f.id)),ok:true});return true;
  }
  if(path==='/api/files/semantic-query'&&req.method==='POST'){
   const q=String(body.q||'');
   const rows=db.prepare('SELECT tags FROM files WHERE removed=0').all();
   const allLabels=[...new Set(rows.flatMap(r=>parseTags(r.tags).map(t=>t.label)))];
   send(200,await semanticQuery({q,allLabels,categories}));return true;
  }
  const match=path.match(/^\/api\/files\/([\w-]+)(?:\/(download|preview))?$/);
  if(match){const f=lookup(match[1]);if(!f)fail('资料不存在或已移除',404);
   if(req.method==='GET'&&match[2]==='download'){const bytes=await readFile(join(folder,f.id));res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,'Content-Length':bytes.length,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.once('finish',()=>{if(!res.destroyed||res.writableFinished){try{usage.add({file:f,user,kind:'download'})}catch(e){console.error('下载日志保存失败')}}});res.end(bytes);return true}
   if(req.method==='GET'&&match[2]==='preview'){const text=await readSource(f);usage.add({file:f,user,kind:'preview'});send(200,{file:summary(f),text,supported:text!==null});return true}
   if(req.method==='DELETE'&&!match[2]){if(!canEdit(f,user))fail('只能移除自己上传的资料',403);const data=state();data.materials=data.materials.filter(m=>m.id!==f.id);db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE files SET removed=1 WHERE id=?').run(f.id);db.prepare('UPDATE state SET revision=revision+1,body=? WHERE id=1').run(JSON.stringify(data));db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}await unlink(join(folder,f.id)).catch(()=>{});send(200,{ok:true});return true}
  }
  if(path==='/api/agent/status'&&req.method==='GET'){send(200,{configured:!!process.env.DASHSCOPE_API_KEY?.trim(),provider:'阿里云百炼'});return true}
  if(path==='/api/agent/summarize'&&req.method==='POST'){
   if(typeof body.requestKey!=='string'||!/^[\w-]{16,80}$/.test(body.requestKey))fail('请重新提交任务');if(body.consent!==true)fail('请先确认将所选资料发送给阿里云处理');if(!Array.isArray(body.files)||body.files.length!==1)fail('真实资料总结一次请选择一份资料');if(typeof body.instruction!=='string'||!body.instruction.trim()||body.instruction.length>4000)fail('请填写总结要求');
   const previous=db.prepare('SELECT * FROM agent_jobs WHERE owner=? AND requestKey=?').get(user.id,body.requestKey);if(previous){send(200,{job:{...previous,sources:JSON.parse(previous.sources)}});return true}const f=lookup(body.files[0]);if(!f)fail('所选资料已移除，请重新选择');const requestId=user.id+':'+body.requestKey;if(inflight.has(requestId)){send(200,{job:await inflight.get(requestId)});return true}
   const pending=(async()=>{const text=await extractDocument(join(folder,f.id),f.name);const generated=await summarizeWithQwen({name:f.name,text,instruction:body.instruction.trim()});if(!db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(user.id))fail('账号已停用',401);if(!lookup(f.id))fail('资料已移除，结果未保存');const id=randomUUID(),created=new Date().toISOString(),title=String(body.title||'资料摘要').trim().slice(0,100)||'资料摘要',sources=[{id:f.id,name:f.name,digest:f.digest,readable:true}];const result='阿里云模型生成 · 请人工核对原文及段落引用\n\n'+generated.content;db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO agent_jobs(id,owner,title,task,instruction,sources,result,created,requestKey,mode) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,user.id,title,'资料摘要',body.instruction.trim(),JSON.stringify(sources),result,created,body.requestKey,'qwen');usage.add({file:f,user,kind:'agent',target:id,targetName:title,created});db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}return{id,owner:user.id,title,task:'资料摘要',instruction:body.instruction.trim(),sources,result,created,mode:'qwen'}})();inflight.set(requestId,pending);try{send(201,{job:await pending})}finally{inflight.delete(requestId)}return true;
  }
  if(path==='/api/agent/jobs'&&req.method==='GET'){const rows=user.role==='teacher'?db.prepare('SELECT * FROM agent_jobs WHERE owner=? ORDER BY created DESC').all(user.id):db.prepare('SELECT * FROM agent_jobs ORDER BY created DESC').all();send(200,{jobs:rows.map(j=>({...j,sources:JSON.parse(j.sources)}))});return true}
  if(path==='/api/agent/jobs'&&req.method==='POST'){
   if(typeof body.requestKey!=='string'||!/^[\w-]{16,80}$/.test(body.requestKey))fail('请重新提交任务');const old=db.prepare('SELECT * FROM agent_jobs WHERE owner=? AND requestKey=?').get(user.id,body.requestKey);if(old){send(200,{job:{...old,sources:JSON.parse(old.sources)}});return true}
   if(!['资料摘要','课程准备','资料问答'].includes(body.task))fail('请选择任务类型');if(typeof body.instruction!=='string'||!body.instruction.trim()||body.instruction.length>4000)fail('请填写任务要求，最多 4000 字');if(!Array.isArray(body.files)||body.files.length<1||body.files.length>10||new Set(body.files).size!==body.files.length)fail('请选择 1—10 份资料');const files=body.files.map(lookup);if(files.some(f=>!f))fail('所选资料已移除，请重新选择');
   const sources=[];const excerpts=[];for(const f of files){const text=await readSource(f);sources.push({id:f.id,name:f.name,digest:f.digest,readable:text!==null});excerpts.push(`【${f.name}】\n${text!==null?'原文节选：\n'+text.slice(0,1800):'未解析文件正文；仅使用文件名称和用户填写的资料说明。'}${f.notes?'\n资料说明：'+f.notes:''}`)}
   const result=`演示生成 · 未连接真实 Agent\n\n任务：${body.task}\n你的要求：${body.instruction.trim()}\n\n资料依据\n${excerpts.join('\n\n')}\n\n${body.task==='课程准备'?'备课检查清单（固定模板）\n1. 人工确认课程目标与参与对象。\n2. 检查所选资料是否适用于本场课程。\n3. 根据原文选择讲解和练习内容。\n4. 核对资料版本及使用权限。':body.task==='资料问答'?'演示答复\n当前只展示可核对的原文和资料说明，不推断问题答案。连接真实 Agent 后，可根据所选资料生成有出处的回答。':'整理提示\n以上为原文节选与资料说明，未执行语义摘要。请人工提炼重点并核对来源。'}\n\n待补充：${files.filter((_,i)=>!sources[i].readable).length?'非文本资料的正文解析，以及任务要求涉及但资料中未明确的信息。':'任务要求涉及但原文中未明确的信息。'}\n此结果仅保存为任务记录，不会自动发布知识或改动课程。`;
   const id=randomUUID(),created=new Date().toISOString(),title=String(body.title||body.task).trim().slice(0,100)||body.task;db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO agent_jobs(id,owner,title,task,instruction,sources,result,created,requestKey) VALUES(?,?,?,?,?,?,?,?,?)').run(id,user.id,title,body.task,body.instruction.trim(),JSON.stringify(sources),result,created,body.requestKey);for(const f of files)usage.add({file:f,user,kind:'agent',target:id,targetName:title,created});db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}send(201,{job:{id,owner:user.id,title,task:body.task,instruction:body.instruction.trim(),sources,result,created}});return true;
  }
  return false;
 }
 }
}
