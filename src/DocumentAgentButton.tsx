import {useRef,useState} from 'react';
import {uuid} from './service';

type Result={task:{status:string;error?:string;result?:{category:string;summary:string};notification?:{status:string;message:string}}};
export function DocumentAgentButton({fileId,allowNotify=false,onChanged}:{fileId:string;allowNotify?:boolean;onChanged:()=>Promise<void>}) {
 const [open,setOpen]=useState(false),[consent,setConsent]=useState(false),[notify,setNotify]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Result|null>(null);
 const lock=useRef(false),requestKey=useRef(uuid());
 async function run(){
  if(lock.current||!consent)return;
  lock.current=true;setBusy(true);setError('');setResult(null);
  try {
   const response=await fetch('/api/agent/process-document',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:fileId,requestKey:requestKey.current,consent,notify})});
   const data=await response.json();
   if(!response.ok){
    if(response.status===401)window.dispatchEvent(new Event('session-expired'));
    // A known failed request can be retried with a fresh idempotency key.
    requestKey.current=uuid();
    throw Error(data.code==='AccessDenied.Unpurchased'?'AI 服务未开通或当前账号没有模型使用资格，请管理员检查百炼配置。':data.error||'AI 处理失败，请稍后重试');
   }
   setResult(data);
   if(data.task.error)setError('摘要已保存，但后续处理出错：'+data.task.error);
   if(data.task.status==='failed'){requestKey.current=uuid();throw Error(data.task.error||'AI 处理失败')}
   if(data.task.status==='running'){setError('任务仍在处理中；若服务曾重启，请刷新并核对任务记录后重新发起。');return}
   try{await onChanged()}catch{setError('处理结果已保存，但列表刷新失败，请手动刷新资料。')}
  } catch(e){setError(e instanceof Error?e.message:'无法连接服务，请核对任务记录后重试')}
  finally{lock.current=false;setBusy(false)}
 }
 return <><button className="link" onClick={()=>{setOpen(true);setError('')}}>提炼摘要与标签</button>{open&&<div className="overlay"><section className="modal" role="dialog" aria-modal="true" aria-label="提炼摘要与标签" aria-busy={busy}>
  <div className="modalhead"><h2>提炼摘要与标签</h2></div><div className="modalbody">
   <p>提取资料摘要和标签并保存，保留人工标签。分类仅作建议，不会改变原分类；请结合原文核对结果。</p>
   <label><input type="checkbox" checked={consent} disabled={busy||!!result} onChange={e=>setConsent(e.target.checked)}/>我确认将资料正文发送到阿里云百炼。</label>
   {allowNotify&&<label><input type="checkbox" checked={notify} disabled={busy||!!result} onChange={e=>{setNotify(e.target.checked);requestKey.current=uuid()}}/>处理成功后，将摘要发送到管理员配置的飞书或钉钉群。</label>}
   {busy&&<p role="status" aria-live="polite">正在读取资料、提炼摘要并保存，请稍候…</p>}
   {error&&<p className="warning" role="alert">{error}</p>}
   {result?.task.result&&<div role="status"><p><strong>资料整理：已保存</strong></p><p>分类建议：{result.task.result.category}</p><pre className="assetpreview">{result.task.result.summary}</pre><p className={result.task.notification?.status==='failed'?'warning':'notice'}>群通知：{result.task.notification?.status==='sent'?'已发送':result.task.notification?.status==='failed'?'未完成':'未发送'}。{result.task.notification?.message}</p></div>}
  </div><div className="modalfooter"><button disabled={busy} onClick={()=>setOpen(false)}>关闭</button><button className="primary" disabled={busy||!consent||result?.task.status==='succeeded'} onClick={()=>void run()}>{busy?'正在总结…':'开始整理'}</button></div>
 </section></div>}</>;
}
