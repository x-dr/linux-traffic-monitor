import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { EnrollmentSchema, RegistrationSchema } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { createNode, digest } from './nodes.js';
import { httpError } from './auth.js';
export function installRegistrationRoutes(app:FastifyInstance,db:DB,now:()=>number){
  app.get('/api/v1/registration-tokens',async()=>({tokens:db.prepare('SELECT id,name,group_name AS "group",expires_at,max_uses,uses,revoked FROM registration_tokens ORDER BY expires_at DESC LIMIT 100').all()}));
  app.post<{Body:Static<typeof RegistrationSchema>}>('/api/v1/registration-tokens',{schema:{body:RegistrationSchema}},async req=>{
    if(!req.body.name.trim())throw httpError(400,'名称不能为空');const id=randomUUID(),token=randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO registration_tokens(id,name,group_name,token_hash,expires_at,max_uses) VALUES(?,?,?,?,?,?)').run(id,req.body.name,req.body.group,digest(token),now()+req.body.expires_in,req.body.max_uses);
    return {id,token,expires_at:now()+req.body.expires_in};
  });
  app.delete<{Params:{id:string}}>('/api/v1/registration-tokens/:id',{schema:{params:Type.Object({id:Type.String({format:'uuid'})})}},async req=>{
    db.prepare('UPDATE registration_tokens SET revoked=1 WHERE id=?').run(req.params.id);return {ok:true};
  });
  app.post<{Body:Static<typeof EnrollmentSchema>}>('/api/v1/agent/register',{schema:{body:EnrollmentSchema},config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async req=>{
    if(Object.keys(req.query as object).length)throw httpError(400,'注册不接受查询参数');
    const authorization=req.headers.authorization;
    if(!authorization?.startsWith('Bearer ')||authorization.length>300)throw httpError(401,'注册凭据无效');
    const secret=authorization.slice(7);
    return db.transaction(()=>{
      const registration=db.prepare('SELECT * FROM registration_tokens WHERE id=? AND token_hash=?').get(req.body.registration_id,digest(secret)) as {expires_at:number;revoked:number;uses:number;max_uses:number;group_name:string}|undefined;
      if(!registration||registration.revoked||registration.expires_at<=now())throw httpError(401,'注册凭据无效或过期');
      if(!req.body.name.trim())throw httpError(400,'名称不能为空');
      const claimed=db.prepare('SELECT node_id FROM registration_claims WHERE registration_id=? AND request_id=?').get(req.body.registration_id,req.body.request_id) as {node_id:string}|undefined;
      const token=createHmac('sha256',secret).update(`trafficmon-node:${req.body.request_id}`).digest('base64url');
      if(claimed)return {node_id:claimed.node_id,token};
      if(registration.uses>=registration.max_uses)throw httpError(409,'注册次数已用完');
      const node=createNode(db,{name:req.body.name,group:registration.group_name},now());
      db.prepare('UPDATE nodes SET token_hash=? WHERE id=?').run(digest(token),node.id);
      db.prepare('INSERT INTO registration_claims VALUES(?,?,?)').run(req.body.registration_id,req.body.request_id,node.id);
      db.prepare('UPDATE registration_tokens SET uses=uses+1 WHERE id=?').run(req.body.registration_id);
      return {node_id:node.id,token};
    })();
  });
}
