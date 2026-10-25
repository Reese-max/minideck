// Runs before canonical handlers and ASSETS. Gate rows exist only in fresh QA DBs.
// A live row allows immediate revocation of ALL immutable Preview versions.
const TREE='4e7f083aa5208fb4d74b5c1091d290d0e5e507e3';
const SHA=/^[a-f0-9]{40}$/,KEY=/^[a-f0-9]{64}$/;
export function privateResponse(response) {
  const headers=new Headers(response.headers);
  headers.set('Cache-Control','private, no-store');headers.set('Vary','X-Minideck-QA');
  headers.set('X-Robots-Tag','noindex, nofollow');headers.set('Referrer-Policy','no-referrer');
  return new Response(response.body,{status:response.status,headers});
}
export async function admit(request,env,now=Date.now(),maximum=200) {
  const deny=()=>privateResponse(new Response('QA admission required',{status:401}));
  const token=request.headers.get('x-minideck-qa')||'';
  if(!Number.isInteger(maximum)||maximum<1||maximum>200||!KEY.test(token)||!SHA.test(env.QA_SOURCE_SHA||'')||env.QA_PRODUCT_TREE!==TREE||!/^\d{1,20}-[1-9]\d{0,3}$/.test(env.QA_RUN||''))return deny();
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  try {
    // Atomic bounded admission, no call to the product before this succeeds.
    const row=await env.DB.prepare("UPDATE minideck_qa_run SET requests_left=requests_left-1 WHERE run_id=?1 AND typeof(active)='integer' AND active=1 AND gate_hash=?2 AND source_sha=?3 AND product_tree=?4 AND typeof(created_at)='integer' AND created_at>=0 AND typeof(expires_at)='integer' AND created_at<=?5 AND expires_at>?5 AND expires_at>created_at AND expires_at-created_at<=3600000 AND typeof(requests_left)='integer' AND requests_left BETWEEN 1 AND ?6 RETURNING run_id")
      .bind(env.QA_RUN,hash,env.QA_SOURCE_SHA,TREE,now,maximum).first();
    return row?.run_id===env.QA_RUN?null:deny();
  } catch {return privateResponse(new Response('QA admission unavailable',{status:503}));}
}
