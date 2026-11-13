import {scheduleService} from './src/service.ts';
export function createRecordArchive({db,fail}){
 return (req,res,url,user,body,send)=>{
  if(!url.pathname.startsWith('/api/record-archive'))return false;
  if(user.role!=='admin')fail('仅管理员可以删除或恢复档案和场次',403);
  const keys={profile:'profiles',session:'sessions'};
  if(req.method==='GET'&&url.pathname==='/api/record-archive'){
   const kind=url.searchParams.get('kind');if(!keys[kind])fail('记录类型无效');
   const data=JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body);
   send(200,{records:data[keys[kind]].filter(x=>x.archived).map(x=>({id:x.id,name:x.name}))});return true;
  }
  const m=url.pathname.match(/^\/api\/record-archive\/(profile|session)\/([\w-]+)\/(delete|restore)$/);
  if(!m||req.method!=='POST')fail('删除请求无效');
  if(body.confirm!==true)fail('请先确认删除或恢复操作');
  const row=db.prepare('SELECT revision,body FROM state WHERE id=1').get(),data=JSON.parse(row.body);
  const item=data[keys[m[1]]].find(x=>x.id===m[2]);if(!item)fail('记录不存在',404);
  const archived=m[3]==='delete';
  if(Boolean(item.archived)===archived)fail(archived?'记录已删除':'记录已恢复',409);
  if(!archived&&m[1]==='session'){
   try{scheduleService.save(structuredClone(data),{...item,archived:false})}catch(e){fail('无法恢复：'+e.message,409)}
  }
  item.archived=archived;
  db.exec('BEGIN IMMEDIATE');
  try{
   db.prepare('UPDATE state SET body=?,revision=revision+1 WHERE id=1 AND revision=?').run(JSON.stringify(data),row.revision);
   db.prepare('INSERT INTO audit(time,user,action) VALUES(?,?,?)').run(new Date().toISOString(),user.id,`${m[3]}:${m[1]}:${item.id}`);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  send(200,{ok:true});return true;
 };
}
