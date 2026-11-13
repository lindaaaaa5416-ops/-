import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runQwenAgent,requestQwen} from './qwen-service.mjs';
import {createToolRegistry,send_webhook_notification} from './agent-tools.mjs';
import {createDocumentPipeline} from './agent-pipeline.mjs';
import {DatabaseSync} from 'node:sqlite';

const call=(id,name,args)=>({id,type:'function',function:{name,arguments:typeof args==='string'?args:JSON.stringify(args)}});
const reply=(calls,content=null)=>({message:{role:'assistant',content,...(calls?{tool_calls:calls}:{})}});

test('HTTP request accepts null tool-call content and sends official tools/tool_choice fields',async()=>{
 const result=await requestQwen({messages:[{role:'user',content:'保存摘要'}],tools:[{type:'function',function:{name:'save',parameters:{type:'object',properties:{}}}}],toolChoice:{type:'function',function:{name:'save'}},config:{DASHSCOPE_API_KEY:'fake'},fetchImpl:async(_,options)=>{
  const body=JSON.parse(options.body);assert.equal(body.tool_choice.function.name,'save');assert.equal(body.tools[0].type,'function');assert.equal(body.response_format,undefined);assert.equal(body.model,'qwen3.8-flash');assert.equal(body.enable_thinking,false);
  return {ok:true,json:async()=>({choices:[{message:{role:'assistant',content:null,tool_calls:[call('1','save',{})]},finish_reason:'tool_calls'}]})};
 }});assert.equal(result.message.tool_calls[0].id,'1');
});

test('Agent loop serializes multi-call results, caches duplicate IDs and returns final text',async()=>{
 let n=0;const executed=[];
 const result=await runQwenAgent({systemPrompt:'测试',userPrompt:'执行',registry:{tools:[],execute:async(name)=>{executed.push(name);return {saved:true}}},request:async({messages,toolChoice})=>{
  assert.equal(toolChoice,'auto');n++;
  if(n===1)return reply([call('1','save',{}),call('2','notify',{})]);
  if(n===2){assert.deepEqual(messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id),['1','2']);return reply([call('1','save',{})])}
  return reply(null,'已完成');
 }});
 assert.deepEqual(executed,['save','notify']);assert.equal(result.content,'已完成');assert.equal(result.turns,3);
});

test('invalid arguments and unknown tools return bounded errors; loops and reused IDs stop',async()=>{
 let n=0;
 await runQwenAgent({systemPrompt:'s',userPrompt:'u',registry:{tools:[],execute:async()=>{throw Object.assign(Error('未注册'),{expose:true,code:'TOOL_UNKNOWN'})}},request:async({messages})=>{
  if(n++===0)return reply([call('1','unknown','{broken'),call('2','unknown',{})]);
  const errors=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content).code);
  assert.deepEqual(errors,['TOOL_INVALID_JSON','TOOL_UNKNOWN']);return reply(null,'执行失败');
 }});
 const registry={tools:[],execute:async()=>({})};
 await assert.rejects(runQwenAgent({systemPrompt:'s',userPrompt:'u',registry,maxTurns:2,request:async()=>reply([call('1','x',{})])}),e=>e.code==='AGENT_LIMIT');
 n=0;await assert.rejects(runQwenAgent({systemPrompt:'s',userPrompt:'u',registry,request:async()=>reply([call('1','x',{n:n++})])}),e=>e.code==='AGENT_PROTOCOL');
 const noNotify=createToolRegistry({allowNotify:false});
 assert.equal(noNotify.tools.length,1);await assert.rejects(noNotify.execute('send_webhook_notification',{}),e=>e.code==='TOOL_UNKNOWN');
 const context={user:{id:'u',role:'admin',teacher:''},file:{id:'f'},db:{prepare:()=>({get:()=>({role:'admin',teacher:''})})},lookup:()=>({}),canEdit:()=>true,allowNotify:true};
 await assert.rejects(send_webhook_notification({},context),e=>e.code==='TOOL_ORDER');
});

test('real loop + tools + pipeline saves once, notifies once, handles post-save model failure',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE users(id TEXT,active INTEGER,role TEXT,teacher TEXT);INSERT INTO users VALUES('u',1,'admin','');
 CREATE TABLE files(id TEXT,tags TEXT,summary TEXT);INSERT INTO files VALUES('f','[]','');
 CREATE TABLE audit(time TEXT,user TEXT,action TEXT);
 CREATE TABLE agent_jobs(id TEXT,owner TEXT,title TEXT,task TEXT,instruction TEXT,sources TEXT,result TEXT,created TEXT,requestKey TEXT,mode TEXT);`);
 const lookup=id=>{const f=db.prepare('SELECT * FROM files WHERE id=?').get(id);return f?{...f,name:'sample.txt'}:null};
 let notices=0,n=0,requests=0;
 const route=createDocumentPipeline({db,dir:'.',fail:(message,status=400)=>{throw Object.assign(Error(message),{status})},lookup,canEdit:()=>true,usage:{add(){}},summary:f=>f,extract:async()=> '测试',notify:async()=>{notices++;return {status:'sent',message:'测试成功'}},agent:args=>runQwenAgent({...args,request:async()=>{
  requests++;
  if(n++===0)return reply([call('1','save_document_summary',{category:'方法文档',tags:['主题'],summary:'摘要'}),call('2','send_webhook_notification',{}),call('3','send_webhook_notification',{})]);
  throw Object.assign(Error('模型超时'),{expose:true,code:'AI_TIMEOUT',status:504});
 }})});
 const body={id:'f',requestKey:'integration-key-001',consent:true,notify:true};let result;
 const invoke=()=>route({method:'POST'},null,new URL('http://local/api/agent/process-document'),{id:'u',role:'admin',teacher:''},body,(_,r)=>{result=r});
 try{
  await invoke();assert.equal(result.task.status,'succeeded');assert.equal(result.task.error,'模型超时');assert.equal(result.task.notification.status,'sent');assert.equal(lookup('f').summary,'摘要');
  await invoke();assert.equal(notices,1);assert.equal(requests,2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_jobs').get().n,1);
 }finally{db.close()}
});

test('explicit notification runs even when model omits tool, without repeating requests',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE users(id TEXT,active INTEGER,role TEXT,teacher TEXT);INSERT INTO users VALUES('u',1,'admin','');
 CREATE TABLE files(id TEXT,tags TEXT,summary TEXT);INSERT INTO files VALUES('f','[]','');
 CREATE TABLE audit(time TEXT,user TEXT,action TEXT);
 CREATE TABLE agent_jobs(id TEXT,owner TEXT,title TEXT,task TEXT,instruction TEXT,sources TEXT,result TEXT,created TEXT,requestKey TEXT,mode TEXT);`);
 const lookup=id=>{const f=db.prepare('SELECT * FROM files WHERE id=?').get(id);return f?{...f,name:'sample.txt'}:null};
 let notices=0,result;
 const route=createDocumentPipeline({db,dir:'.',fail:message=>{throw Error(message)},lookup,canEdit:()=>true,usage:{add(){}},summary:f=>f,extract:async()=> 'test',notify:async()=>{notices++;return {status:'sent',message:'sent'}},agent:async({registry})=>{await registry.execute('save_document_summary',{category:'方法文档',tags:['主题'],summary:'摘要'});return {content:'done'}}});
 const invoke=(key,notify)=>route({method:'POST'},null,new URL('http://local/api/agent/process-document'),{id:'u',role:'admin',teacher:''},{id:'f',requestKey:key,consent:true,notify},(_,r)=>{result=r});
 try{
  await invoke('fallback-notify-001',true);assert.equal(result.task.notification.status,'sent');assert.equal(notices,1);
  await invoke('fallback-notify-001',true);assert.equal(notices,1);
  await invoke('fallback-notify-002',false);assert.equal(result.task.notification.status,'skipped');assert.equal(notices,1);
 }finally{db.close()}
});
