import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import webpush from "npm:web-push@3.6.7";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const messages: Record<string, string> = {
  teste: "Suas notificações estão funcionando!",
  nova: "Uma nova inscrição foi recebida.",
  comprovante: "Há um novo comprovante para conferir.",
  reembolso: "Há uma solicitação de reembolso para conferir.",
  confirmada: "Sua inscrição foi confirmada.",
  mapa: "Confira a escolha de vaga no evento.",
  vaga: "Sua vaga foi atualizada pela organização.",
  cancelada: "Uma edição foi cancelada. Confira os detalhes no app.",
  edicao_nova: "Há uma nova edição de um evento que você conhece.",
  abertura: "As inscrições de um evento que você conhece abriram.",
};

function reply(status: number, data: object) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
async function sameSecret(a: string, b: string) {
  const enc = new TextEncoder();
  const [x,y] = await Promise.all([a,b].map(s => crypto.subtle.digest("SHA-256",enc.encode(s))));
  const xa = new Uint8Array(x), ya = new Uint8Array(y);
  let diff = 0; for(let i=0;i<xa.length;i++) diff |= xa[i]^ya[i];
  return diff===0;
}
function allowed(endpoint: string) {
  try {
    const u=new URL(endpoint), h=u.hostname.toLowerCase();
    return u.protocol==="https:" && !u.username && !u.password && !u.port &&
      (h==="fcm.googleapis.com" || h==="web.push.apple.com" || h.endsWith(".web.push.apple.com") ||
       h==="push.services.mozilla.com" || h.endsWith(".push.services.mozilla.com") ||
       h==="notify.windows.com" || h.endsWith(".notify.windows.com"));
  } catch { return false; }
}
Deno.serve(async req => {
  if(req.method!=="POST") return reply(405,{error:"method"});
  const hook=req.headers.get("x-hook")||"";
  if(hook.length!==72) return reply(401,{error:"unauthorized"});
  const url=Deno.env.get("SUPABASE_URL"), key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key) return reply(503,{error:"not_configured"});
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  try {
    let {data:config,error}=await db.from("push_config").select("vapid_public,vapid_private,hook_secret").eq("id",1).single();
    if(error||!config?.hook_secret||!(await sameSecret(hook,config.hook_secret))) return reply(401,{error:"unauthorized"});
    const raw=await req.text();
    if(raw.length>4096) return reply(413,{error:"request_too_large"});
    let body; try {body=JSON.parse(raw)} catch {return reply(400,{error:"bad_request"})}
    const tipo=body?.tipo;
    if(tipo==="inicializar") {
      if(!config.vapid_public&&!config.vapid_private) {
        const v=webpush.generateVAPIDKeys();
        const {error:save}=await db.from("push_config").update({vapid_public:v.publicKey,vapid_private:v.privateKey}).eq("id",1).is("vapid_public",null).is("vapid_private",null);
        if(save) return reply(503,{error:"initialization_failed"});
      }
      return reply(200,{ok:true});
    }
    if(typeof tipo!=="string"||!Object.hasOwn(messages,tipo)) return reply(400,{error:"bad_request"});
    if(!config.vapid_public||!config.vapid_private) return reply(503,{error:"not_configured"});
    let users:string[]=[];
    if(tipo==="teste") {
      if(typeof body.teste_user!=="string"||!uuid.test(body.teste_user)) return reply(400,{error:"bad_request"});
      users=[body.teste_user];
    } else {
      if(typeof body.edicao_id!=="string"||!uuid.test(body.edicao_id)|| (body.inscricao_id!=null&&(typeof body.inscricao_id!=="string"||!uuid.test(body.inscricao_id)))) return reply(400,{error:"bad_request"});
      const {data,error:recipients}=await db.rpc("push_destinatarios",{p_tipo:tipo,p_ins:body.inscricao_id??null,p_ed:body.edicao_id});
      if(recipients) return reply(503,{error:"recipients_failed"});
      users=(data||[]).map((r:{user_id:string})=>r.user_id);
    }
    let sent=0,failed=0;
    const payload=JSON.stringify({title:"Colanessa",body:messages[tipo],url:"https://colanessa.pages.dev/"});
    for(let offset=0;offset<users.length;offset+=50) {
      const {data:subs,error:subError}=await db.from("push_subs").select("id,endpoint,p256dh,auth").in("user_id",users.slice(offset,offset+50));
      if(subError) return reply(503,{error:"subscriptions_failed"});
      for(let i=0;i<(subs||[]).length;i+=8) {
        await Promise.all((subs||[]).slice(i,i+8).map(async s=>{
          if(!allowed(s.endpoint)) {failed++;return;}
          try {
            await webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},payload,{
              TTL:3600,timeout:5000,vapidDetails:{subject:"https://colanessa.pages.dev/",publicKey:config!.vapid_public,privateKey:config!.vapid_private}
            }); sent++;
          } catch(e) {
            failed++;
            const status=(e as {statusCode?:number})?.statusCode;
            if(status===404||status===410) await db.from("push_subs").delete().eq("id",s.id);
          }
        }));
      }
    }
    return reply(200,{ok:true,sent,failed});
  } catch { return reply(503,{error:"delivery_failed"}); }
});