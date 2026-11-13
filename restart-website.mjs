import {execFileSync,spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
if(process.platform!=='win32'){console.error('请停止当前服务后在项目目录重新运行 npm start。');process.exit(1)}
const script="$p=Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -First 1; if($p){$proc=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$p.OwningProcess); if($proc.Name -ne 'node.exe' -or $proc.CommandLine -notmatch 'server\\.mjs'){throw '3001 端口并非本网站服务，未停止其他程序。'}; Stop-Process -Id $proc.ProcessId}";
try{execFileSync('powershell.exe',['-NoProfile','-Command',script],{stdio:'inherit'});const result=spawnSync(process.execPath,[join(root,'start-website.mjs')],{cwd:root,stdio:'inherit'});if(result.status!==0)process.exit(result.status||1)}catch{console.error('重启失败，请查看提示并检查网站服务。');process.exit(1)}
