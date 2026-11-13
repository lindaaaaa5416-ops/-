import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createFileTrash} from './file-trash.mjs';

test('recycle/restore preserves associations, rejects unauthorized actions and old physical deletions',async()=>{
 const db=new DatabaseSync(':memory:');
 const material={id:'f',session:'s',person:'p',storedFile:true};
 const data={sessions:[{id:'s',people:['p']}],materials:[material]};
 db.exec("CREATE TABLE files(id TEXT,name TEXT,removed INTEGER);INSERT INTO files VALUES('f','test.txt',0),('old','old.txt',1);CREATE TABLE state(id INTEGER,revision INTEGER,body TEXT);CREATE TABLE audit(time TEXT,user TEXT,action TEXT)");
 db.prepare('INSERT INTO state VALUES(1,1,?)').run(JSON.stringify(data));
 const fail=(message,status=400)=>{throw Object.assign(Error(message),{status})};
 const route=createFileTrash({db,fail,canEdit:(_,u)=>u.role!=='teacher',lookup:id=>db.prepare('SELECT * FROM files WHERE id=? AND removed=0').get(id)});
 const invoke=async(path,role='admin',method='POST')=>{let result;await route({method},null,new URL('http://local'+path),{id:'u',role},{},(_,r)=>{result=r});return result};
 try{
  await assert.rejects(invoke('/api/files/f/trash','teacher'),e=>e.status===403);
  await invoke('/api/files/f/trash','operator');
  assert.equal(JSON.parse(db.prepare('SELECT body FROM state').get().body).materials.length,0);
  assert.equal((await invoke('/api/files/trash','admin','GET')).files.length,1);
  await assert.rejects(invoke('/api/files/f/restore','operator'),e=>e.status===403);
  await assert.rejects(invoke('/api/files/old/restore'),e=>e.status===409);
  await invoke('/api/files/f/restore');
  assert.deepEqual(JSON.parse(db.prepare('SELECT body FROM state').get().body).materials,[material]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM file_trash').get().n,0);
  assert.equal(db.prepare("SELECT removed FROM files WHERE id='f'").get().removed,0);
  await invoke('/api/files/f/trash');
  db.prepare('UPDATE state SET body=?').run(JSON.stringify({...data,sessions:[],materials:[]}));
  await assert.rejects(invoke('/api/files/f/restore'),e=>e.status===409);
  assert.equal(db.prepare("SELECT removed FROM files WHERE id='f'").get().removed,1);
 }finally{db.close()}
});
