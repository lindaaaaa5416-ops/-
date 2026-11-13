import {useState} from 'react';
import {request} from './api';
type Props={kind:'profile'|'session';onChanged:()=>Promise<void>};
export function RecordDelete({kind,id,name,onChanged}:Props&{id:string;name:string}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <><button className="link danger" onClick={()=>setOpen(true)}>删除</button>{open&&<div className="overlay"><section className="modal" role="dialog" aria-modal="true" aria-label="确认删除"><div className="modalhead"><h2>确认删除{kind==='profile'?'档案':'场次'}</h2></div><div className="modalbody"><p>确定删除「{name}」？</p><p className="notice">删除后从日常列表隐藏，可在“已删除记录”恢复。历史关联、出席、复盘和原文件不会清除。{kind==='session'?'该场次占用的老师和场地将释放。':''}</p>{error&&<p role="alert">{error}</p>}</div><div className="modalfooter"><button disabled={busy} onClick={()=>setOpen(false)}>取消</button><button className="primary" disabled={busy} onClick={async()=>{setBusy(true);try{await request(`/record-archive/${kind}/${id}/delete`,'POST',{confirm:true});await onChanged();setOpen(false)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>{busy?'处理中…':'确认删除'}</button></div></section></div>}</>;
}
export function RecordRecycleBin({kind,onChanged}:Props){
 const [open,setOpen]=useState(false),[records,setRecords]=useState<{id:string;name:string}[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const load=async()=>setRecords((await request('/record-archive?kind='+kind)).records);
 return <><button onClick={async()=>{setOpen(true);setError('');try{await load()}catch(e){setError((e as Error).message)}}}>已删除记录</button>{open&&<div className="overlay"><section className="modal wide" role="dialog" aria-modal="true" aria-label="已删除记录"><div className="modalhead"><h2>已删除{kind==='profile'?'档案':'场次'}</h2><button disabled={busy} onClick={()=>setOpen(false)}>关闭</button></div><div className="modalbody">{error&&<p className="warning" role="alert">{error}</p>}{records.map(r=><div className="uploaditem" key={r.id}><span>{r.name}</span><button disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await request(`/record-archive/${kind}/${r.id}/restore`,'POST',{confirm:true});await load();await onChanged()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>恢复</button></div>)}{!records.length&&<p className="empty">暂无已删除记录</p>}</div></section></div>}</>;
}
