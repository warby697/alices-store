import { getDatabase } from "@netlify/database";
import { readLocalState } from "../state/local-store";
import { createStaffSession, staffCookie } from "./auth";

type Member={name:string;pin:string;role:"Admin"|"Staff";accessible?:boolean;active?:boolean;dailyWage?:number};

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

export async function POST(request: Request) {
 const {pin}=await request.json() as {pin?:string};
 const team=await configuredTeam();
 const member=team.find(person=>person.active!==false&&person.pin===pin);
 const staff=member?{name:member.name,initials:member.name.split(/\s+/).map(part=>part[0]).join("").slice(0,2).toUpperCase(),admin:member.role==="Admin",accessible:Boolean(member.accessible),dailyWage:Math.max(0,Number(member.dailyWage)||0)}:undefined;
 if(!staff)return Response.json({error:"Unauthorised"},{status:401});
 return Response.json({staff},{headers:{"set-cookie":staffCookie(await createStaffSession(staff.name))}});
}

export async function DELETE() {
 return Response.json({ok:true},{headers:{"set-cookie":staffCookie("",0)}});
}
