import {request} from './api';
import React,{useState} from 'react';
import {fileService} from './asset-service';
import type {Asset} from './asset-service';

export function FileTags({file,editable,onChanged,onChoose,onOpenSummary}:{file:Asset;editable:boolean;onChanged:()=>Promise<void>;onChoose:(tag:string)=>void;onOpenSummary?:()=>void}){
 const [busy,setBusy]=useState(false),[custom,setCustom]=useState(''),[note,setNote]=useState(''),[showAll,setShowAll]=useState(false);
 const [groups,setGroups]=useState<{name:string;tags:string[]}[]>([]);
 const run=async(fn:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setNote('');try{await fn();await onChanged()}catch(e){setNote((e as Error).message)}finally{setBusy(false)}};
 // Keep the original result intact; only shorten its presentation in the list.
 const brief=(file.summary||'').replace(/【段落[^】]*】/g,'').replace(/\s+/g,' ').trim();
 const preview=brief.length>80?brief.slice(0,80)+'…':brief;
 const tags=file.tags||[];
 return <div className="file-intelligence">
  {brief&&<div className="file-summary-preview"><span className="file-summary-label">内容提要</span><p>{preview}</p>{onOpenSummary&&<button type="button" className="file-summary-open" onClick={onOpenSummary}>查看完整摘要 <span aria-hidden="true">→</span></button>}</div>}
  <div className="filetags">{(showAll?tags:tags.slice(0,3)).map(t=><span className={'filetag '+(t.source==='manual'?'manual':'')} key={t.label}><button type="button" onClick={()=>onChoose(t.label)}>{t.label}</button></span>)}{tags.length>3&&<button type="button" className="tagmore" aria-expanded={showAll} onClick={()=>setShowAll(!showAll)}>{showAll?'收起':'+'+(tags.length-3)}</button>}</div>
  {editable&&<details className="file-tag-editor"><summary>管理标签</summary><div className="file-tag-editor-content"><button type="button" onClick={()=>void run(async()=>setGroups((await request('/files/tag-vocabulary')).groups))}>五维标签建议</button>{groups.map(g=><div className="vocabulary-group" key={g.name}><strong>{g.name}</strong><div className="filetags">{g.tags.map(label=><button className="tagmore" type="button" key={label} disabled={busy||tags.some(t=>t.label===label)} onClick={()=>void run(()=>fileService.patchTags(file.id,{add:label}))}>{label.split(':')[1]}</button>)}</div></div>)}<button type="button" disabled={busy} onClick={()=>void run(()=>fileService.tag(file.id))}>{busy?'处理中…':'本地规则重新打标'}</button><div className="file-tag-remove-list">{tags.map(t=><button type="button" disabled={busy} key={t.label} aria-label={'移除文件标签 '+t.label} onClick={()=>void run(()=>fileService.patchTags(file.id,{remove:t.label}))}>{t.label}<small>{t.source==='manual'?'人工':t.source==='ai'?'AI':'规则'}</small> ×</button>)}</div><div className="file-tag-add"><input aria-label={'添加文件标签 '+file.name} placeholder="输入自定义标签" maxLength={16} value={custom} onChange={e=>setCustom(e.target.value)}/><button type="button" disabled={busy||!custom.trim()} onClick={()=>void run(async()=>{await fileService.patchTags(file.id,{add:custom});setCustom('')})}>添加</button></div></div></details>}
  {note&&<small role="alert">{note}</small>}
 </div>;
}
