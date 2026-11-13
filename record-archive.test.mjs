import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {seed,scheduleService} from './src/service.ts';
import {createRecordArchive} from './record-archive.mjs';

test('admin-only reversible archive preserves history; restoring a conflicting course is rejected',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE state(id INTEGER,revision INTEGER,body TEXT);CREATE TABLE audit(time TEXT,user TEXT,action TEXT)');
 const original=seed();db.prepare('INSERT INTO state VALUES(1,1,?)').run(JSON.stringify(original));
 const fail=(message,status=400)=>{throw Object.assign(Error(message),{status})};
 const route=createRecordArchive({db,fail});
 const call=(path,role='admin',method='POST',body={confirm:true})=>{let value;route({method},null,new URL('http://local'+path),{id:'u',role},body,(_,r)=>{value=r});return value};
 const load=()=>JSON.parse(db.prepare('SELECT body FROM state').get().body);
 try{
  assert.throws(()=>call('/api/record-archive/profile/P1/delete','operator'),e=>e.status===403);
  assert.throws(()=>call('/api/record-archive/profile/P1/delete','teacher'),e=>e.status===403);
  assert.throws(()=>call('/api/record-archive/profile/P1/delete','admin','POST',{}),/确认/);
  call('/api/record-archive/profile/P1/delete');assert.equal(load().profiles[0].archived,true);
  for(const key of ['sessions','participations','reviews','materials','versions'])assert.deepEqual(load()[key],original[key]);
  assert.equal(call('/api/record-archive?kind=profile','admin','GET').records[0].id,'P1');
  call('/api/record-archive/profile/P1/restore');assert.equal(load().profiles[0].archived,false);
  const course=original.sessions[0];call('/api/record-archive/session/'+course.id+'/delete');
  const data=load();assert.deepEqual(data.materials,original.materials);assert.deepEqual(data.reviews,original.reviews);
  scheduleService.save(data,{...course,id:'replacement',people:[...course.people]});
  db.prepare('UPDATE state SET body=?').run(JSON.stringify(data));
  assert.throws(()=>call('/api/record-archive/session/'+course.id+'/restore'),e=>e.status===409&&/冲突/.test(e.message));
  assert.equal(load().sessions[0].archived,true);
  data.sessions=data.sessions.filter(s=>s.id!=='replacement');db.prepare('UPDATE state SET body=?').run(JSON.stringify(data));
  call('/api/record-archive/session/'+course.id+'/restore');assert.equal(load().sessions[0].archived,false);
 }finally{db.close()}
});
