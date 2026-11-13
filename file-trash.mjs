// Additive recycle bin. Files stay on disk; existing business IDs remain stable.
export function createFileTrash({db,fail,canEdit,lookup}){
 db.exec('CREATE TABLE IF NOT EXISTS file_trash(id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL,deleted_by TEXT NOT NULL,registration TEXT NOT NULL)');
 return async(req,res,url,user,body,send)=>{
  if(url.pathname==='/api/files/trash'&&req.method==='GET'){
   if(user.role!=='admin')fail('仅管理员可以查看回收站',403);
   send(200,{files:db.prepare('SELECT f.id,f.name,t.deleted_at FROM file_trash t JOIN files f ON f.id=t.id WHERE f.removed=1 ORDER BY t.deleted_at DESC').all()});return true;
  }
  const match=url.pathname.match(/^\/api\/files\/([\w-]+)\/(trash|restore)$/);
  if(!match||req.method!=='POST')return false;
  const id=match[1],restore=match[2]==='restore';
  if(restore&&user.role!=='admin')fail('仅管理员可以恢复资料',403);
  const f=db.prepare('SELECT * FROM files WHERE id=?').get(id);
  if(!f)fail('资料不存在',404);
  const record=db.prepare('SELECT * FROM file_trash WHERE id=?').get(id);
  if(restore&&(!record||f.removed!==1))fail('该资料不是可恢复的回收站记录',409);
  if(!restore&&(!lookup(id)||!canEdit(f,user)))fail('没有权限移入回收站',403);
  const row=db.prepare('SELECT revision,body FROM state WHERE id=1').get(),data=JSON.parse(row.body);
  const registration=restore?JSON.parse(record.registration):data.materials.find(m=>m.id===id)||null;
  if(restore&&registration){
   const session=data.sessions.find(s=>s.id===registration.session);
   if(!session||(registration.person&&!session.people.includes(registration.person)))fail('原课程或参与人已变化，暂不能恢复',409);
   if(data.materials.some(m=>m.id===id))fail('资料登记已存在',409);
  }
  if(restore&&registration)data.materials.push(registration);
  if(!restore)data.materials=data.materials.filter(m=>m.id!==id);
  db.exec('BEGIN IMMEDIATE');
  try{
   if(restore)db.prepare('DELETE FROM file_trash WHERE id=?').run(id);
   else db.prepare('INSERT INTO file_trash VALUES(?,?,?,?)').run(id,new Date().toISOString(),user.id,JSON.stringify(registration));
   db.prepare('UPDATE files SET removed=? WHERE id=?').run(restore?0:1,id);
   db.prepare('UPDATE state SET revision=revision+1,body=? WHERE id=1 AND revision=?').run(JSON.stringify(data),row.revision);
   db.prepare('INSERT INTO audit(time,user,action) VALUES(?,?,?)').run(new Date().toISOString(),user.id,(restore?'restore:':'trash:')+id);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  send(200,{ok:true});return true;
 };
}
