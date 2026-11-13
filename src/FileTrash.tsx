import {useState} from 'react';
import {request} from './api';
export function FileTrash({onChanged}:{onChanged:()=>Promise<void>}){
 const [open,setOpen]=useState(false),[files,setFiles]=useState<{id:string;name:string;deleted_at:string}[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=async()=>{setFiles((await request('/files/trash')).files)};
 return <><button onClick={async()=>{setOpen(true);setError('');try{await load()}catch(e){setError((e as Error).message)}}}>文件回收站</button>{open&&<div className="overlay"><section className="modal wide" role="dialog" aria-modal="true" aria-label="文件回收站"><div className="modalhead"><h2>文件回收站</h2><button disabled={busy} onClick={()=>setOpen(false)}>关闭</button></div><div className="modalbody"><p className="notice">移入此处的原文件会保留，可由管理员恢复。此前已物理删除的文件不在此处。</p>{error&&<p role="alert" className="warning">{error}</p>}{files.map(f=><div className="uploaditem" key={f.id}><span>{f.name}<small>{new Date(f.deleted_at).toLocaleString('zh-CN')}</small></span><button disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await request('/files/'+f.id+'/restore','POST',{});await load();await onChanged()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>恢复</button></div>)}{!files.length&&<p className="empty">回收站为空</p>}</div></section></div>}</>;
}
