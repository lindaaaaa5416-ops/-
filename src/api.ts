import {normalizeDb} from './service';
import type {DB} from './service';
export type User={id:string;username:string;name:string;role:'admin'|'operator'|'teacher';teacher:string;active:boolean};
export async function request(path:string,method='GET',body?:unknown){const res=await fetch('/api'+path,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let data;try{data=await res.json()}catch{throw Error('暂时无法连接工作空间，请确认服务已启动后重试')}if(!res.ok){if(res.status===401&&path!=='/auth/login'&&path!=='/auth/me')window.dispatchEvent(new Event('session-expired'));throw Error(data.error||'操作失败，请重试')}return data}
let revision=0;
export const dataService={async load():Promise<DB>{const result=await request('/data');revision=result.revision;return normalizeDb(JSON.parse(result.body))},async save(data:DB){const result=await request('/data','PUT',{data,revision});revision=result.revision},async reset():Promise<DB>{const result=await request('/data/reset','POST',{});revision=result.revision;return result.data}};
export const roleNames={admin:'管理员',operator:'运营',teacher:'老师'};
