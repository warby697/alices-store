"use client";

import { useEffect, useState } from "react";
import { loadLiveState, saveLiveState } from "./live-store";

// Stock counting, the shopping trip list and the stock movement log were taken
// out in Nov 2026 (the shop shops from the shelves, not from counts). What
// remains: Staff accounts, Controls and the audit trail. The old shopping,
// supplier and stock-log data is still stored; nothing here reads it.

type Member = { id:string; name:string; pin:string; role:"Admin"|"Staff"; accessible:boolean; active:boolean };
type Audit = { id:string; at:string; action:string; detail:string; staff:string };
const AUDIT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export function AdminPanel({currentStaff}:{currentStaff:string}){
 const [tab,setTab]=useState<"staff"|"controls">("staff");
 const [team,setTeam]=useState<Member[]>([]),[audits,setAudits]=useState<Audit[]>([]),[ready,setReady]=useState(false);
 const [member,setMember]=useState<Member|null>(null);
 const [settings,setSettings]=useState({shopName:"Alice’s Store Ltd",lowStock:4,targetMargin:30,reconcile:true,spoken:true});
 useEffect(()=>{void(async()=>{const live=await loadLiveState(["team","audit","settings"]);setTeam(Array.isArray(live.team)?live.team as Member[]:[]);setAudits(Array.isArray(live.audit)?live.audit as Audit[]:[]);if(live.settings)setSettings(live.settings as typeof settings);setReady(true)})()},[]);
 useEffect(()=>{if(ready)saveLiveState({team})},[team,ready]);useEffect(()=>{if(ready)saveLiveState({audit:audits})},[audits,ready]);useEffect(()=>{if(ready)saveLiveState({settings})},[settings,ready]);
 // The audit trail keeps a full, accurate 7 days rather than a fixed number
 // of entries - a busy week can no longer push events out early.
 const log=(action:string,detail:string)=>setAudits(a=>[{id:crypto.randomUUID(),at:new Date().toISOString(),action,detail,staff:currentStaff},...a].filter(entry=>Date.now()-new Date(entry.at).getTime()<AUDIT_KEEP_MS));
 const recentAudits=audits.filter(entry=>Date.now()-new Date(entry.at).getTime()<AUDIT_KEEP_MS);
 return <section className="admin-page">
  <div className="admin-tabs">{[["staff","Staff"],["controls","Controls & audit"]].map(([id,label])=><button key={id} className={tab===id?"active":""} onClick={()=>setTab(id as typeof tab)}>{label}</button>)}</div>
  {tab==="staff"&&<article className="report-card"><div className="section-title"><h2>Staff accounts</h2><button className="primary-small" onClick={()=>setMember({id:crypto.randomUUID(),name:"",pin:"",role:"Staff",accessible:false,active:true})}>+ Add staff member</button></div>{team.map(m=><div className="member-row" key={m.id}><span className="avatar">{m.name.slice(0,2).toUpperCase()}</span><span><strong>{m.name}</strong><small>{m.role}</small></span><b className={m.active?"status-on":"status-off"}>{m.active?"Active":"Inactive"}</b><button onClick={()=>setMember(m)}>Edit</button></div>)}</article>}
  {tab==="controls"&&<div className="admin-grid"><article className="report-card admin-form"><div className="section-title"><h2>Shop controls</h2><span>Saved automatically</span></div><label>Shop name<input value={settings.shopName} onChange={e=>setSettings({...settings,shopName:e.target.value})}/></label><div className="form-pair"><label>Target margin %<input type="number" min="0" value={settings.targetMargin} onChange={e=>setSettings({...settings,targetMargin:Math.max(0,Number(e.target.value)||0)})}/></label></div><p className="cash-instruction">The target margin drives the minimum-price hint when adding or editing a product.</p></article><article className="report-card"><div className="section-title"><h2>Audit trail</h2><span>Last 7 days · {recentAudits.length} changes</span></div>{recentAudits.map(a=><div className="audit-row" key={a.id}><i>✓</i><span><strong>{a.action}</strong><small>{a.detail} · {a.staff}</small></span><time>{new Date(a.at).toLocaleString("en-GB",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}</time></div>)}{!recentAudits.length&&<div className="empty-report">Changes and refunds will appear here.</div>}</article></div>}
  {member&&<div className="modal-backdrop"><form className="edit-modal" onSubmit={e=>{e.preventDefault();setTeam(t=>t.some(x=>x.id===member.id)?t.map(x=>x.id===member.id?member:x):[...t,member]);log("Staff account saved",member.name);setMember(null)}}><button type="button" className="modal-close" onClick={()=>setMember(null)}>x</button><p className="eyebrow">Staff access</p><h2>Staff member</h2><div className="form-grid"><label className="wide">Name<input required value={member.name} onChange={e=>setMember({...member,name:e.target.value})}/></label><label>Four-digit PIN<input required pattern="[0-9]{4}" maxLength={4} value={member.pin} onChange={e=>setMember({...member,pin:e.target.value.replace(/\D/g,"")})}/></label><label>Role<select value={member.role} onChange={e=>setMember({...member,role:e.target.value as "Admin"|"Staff"})}><option>Staff</option><option>Admin</option></select></label><label className="toggle-row wide"><input type="checkbox" checked={member.accessible} onChange={e=>setMember({...member,accessible:e.target.checked})}/> Spoken high-contrast mode</label><label className="toggle-row wide"><input type="checkbox" checked={member.active} onChange={e=>setMember({...member,active:e.target.checked})}/> Account active</label></div><button className="pay-button">Save staff member</button></form></div>}
 </section>
}
