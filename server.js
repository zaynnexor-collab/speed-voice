import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {AccessToken,RoomServiceClient} from 'livekit-server-sdk';
const required=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET'];
const missing=required.filter(k=>!process.env[k]);
const app=express();app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)),'public')));app.disable('x-powered-by');app.use(express.json({limit:'8kb'}));
app.use(cors({origin:(process.env.FRONTEND_ORIGIN||'http://localhost:5173').split(',')}));
const db=missing.length?null:createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const safe=(x,n=90)=>typeof x==='string'?x.trim().slice(0,n):'';
const rooms=['diretoria','lideranca','reuniao-geral','colatina','linhares-shell','linhares-movelar','serra','vitoria','lindemberg','brisamar','coqueiral','moxuara','maracana'];
function allowed(u,r){return rooms.includes(r)&&(u.role==='admin'||(r==='lideranca'?u.role==='lider':r==='diretoria'?false:r==='reuniao-geral'||r===u.room))}
app.get('/health',async(_,res)=>{if(!db)return res.json({status:'needs_configuration',missing:missing.length});try{const {count,error}=await db.from('invites').select('id',{count:'exact',head:true});res.json({status:error?'database_error':count===0?'no_visible_invites':'ok',databaseProject:new URL(process.env.SUPABASE_URL).hostname.split('.')[0],visibleInvites:count,databaseError:error?.code||null})}catch{res.json({status:'database_unreachable'})}});
async function auth(req,res,next){if(!db)return res.status(503).json({error:'Configuração pendente'});const session=safe(req.body.session,200);if(!session)return res.status(401).json({error:'Sessão necessária'});const {data,error}=await db.from('members').select('id,name,role,room').eq('session_hash',hash(session)).eq('active',true).maybeSingle();if(error||!data)return res.status(401).json({error:'Sessão inválida'});req.member=data;next()}
app.post('/api/token',auth,async(req,res)=>{try{const room=safe(req.body.room);if(!allowed(req.member,room))return res.status(403).json({error:'Sem acesso à sala'});const t=new AccessToken(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET,{identity:req.member.id,name:req.member.name,ttl:'2h'});t.addGrant({roomJoin:true,room:'speed-'+room,canPublish:true,canSubscribe:true});res.json({token:await t.toJwt(),url:process.env.LIVEKIT_URL})}catch{res.status(500).json({error:'Falha na chamada'})}});
app.post('/api/invites',auth,async(req,res)=>{if(req.member.role!=='admin')return res.status(403).json({error:'Somente administradores'});const role=safe(req.body.role),room=safe(req.body.room),name=safe(req.body.name);if(!['admin','lider','funcionario'].includes(role)||!rooms.includes(room))return res.status(400).json({error:'Dados inválidos'});const code='SPEED-'+crypto.randomBytes(12).toString('hex').toUpperCase();const {error}=await db.from('invites').insert({code_hash:hash(code),name:name||null,role,room,created_by:req.member.id,expires_at:new Date(Date.now()+7*864e5).toISOString()});if(error)return res.status(500).json({error:'Erro ao criar convite'});res.json({code,role,room})});
app.post('/api/activate',async(req,res)=>{if(!db)return res.status(503).json({error:'Configuração pendente'});const code=safe(req.body.code,200).toUpperCase(),name=safe(req.body.name);if(name.length<2)return res.status(400).json({error:'Informe seu nome'});const {data:invite}=await db.from('invites').select('*').eq('code_hash',hash(code)).is('used_at',null).maybeSingle();if(!invite||new Date(invite.expires_at)<new Date()||(invite.name&&invite.name.toLocaleLowerCase('pt-BR')!==name.toLocaleLowerCase('pt-BR')))return res.status(403).json({error:'Convite inválido ou expirado'});const session=crypto.randomBytes(32).toString('hex');const {data:member,error}=await db.from('members').insert({name,role:invite.role,room:invite.room,session_hash:hash(session)}).select('id,name,role,room').single();if(error)return res.status(500).json({error:'Falha ao ativar'});const {data:claimed,error:claimError}=await db.from('invites').update({used_at:new Date().toISOString(),used_by:member.id}).eq('id',invite.id).is('used_at',null).select('id');if(claimError||!claimed?.length){await db.from('members').delete().eq('id',member.id);return res.status(409).json({error:'Convite já utilizado'})}res.json({token:session,name:member.name,role:member.role,room:member.room})});

const lkAdmin=()=>new RoomServiceClient(process.env.LIVEKIT_URL.replace(/^wss:/,'https:').replace(/^ws:/,'http:'),process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET);
async function removeMeetingRoom(id){try{await lkAdmin().deleteRoom('speed-meeting-'+id)}catch(e){console.warn('Meeting room cleanup:',e.message)}}
app.post('/api/meeting/create',auth,async(req,res)=>{
 if(req.member.role!=='admin')return res.status(403).json({error:'Apenas administradores'});
 try{
 const {data:old,error:lookupError}=await db.from('voice_meetings').select('id').eq('active',true);
 if(lookupError)throw lookupError;
 const {error:closeError}=await db.from('voice_meetings').update({active:false,ended_at:new Date().toISOString()}).eq('active',true);
 if(closeError)throw closeError;
 for(const m of old||[])await removeMeetingRoom(m.id);
 const secret=crypto.randomBytes(32).toString('hex');
 const {data,error}=await db.from('voice_meetings').insert({token_hash:hash(secret),created_by:req.member.id}).select('id,expires_at').single();
 if(error)throw error;
 res.json({url:'/meeting?key='+encodeURIComponent(secret),expiresAt:data.expires_at,id:data.id});
 }catch(e){console.error('meeting-create',e.message);res.status(500).json({error:'Não foi possível criar a reunião'})}
});
app.post('/api/meeting/end',auth,async(req,res)=>{
 if(req.member.role!=='admin')return res.status(403).json({error:'Apenas administradores'});
 const id=safe(req.body.id,50);if(!/^[0-9a-f-]{36}$/i.test(id))return res.status(400).json({error:'Reunião inválida'});
 const {data,error}=await db.from('voice_meetings').update({active:false,ended_at:new Date().toISOString()}).eq('id',id).eq('active',true).select('id').maybeSingle();
 if(error)return res.status(500).json({error:'Erro ao encerrar'});
 if(data)await removeMeetingRoom(id);
 res.json({ended:true});
});
app.post('/api/meeting/current',auth,async(req,res)=>{
 if(req.member.role!=='admin')return res.status(403).json({error:'Apenas administradores'});
 const {data,error}=await db.from('voice_meetings').select('id,created_at,expires_at').eq('active',true).gt('expires_at',new Date().toISOString()).order('created_at',{ascending:false}).limit(1).maybeSingle();
 if(error)return res.status(500).json({error:'Erro ao consultar reunião'});
 res.json({meeting:data});
});

app.post('/api/meeting/admin-join',auth,async(req,res)=>{
 if(req.member.role!=='admin')return res.status(403).json({error:'Apenas administradores'});
 const id=safe(req.body.id,50);
 if(!/^[0-9a-f-]{36}$/i.test(id))return res.status(400).json({error:'Reunião inválida'});
 const {data,error}=await db.from('voice_meetings').select('id').eq('id',id).eq('active',true).gt('expires_at',new Date().toISOString()).maybeSingle();
 if(error)return res.status(500).json({error:'Falha ao consultar reunião'});
 if(!data)return res.status(404).json({error:'Reunião encerrada ou expirada'});
 try{
 const t=new AccessToken(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET,{identity:'admin-'+req.member.id,name:req.member.name+' · ADMIN',ttl:'2m'});
 t.addGrant({roomJoin:true,room:'speed-meeting-'+id,canPublish:true,canSubscribe:true,canPublishSources:['microphone','screen_share','screen_share_audio']});
 res.json({url:process.env.LIVEKIT_URL,token:await t.toJwt()});
 }catch(e){res.status(500).json({error:'Falha ao iniciar transmissão'})}
});

const guestAttempts=new Map();
app.post('/api/meeting/join',async(req,res)=>{const ip=req.ip||'unknown';const now=Date.now();const prev=guestAttempts.get(ip)||{n:0,until:now+60000};if(now>prev.until){prev.n=0;prev.until=now+60000}if(++prev.n>20)return res.status(429).json({error:'Muitas tentativas. Aguarde um minuto.'});guestAttempts.set(ip,prev);
 if(!db)return res.status(503).json({error:'Servidor não configurado'});
 const key=safe(req.body.key,160),name=safe(req.body.name,70);
 if(!/^[0-9a-f]{64}$/i.test(key)||name.length<2)return res.status(400).json({error:'Nome ou link inválido'});
 const {data,error}=await db.from('voice_meetings').select('id,expires_at').eq('token_hash',hash(key)).eq('active',true).gt('expires_at',new Date().toISOString()).maybeSingle();
 if(error)return res.status(500).json({error:'Falha ao validar reunião'});
 if(!data)return res.status(403).json({error:'Esta reunião foi encerrada ou o link expirou'});
 try{
 const t=new AccessToken(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET,{identity:crypto.randomUUID(),name,ttl:'30s'});
 t.addGrant({roomJoin:true,room:'speed-meeting-'+data.id,canPublish:true,canSubscribe:true,canPublishSources:['microphone']});
 res.json({url:process.env.LIVEKIT_URL,token:await t.toJwt(),meetingId:data.id});
 }catch(e){res.status(500).json({error:'Falha ao conectar ao áudio'})}
});

app.listen(process.env.PORT||3001,'0.0.0.0',()=>console.log('SPEED VOICE API started'));