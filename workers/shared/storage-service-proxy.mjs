import {checkedStorageOptions} from './storage-options.mjs';
import {framed,unframe,objectFromWire} from './storage-wire.mjs';
const MAX_BYTES=2**41-2**22;
const stores=new WeakMap();

export class StorageServiceBucket {
 constructor(service,token,bucket){this.service=service;this.token=token;this.bucket=bucket;this.maxObjectSize=MAX_BYTES;}
 async request(operation,params={},body){
  const binary=body!==undefined;
  const response=await this.service.fetch('https://posterity-storage.internal/v1',{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':binary?'application/x-posterity-storage-frame':'application/json'},body:binary?framed({...params,operation,bucket:this.bucket},body):JSON.stringify({...params,operation,bucket:this.bucket})});
  if(!response.ok){let code='storage_service_unavailable';try{code=(await response.json()).error||code;}catch{}throw Object.assign(new Error(code),{safeCode:code,status:response.status,uncertain:response.headers.get('X-Storage-Uncertain')==='1'});}
  return response;
 }
 async head(key){return objectFromWire(await(await this.request('head',{key})).json());}
 async get(key,options={}){const {metadata,body}=await unframe((await this.request('get',{key,options:checkedStorageOptions(options,'get')})).body);if(!metadata?.has_body)await body.cancel();return objectFromWire(metadata,body);}
 async put(key,value,options={}){return objectFromWire(await(await this.request('put',{key,options:checkedStorageOptions(options,'put')},value)).json());}
 async delete(keys){await(await this.request('delete',{keys})).body?.cancel();}
 async list(options={}){const x=await(await this.request('list',{options})).json();return {...x,objects:x.objects.map(o=>objectFromWire(o))};}
 async createMultipartUpload(key,options={}){const r=await(await this.request('multipart-create',{key,options:checkedStorageOptions(options,'multipart-create')})).json();return this.resumeMultipartUpload(key,r.uploadId);}
 resumeMultipartUpload(key,uploadId){const self=this;return {key,uploadId,
  async uploadPart(partNumber,value){return (await self.request('multipart-part',{key,uploadId,partNumber},value)).json();},
  async complete(parts){return this.completeStep(parts);},
  async completeStep(parts){const x=await(await self.request('multipart-complete',{key,uploadId,parts})).json();return x.pending?x:objectFromWire(x);},
  async abort(){await(await self.request('multipart-abort',{key,uploadId})).body?.cancel();}
 };}
}
export function storageBinding(env,name,bucket,native=env[name]){
 const provider=env.POSTERITY_STORAGE_PROVIDER||'r2';if(provider==='r2')return native;
 if(provider!=='dropbox'||!env.POSTERITY_STORAGE?.fetch||typeof env.POSTERITY_STORAGE_TOKEN!=='string'||!env.POSTERITY_STORAGE_TOKEN)throw Object.assign(new Error('storage_configuration'),{safeCode:'storage_configuration',status:503});
 if(!stores.has(env))stores.set(env,new Map());const byName=stores.get(env);
 if(!byName.has(name))byName.set(name,new StorageServiceBucket(env.POSTERITY_STORAGE,env.POSTERITY_STORAGE_TOKEN,bucket));return byName.get(name);
}
