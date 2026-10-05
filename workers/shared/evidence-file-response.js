// Caller must authorize the artifact before invoking this function.
export async function evidenceFileResponse(request,env,artifact,{mimeType='application/octet-stream',filename='original'}={}) {
 const size=artifact.byte_size;
 let start=0,end=size-1,partial=false;
 const range=request.headers.get('Range');
 const common={'cache-control':'private, no-store','x-robots-tag':'noindex, nofollow','x-content-type-options':'nosniff','referrer-policy':'no-referrer','accept-ranges':'bytes'};
 if(range){
  const m=/^bytes=(\d*)-(\d*)$/.exec(range);
  if(!m||(!m[1]&&!m[2]))return new Response(null,{status:416,headers:{...common,'content-range':`bytes */${size}`}});
  if(m[1]){start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),size-1):size-1;}
  else {start=Math.max(0,size-Number(m[2]));end=size-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=size)return new Response(null,{status:416,headers:{...common,'content-range':`bytes */${size}`}});
  partial=true;
 }
 const object=await env.BENCH_DOCUMENTS.get(artifact.object_key,partial?{range:{offset:start,length:end-start+1}}:undefined);
 if(!object)return new Response('Not Found',{status:404,headers:common});
 const inline=/^(application\/pdf|audio\/[a-zA-Z0-9.+-]+|image\/(png|jpeg|webp|gif))$/.test(mimeType)&&!new URL(request.url).searchParams.has('download');
 const clean=String(filename).replace(/[\r\n"\\]/g,'_');
 const ascii=clean.replace(/[^\x20-\x7e]/g,'_');
 const encoded=encodeURIComponent(clean).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
 return new Response(object.body,{status:partial?206:200,headers:{...common,'content-type':mimeType,'content-length':String(partial?end-start+1:size),'content-disposition':`${inline?'inline':'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,'content-security-policy':"default-src 'none'; sandbox",...(partial?{'content-range':`bytes ${start}-${end}/${size}`}:{})}});
}
