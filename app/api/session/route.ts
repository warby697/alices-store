import { getDatabase } from "@netlify/database";
import { mutateLocalState, readLocalState } from "../state/local-store";
import { getStore } from "../store";
import { createStaffSession, staffCookie } from "./auth";

type Member={id?:string;name:string;pin:string;role:"Admin"|"Staff";accessible?:boolean;active?:boolean};
type SignIn={id:string;at:string;staff:string;memberId?:string};

async function configuredTeam():Promise<Member[]>{
 if(process.env.NODE_ENV==="development"){
  try{const state=await readLocalState() as {team?:Member[]};return Array.isArray(state.team)?state.team:[]}catch{return []}
 }
 try{
  const db=getDatabase();
  const rows=await db.sql`SELECT value FROM store_state WHERE key = 'team'`;
  const value=rows[0]?.value;
  return Array.isArray(value)?value as Member[]:[];
 }catch{
  return [];
 }
}

// Every successful PIN sign-in is recorded (who, when, which account), so the
// owners can see exactly who was in each day - not just who used the till.
// Kept for 400 days. A failure to record never blocks the sign-in itself.
const SIGN_IN_KEEP_MS=400*24*60*60*1000;
const appendSignIn=(existing:unknown,entry:SignIn)=>{
 const list=Array.isArray(existing)?existing as SignIn[]:[];
 const cutoff=Date.now()-SIGN_IN_KEEP_MS;
 return [entry,...list].filter(e=>new Date(e.at).getTime()>cutoff).slice(0,20000);
};
async function recordSignIn(member:Member){
 const entry:SignIn={id:crypto.randomUUID(),at:new Date().toISOString(),staff:member.name,...(member.id?{memberId:member.id}:{})};
 try{
  const {db,ready}=getStore();
  await ready;
  const client=await db.pool.connect();
  try{
   await client.query("BEGIN");
   const locked=await client.query("SELECT value FROM store_state WHERE key = 'sign_ins' FOR UPDATE");
   await client.query("INSERT INTO store_state (key, value, updated_at) VALUES ('sign_ins', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",[JSON.stringify(appendSignIn(locked.rows[0]?.value,entry))]);
   await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error}
  finally{client.release()}
 }catch(error){
  if(process.env.NODE_ENV==="development"){
   await mutateLocalState(state=>({state:{...state,sign_ins:appendSignIn(state.sign_ins,entry)},result:undefined}));
   return;
  }
  console.error("Could not record sign-in",error);
 }
}

export async function POST(request: Request) {
 const {pin}=await request.json() as {pin?:string};
 const team=await configuredTeam();
 const member=team.find(person=>person.active!==false&&person.pin===pin);
 const staff=member?{name:member.name,initials:member.name.split(/\s+/).map(part=>part[0]).join("").slice(0,2).toUpperCase(),admin:member.role==="Admin",accessible:Boolean(member.accessible)}:undefined;
 if(!member||!staff)return Response.json({error:"Unauthorised"},{status:401});
 await recordSignIn(member);
 return Response.json({staff},{headers:{"set-cookie":staffCookie(await createStaffSession(staff.name))}});
}

export async function DELETE() {
 return Response.json({ok:true},{headers:{"set-cookie":staffCookie("",0)}});
}
