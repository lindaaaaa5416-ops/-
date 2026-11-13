import {spawn} from 'node:child_process';
import {mkdirSync,openSync,closeSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const logs=join(root,'runtime-logs');mkdirSync(logs,{recursive:true});
async function ready(url){try{const response=await fetch(url,{signal:AbortSignal.timeout(2000)});const data=await response.json();return response.ok&&typeof data.needsSetup==='boolean'}catch{return false}}
function start(args,name,extra={}){const out=openSync(join(logs,name+'.log'),'a'),err=openSync(join(logs,name+'.error.log'),'a');try{const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,...extra},detached:true,windowsHide:true,stdio:['ignore',out,err]});child.on('error',e=>{console.error('启动失败：'+e.message);process.exitCode=1});child.unref()}finally{closeSync(out);closeSync(err)}}
async function wait(url){for(let i=0;i<15;i++){if(await ready(url))return true;await new Promise(resolve=>setTimeout(resolve,400))}return false}
if(!existsSync(join(root,'node_modules')))throw Error('依赖尚未安装，请在项目目录运行 npm ci。');
if(!existsSync(join(root,'dist/index.html')))throw Error('网页尚未构建，请先运行 npm run build。');
const api='http://127.0.0.1:3001/api/auth/status';
if(!await ready(api))start(['server.mjs'],'server',{HOST:'127.0.0.1',PORT:'3001'});
if(!await wait(api))throw Error('网站服务未启动，请查看 runtime-logs/server.error.log。已有资料未改动。');
const preview='http://127.0.0.1:5174/api/auth/status';
if(!await ready(preview))start(['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5174','--strictPort'],'preview');
console.log('网站已启动：http://127.0.0.1:3001/');
console.log(await wait(preview)?'原预览地址可继续使用：http://127.0.0.1:5174/':'预览端口不可用，请使用 3001 地址。');
console.log('网站在后台运行，关闭此启动窗口不会停止服务。重启电脑后需再次运行启动入口。');
