import {parseTags} from './asset-intelligence.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {requestQwen} from './qwen-service.mjs';
import {sendNotification} from './notification-service.mjs';
import {createDocumentPipeline,validateDocumentResult} from './agent-pipeline.mjs';

test('Qwen JSON, authorization, rate limits and malformed results',async()=>{
 const config={DASHSCOPE_API_KEY:'fake-key'};
 const ask=(response)=>requestQwen({systemPrompt:'提取 JSON',userPrompt:'测试正文',config,fetchImpl:async(url,options)=>{
  assert.deepEqual(JSON.parse(options.body).response_format,{type:'json_object'});
  assert.equal(options.redirect,'error');return response;
 }});
 assert.deepEqual((await ask({ok:true,json:async()=>({choices:[{message:{content:'{"summary":"测试"}'}}]})})).data,{summary:'测试'});
 for(const [code,status,expected] of [['AccessDenied.Unpurchased',403,'AccessDenied.Unpurchased'],['Model.AccessDenied',403,'Model.AccessDenied'],['Arrearage',400,'AI_BALANCE'],['x',429,'AI_RATE_LIMIT']]){
  await assert.rejects(ask({ok:false,status,json:async()=>({error:{code}})}),e=>e.code===expected&&!e.message.includes('fake-key'));
 }
 await assert.rejects(ask({ok:true,json:async()=>({choices:[{message:{content:'not json'}}]})}),e=>e.code==='AI_INVALID_JSON');
 assert.throws(()=>validateDocumentResult({category:'随意分类',tags:[],summary:''}),/格式/);
});

test('Webhook payloads, signing, platform rejection and missing config',async()=>{
 for(const provider of ['feishu','dingtalk']){
  const config={NOTIFICATION_PROVIDER:provider,NOTIFICATION_SECRET:'fake-secret',NOTIFICATION_WEBHOOK:provider==='feishu'?'https://open.feishu.cn/open-apis/bot/v2/hook/fake':'https://oapi.dingtalk.com/robot/send?access_token=fake'};
  const result=await sendNotification({status:'完成',summary:'摘要',taskId:'test',config,now:()=>1700000000000,fetchImpl:async(url,options)=>{
   const body=JSON.parse(options.body);
   if(provider==='feishu'){assert.ok(body.sign);assert.equal(body.timestamp,'1700000000');assert.equal(body.card.schema,'2.0');assert.equal(body.card.header.title.content,'AI 资料处理');assert.match(body.card.body.elements[0].content,/摘要/)}
   else {assert.ok(new URL(url).searchParams.get('sign'));assert.match(body.markdown.text,/摘要/)}
   return {ok:true,json:async()=>provider==='feishu'?{code:0}:{errcode:0}};
  }});assert.equal(result.status,'sent');
  assert.equal((await sendNotification({status:'完成',summary:'摘要',taskId:'test',config,fetchImpl:async()=>({ok:true,json:async()=>({code:1,errcode:1})})})).status,'failed');
 }
 assert.equal((await sendNotification({config:{}})).status,'skipped');
});

test('pipeline permission, JSON validation, transaction, manual tags, idempotency, failed notification',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE users(id TEXT,active INTEGER,role TEXT,teacher TEXT);INSERT INTO users VALUES('u',1,'admin','');
 CREATE TABLE files(id TEXT,tags TEXT,summary TEXT);INSERT INTO files VALUES('f','[{"label":"人工标签","source":"manual"}]','');
 CREATE TABLE audit(time TEXT,user TEXT,action TEXT);
 CREATE TABLE agent_jobs(id TEXT,owner TEXT,title TEXT,task TEXT,instruction TEXT,sources TEXT,result TEXT,created TEXT,requestKey TEXT,mode TEXT);`);
 const user={id:'u',role:'admin',teacher:''};let calls=0,notices=0;
 const lookup=id=>{const f=db.prepare('SELECT * FROM files WHERE id=?').get(id);return f?{...f,name:'test.txt'}:null};
 const fail=(message,status=400)=>{throw Object.assign(Error(message),{status})};
 const route=createDocumentPipeline({db,dir:'.',fail,lookup,canEdit:(_,u)=>u.role==='admin',usage:{add(){}},summary:f=>f,extract:async()=> '【段落 1】测试资料',agent:async({registry})=>{calls++;await registry.execute('save_document_summary',{category:'方法文档',tags:['人工标签','主题'],summary:'摘要【段落 1】'});await registry.execute('send_webhook_notification',{});return {content:'已保存；通知失败'}},notify:async()=>{notices++;return {status:'failed',message:'测试通知失败'}}});
 const body={id:'f',requestKey:'request-key-00001',consent:true,notify:true};
 const call=async(u=user,b=body)=>{let result;await route({method:'POST'},null,new URL('http://local/api/agent/process-document'),u,b,(_,r)=>{result=r});return result};
 try {
  await assert.rejects(call({...user,role:'teacher'}),e=>e.status===403);
  await assert.rejects(call(user,{...body,consent:false}),/确认/);
  const result=await call();assert.equal(result.task.status,'succeeded');assert.equal(result.task.notification.status,'failed');
  const tags=parseTags(lookup('f').tags);assert.deepEqual(tags,[{label:'人工标签',source:'manual'},{label:'主题',source:'ai'}]);
  await call();assert.equal(calls,1);assert.equal(notices,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_jobs').get().n,1);
  await assert.rejects(call(user,{...body,notify:false}),e=>e.status===409);
 }finally{db.close()}
});


test('invalid JSON schema cannot modify files, failed tasks stay visible',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE audit(time TEXT,user TEXT,action TEXT)");
 const fail=(message,status=400)=>{throw Object.assign(Error(message),{status})};
 const route=createDocumentPipeline({db,dir:'.',fail,lookup:()=>({id:'f',name:'fake.txt',tags:'[]',summary:'original'}),canEdit:()=>true,summary:f=>f,usage:{add(){throw Error('must not write')}},extract:async()=> 'fake',agent:async({registry})=>registry.execute('save_document_summary',{category:'invalid'}),notify:async()=>{throw Error('must not notify')}});
 try {
  await assert.rejects(route({method:'POST'},null,new URL('http://local/api/agent/process-document'),{id:'u',role:'admin'},{id:'f',requestKey:'failed-request-001',notify:false,consent:true},()=>{}),e=>e.code==='AI_SCHEMA');
  const row=db.prepare('SELECT * FROM document_tasks').get();assert.equal(row.status,'failed');assert.equal(row.result,null);
 }finally{db.close()}
});


test('Feishu errors identify remediation without exposing platform response secrets',async()=>{
 for(const [code,hint] of [[19021,'签名'],[19022,'白名单'],[19024,'关键词'],[9499,'参数']]){
  const result=await sendNotification({status:'测试',summary:'摘要',taskId:'test',config:{NOTIFICATION_PROVIDER:'feishu',NOTIFICATION_WEBHOOK:'https://open.feishu.cn/open-apis/bot/v2/hook/fake'},fetchImpl:async()=>({ok:true,status:200,json:async()=>({code,msg:'secret-should-not-be-printed'})})});
  assert.equal(result.status,'failed');assert.match(result.message,new RegExp(hint));assert.match(result.message,new RegExp(String(code)));assert.ok(!result.message.includes('secret-should-not-be-printed'));
 }
});
