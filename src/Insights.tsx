import React from 'react';
import type {DB,Session} from './service';
import {completeness} from './service';
type Props={db:DB;page:number;weekly:Session[];onSelect:(page:number,id?:string,filter?:string)=>void};
export default function Insights({db,page,weekly,onSelect}:Props){
 const active=db.sessions.filter(s=>!s.cancelled);
 const reviewed=active.filter(s=>completeness(db,s).review).length;
 const ready=active.filter(s=>completeness(db,s).complete).length;
 const drafts=db.versions.filter(v=>v.status==='草稿');
 const submitted=db.reviews.filter(r=>r.submitted);
 const groups=page===0?['周一','周二','周三','周四','周五','周六','周日'].map((label,i)=>({label,value:weekly.filter(s=>(new Date(s.start).getDay()+6)%7===i).length,action:()=>onSelect(2)})):
 page===1?['公益学员','定制客户','渠道方'].map(label=>({label,value:db.profiles.filter(p=>p.roles.includes(label)).length,action:()=>onSelect(1,'',label)})):
 page===2?['公益课','定制团队课','一对一'].map(label=>({label,value:active.filter(s=>s.type===label).length,action:()=>onSelect(2,'',label)})):
 page===3?['课前准备资料','课上 PPT','学员产出','照片记录'].map(label=>({label,value:db.materials.filter(m=>m.category===label&&active.some(s=>s.id===m.session)).length,action:()=>{const m=db.materials.find(m=>m.category===label&&active.some(s=>s.id===m.session));onSelect(3,m?.session)}})):
 page===4?['待填写','草稿','已提交'].map(label=>({label,value:active.filter(s=>{const r=db.reviews.find(r=>r.session===s.id);return label==='待填写'?!r:label==='草稿'?r&&!r.submitted:r?.submitted}).length,action:()=>{const s=active.find(s=>{const r=db.reviews.find(r=>r.session===s.id);return label==='待填写'?!r:label==='草稿'?r&&!r.submitted:r?.submitted});onSelect(4,s?.id)}})):
 ['草稿','现行','已归档'].map(label=>({label,value:db.versions.filter(v=>v.status===label).length,action:()=>onSelect(5,db.versions.find(v=>v.status===label)?.id)}));
 const total=page===1?db.profiles.length:page===5?db.knowledge.length:active.length;
 const done=page===1?db.profiles.filter(p=>db.participations.some(r=>r.person===p.id&&r.attendance==='已出席')).length:page===5?db.knowledge.filter(k=>db.versions.some(v=>v.knowledge===k.id&&v.status==='现行')).length:page===4?reviewed:ready;

 const titles=['本周课程分布','业务身份分布','课程类型分布','课程资料分布','复盘进度分布','知识版本分布'];
 const progress=['课程资料齐全率','个人出席覆盖率','课程资料齐全率','课程资料齐全率','课程复盘提交率','知识条目发布率'][page];
 const denominator=page===1?db.profiles.filter(p=>p.type==='个人').length:total;
 const ratio=denominator?Math.round(done/denominator*100):0;
 return <div className="insights" aria-label={titles[page]+'可视化'}><section className="chartpanel"><div className="chartheading"><div><span className="chartkicker">数据概览 / 0{page+1}</span><h2>{titles[page]}</h2></div><span className="livepill">实时记录</span></div><div className={'bars '+(page===0?'weekbars':'')}>{groups.map((g,i)=><button className="chartrow" key={g.label} onClick={g.action} aria-label={`${g.label} ${g.value}，查看相关记录`}><span>{g.label}</span><div className="bartrack"><i style={{width:`${g.value/Math.max(1,...groups.map(x=>x.value))*100}%`,height:page===0?(g.value/Math.max(1,...groups.map(x=>x.value))*100)+"%":undefined,background:i===0?'#1d9bf0':i===1?'#536471':i===2?'#0f1419':'#a9b5bf'}}/></div><b>{g.value}</b></button>)}</div><div className="chartcaption">{page===0?'所选周的有效场次':page===1?'同一档案可具有多个身份，数量不相加去重':page===3?'统计已登记文件数，照片为可选资料':page===5?'统计全部知识版本，含历史归档':'统计有效场次，不含已取消课程'} · 点击图表查看记录</div></section><section className="progresspanel"><div><span className="chartkicker">{page===5?'方法沉淀':page===1?'学习连接':'交付进度'}</span><h2>{progress}</h2><p>{done} / {denominator} {page===5?'个条目已有现行版':page===1?'位个人有出席记录':page===4?'场课程已提交复盘':'场课程资料已齐全'}</p><div className="minimetrics"><span>{page===5?'待确认草稿':'待补资料'}<b>{page===5?drafts.length:active.length-ready}</b></span><span>{page===1?'企业与渠道':page===5?'已归档版本':'已提交复盘'}<b>{page===1?db.profiles.filter(p=>p.type!=='个人').length:page===5?db.versions.filter(v=>v.status==='已归档').length:submitted.length}</b></span></div></div><div className="ring" role="img" aria-label={`${progress} ${ratio}%`} style={{background:`conic-gradient(#1d9bf0 ${ratio*3.6}deg,#eff3f4 0deg)`}}><div><strong>{ratio}<small>%</small></strong><span>{page===5?'已发布':page===1?'已出席':page===4?'已提交':'已齐全'}</span></div></div></section></div>
}



