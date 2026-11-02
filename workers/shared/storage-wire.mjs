const encoder=new TextEncoder(),decoder=new TextDecoder();
const error=()=>Object.assign(new Error('storage_frame_invalid'),{safeCode:'storage_frame_invalid',status:400});
export function byteStream(value){
 if(value instanceof ReadableStream)return value;
 if(value instanceof Blob)return value.stream();
 if(typeof value==='string')value=encoder.encode(value);
 if(value instanceof ArrayBuffer)value=new Uint8Array(value);
 if(ArrayBuffer.isView(value))value=new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
 if(!(value instanceof Uint8Array))throw error();
 let offset=0;return new ReadableStream({pull(c){if(offset>=value.length){c.close();return;}const end=Math.min(value.length,offset+65536);c.enqueue(value.subarray(offset,end));offset=end;}});
}
export function framed(metadata,body){
 const bytes=encoder.encode(JSON.stringify(metadata));if(bytes.length>131072)throw error();
 const prefix=new Uint8Array(4+bytes.length);new DataView(prefix.buffer).setUint32(0,bytes.length);prefix.set(bytes,4);
 const reader=byteStream(body||new Uint8Array()).getReader();let started=false;
 return new ReadableStream({async pull(c){if(!started){started=true;c.enqueue(prefix);return;}try{const x=await reader.read();if(x.done)c.close();else c.enqueue(x.value);}catch(e){c.error(e);}},cancel(reason){return reader.cancel(reason);}});
}
export async function unframe(stream){
 if(!stream)throw error();const reader=stream.getReader();let current=null,offset=0;
 async function take(n){const bytes=new Uint8Array(n);let used=0;while(used<n){if(!current||offset===current.length){const x=await reader.read();if(x.done){await reader.cancel();throw error();}current=x.value;offset=0;}const count=Math.min(n-used,current.length-offset);bytes.set(current.subarray(offset,offset+count),used);used+=count;offset+=count;}return bytes;}
 const prefix=await take(4),n=new DataView(prefix.buffer).getUint32(0);if(n>131072){await reader.cancel();throw error();}
 let metadata;try{metadata=JSON.parse(decoder.decode(await take(n)));}catch{await reader.cancel();throw error();}
 let first=true;
 const body=new ReadableStream({async pull(c){if(first){first=false;if(current&&offset<current.length){c.enqueue(current.subarray(offset));current=null;return;}}try{const x=await reader.read();if(x.done)c.close();else c.enqueue(x.value);}catch(e){c.error(e);}},cancel(reason){return reader.cancel(reason);}});
 return {metadata,body};
}

export function wireObject(o){
 if(!o)return null;
 return {key:o.key,size:o.size,etag:o.etag,httpEtag:o.httpEtag,uploaded:new Date(o.uploaded).toISOString(),httpMetadata:o.httpMetadata||{},customMetadata:o.customMetadata||{},...(o.range?{range:o.range}:{}),has_body:!!o.body};
}
export function objectFromWire(o,body){
 if(!o)return null;const result={...o,uploaded:new Date(o.uploaded)};delete result.has_body;
 result.writeHttpMetadata=headers=>{for(const [name,field] of Object.entries({contentType:'Content-Type',contentLanguage:'Content-Language',contentDisposition:'Content-Disposition',contentEncoding:'Content-Encoding',cacheControl:'Cache-Control',cacheExpiry:'Expires'}))if(o.httpMetadata[name]!=null)headers.set(field,o.httpMetadata[name]);};
 if(o.has_body&&body)Object.assign(result,{body,arrayBuffer:()=>new Response(body).arrayBuffer(),text:()=>new Response(body).text(),json:()=>new Response(body).json()});
 return result;
}
