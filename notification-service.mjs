import {createHmac} from 'node:crypto';

// Webhook URLs and signing secrets are server configuration, never client input.
export async function sendNotification({status,summary,taskId,config=process.env,fetchImpl=fetch,now=Date.now}) {
 const provider=config.NOTIFICATION_PROVIDER;
 if(!provider||!config.NOTIFICATION_WEBHOOK)return {status:'skipped',message:'未配置通知渠道'};
 const failed=message=>({status:'failed',message});
 let url;
 try {url=new URL(config.NOTIFICATION_WEBHOOK)} catch {return failed('通知地址配置无效')}
 const valid=provider==='feishu'?url.hostname==='open.feishu.cn'&&/^\/open-apis\/bot\/v2\/hook\/[\w-]+$/.test(url.pathname):provider==='dingtalk'&&url.hostname==='oapi.dingtalk.com'&&url.pathname==='/robot/send'&&url.searchParams.has('access_token');
 if(!valid||url.protocol!=='https:'||url.username||url.password||url.port)return failed('请配置飞书或钉钉官方 HTTPS Webhook');
 const text=`### AI 资料处理\n\n状态：${String(status).slice(0,60)}\n\n任务：${taskId}\n\n${String(summary).slice(0,1800)}`;
 const payload=provider==='feishu'?{msg_type:'interactive',card:{schema:'2.0',header:{title:{tag:'plain_text',content:'AI 资料处理'}},body:{elements:[{tag:'markdown',content:text}]}}}:{msgtype:'markdown',markdown:{title:'AI 资料处理',text}};
 const secret=config.NOTIFICATION_SECRET;
 if(secret){
  if(provider==='feishu'){const timestamp=String(Math.floor(now()/1000));payload.timestamp=timestamp;payload.sign=createHmac('sha256',`${timestamp}\n${secret}`).update('').digest('base64')}
  else {const timestamp=String(now());url.searchParams.set('timestamp',timestamp);url.searchParams.set('sign',createHmac('sha256',secret).update(`${timestamp}\n${secret}`).digest('base64'))}
 }
 try {
  const response=await fetchImpl(url.href,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
  const data=await response.json();
  const code=provider==='feishu'?(data.code??data.StatusCode):data.errcode;
  if(!response.ok||code!==0){
   const hints=provider==='feishu'?{
    19021:'飞书签名校验失败或时间戳过期：请核对同一机器人的签名密钥、保存设置，并校准电脑时间',
    19022:'飞书 IP 白名单拒绝请求：请将服务器实际公网出口 IP 加入白名单',
    19024:'飞书关键词校验失败：请将机器人关键词设置为“AI 资料处理”并保存',
    9499:'飞书消息参数无效：请检查消息卡片格式与机器人地址'
   }:{};
   const safeCode=typeof code==='number'&&Number.isFinite(code)?String(code):'未返回数字错误码';
   return {...failed((hints[code]||'通知平台拒绝消息，请核对机器人是否有效、消息格式、安全设置或限流')+`（HTTP ${response.status||'未知'}，平台码 ${safeCode}）`),code:safeCode};
  }
  return {status:'sent',message:'通知已发送'};
 } catch {return failed('通知发送失败或超时；资料处理结果已保存，请先核对群消息，避免重复推送')}
}
