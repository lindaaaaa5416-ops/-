// Run explicitly: node integration-smoke.mjs qwen | notification
// Each command makes one real external request using non-business test text.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {requestQwen} from './qwen-service.mjs';
import {sendNotification} from './notification-service.mjs';

const mode=process.argv[2];
if(!['qwen','notification'].includes(mode)){
 console.log('用法：node integration-smoke.mjs qwen 或 node integration-smoke.mjs notification');
 process.exitCode=1;
}else{
 const configFile=join(dirname(fileURLToPath(import.meta.url)),'.env.local');
 try{
  if(existsSync(configFile))process.loadEnvFile(configFile);
  if(mode==='qwen'){
   console.log('将发送一条非业务测试文本到千问；可能产生少量 API 费用。');
   await requestQwen({json:false,systemPrompt:'这是连通性测试。只回复“连接成功”。',userPrompt:'请确认可以接收测试请求。'});
   console.log('成功：千问 API 返回了可用文本。下一步在网站验证工具调用。');
  }else{
   console.log('将向配置的团队群发送一条明确标注的测试消息。');
   const result=await sendNotification({status:'接入测试',summary:'这是一条网站接入测试消息，不包含课程或学员资料。',taskId:'manual-setup-test'});
   console.log(result.status+'：'+result.message);
   if(result.status!=='sent')process.exitCode=1;
  }
 }catch(e){
  console.error(e.expose?e.message:'测试未完成，请检查配置文件格式和网络。未显示密钥或服务端原始错误。');
  process.exitCode=1;
 }
}
