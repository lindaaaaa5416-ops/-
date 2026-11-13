import {parseTags} from './asset-intelligence.mjs';
import {validateDocumentResult} from './document-result.mjs';
import {sendNotification} from './notification-service.mjs';

export const saveDocumentSummarySchema={type:'function',function:{
 name:'save_document_summary',description:'保存本次选定资料的分类建议、标签和核心摘要；保留人工标签，不改变业务分类。每个任务最多保存一次。',
 parameters:{type:'object',additionalProperties:false,required:['category','tags','summary'],properties:{
  category:{type:'string',enum:['课程资料','方法文档','学员产出','照片记录','其他资料']},
  tags:{type:'array',minItems:1,maxItems:8,items:{type:'string',minLength:1,maxLength:16}},
  summary:{type:'string',minLength:1,maxLength:1500,description:'中文摘要，重要结论引用【段落 N】'}
 }}
}};
export const sendWebhookNotificationSchema={type:'function',function:{
 name:'send_webhook_notification',description:'将本任务已保存的摘要通知到服务器配置的团队群。仅在用户已同意通知且保存成功后调用一次；不能指定地址或更改通知正文。',
 parameters:{type:'object',properties:{},required:[],additionalProperties:false}
}};
const deny=(message,code='TOOL_ARGUMENTS',status=400)=>{throw Object.assign(Error(message),{status,code,expose:true})};
const object=(args,keys)=>{
 if(!args||Array.isArray(args)||typeof args!=='object'||Object.keys(args).some(k=>!keys.includes(k)))deny('工具参数不符合声明的结构');
};

function authorize(c){
 const user=c.db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(c.user.id);
 const file=c.lookup(c.file.id);
 if(!user||!file||user.role!==c.user.role||user.teacher!==c.user.teacher||!c.canEdit(file,user))deny('资料或账号权限已变化','TOOL_FORBIDDEN',403);
 return file;
}

export async function save_document_summary(args,c){
 object(args,['category','tags','summary']);
 const result=validateDocumentResult(args);
 const file=authorize(c);
 if(c.savedResult){
  if(JSON.stringify(result)!==JSON.stringify(c.savedResult))deny('本任务已经保存，不能重复覆盖','TOOL_ALREADY_SAVED',409);
  return {saved:true,result:c.savedResult,reused:true};
 }
 if(file.tags!==c.file.tags||file.summary!==c.file.summary)deny('标签或摘要已被其他成员修改，请刷新后重试','TOOL_CONFLICT',409);
 const manual=parseTags(file.tags).filter(t=>t.source==='manual');
 const tags=[...manual,...result.tags.filter(label=>!manual.some(t=>t.label===label)).map(label=>({label,source:'ai'}))].slice(0,12);
 c.db.exec('BEGIN IMMEDIATE');
 try {
  c.db.prepare('UPDATE files SET tags=?,summary=? WHERE id=?').run(JSON.stringify(tags),result.summary,file.id);
  c.db.prepare("UPDATE document_tasks SET status='succeeded',result=? WHERE id=?").run(JSON.stringify(result),c.taskId);
  c.db.prepare('INSERT INTO agent_jobs(id,owner,title,task,instruction,sources,result,created,requestKey,mode) VALUES(?,?,?,?,?,?,?,?,?,?)').run(c.taskId,c.user.id,'资料分类与提炼','资料分类与提炼','工具调用：分类与摘要',JSON.stringify([{id:file.id,name:file.name,readable:true}]),JSON.stringify(result,null,2),c.created,'process:'+c.requestKey,'qwen');
  c.usage.add({file,user:c.user,kind:'agent',target:c.taskId,targetName:'资料分类与提炼',created:c.created});
  c.db.prepare('INSERT INTO audit(time,user,action) VALUES(?,?,?)').run(c.created,c.user.id,'agent-tool:save:'+file.id);
  c.db.exec('COMMIT');
 }catch(e){c.db.exec('ROLLBACK');throw e}
 c.savedResult=result;
 return {saved:true,result};
}

export async function send_webhook_notification(args,c){
 object(args,[]);authorize(c);
 if(!c.allowNotify||!['admin','operator'].includes(c.user.role))deny('用户未授权群通知','TOOL_FORBIDDEN',403);
 if(!c.savedResult)deny('请先成功保存摘要再通知','TOOL_ORDER',409);
 if(c.notificationPromise)return c.notificationPromise;
 // Cache the attempt, including an ambiguous timeout, to avoid duplicate messages.
 c.notificationPromise=(async()=>{
  let result;
  try{result=await (c.notify||sendNotification)({status:'处理完成',summary:c.savedResult.summary,taskId:c.taskId})}
  catch{result={status:'failed',message:'通知失败，摘要已保存；重试前请先核对群消息'}}
  c.db.prepare('UPDATE document_tasks SET notification=? WHERE id=?').run(JSON.stringify(result),c.taskId);
  c.notification=result;return result;
 })();
 return c.notificationPromise;
}

export function createToolRegistry(context){
 const entries=new Map([
  ['save_document_summary',{schema:saveDocumentSummarySchema,execute:save_document_summary}],
  ...(context.allowNotify?[['send_webhook_notification',{schema:sendWebhookNotificationSchema,execute:send_webhook_notification}]]:[])
 ]);
 return {
  tools:[...entries.values()].map(t=>t.schema),
  async execute(name,args){const tool=entries.get(name);if(!tool)deny('未注册或未授权的工具','TOOL_UNKNOWN');return tool.execute(args,context)}
 };
}
