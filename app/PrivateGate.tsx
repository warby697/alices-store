"use client";
import { useEffect, useState } from "react";

export function PrivateGate({children}:{children:React.ReactNode}){
 const [ready,setReady]=useState(false),[code,setCode]=useState(""),[error,setError]=useState("");
 useEffect(()=>{const host=location.hostname;const localNetwork=process.env.NODE_ENV==="development"||host==="localhost"||host==="127.0.0.1"||/^192\.168\./.test(host)||/^10\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host);if(localNetwork){setReady(true);return}const saved=sessionStorage.getItem("alice-access-code");if(saved)void verify(saved)},[]);
 const verify=async(value:string)=>{setError("");try{const r=await fetch("/api/state",{headers:{"x-store-access-code":value}});if(r.ok){sessionStorage.setItem("alice-access-code",value);setReady(true)}else setError("That access code was not recognised")}catch{setError("Unable to connect. Please try again.")}};
 if(ready)return <>{children}</>;
 return <main className="private-gate"><section><div className="brand-stamp">A</div><p className="eyebrow">Private catalogue preview</p><h1>Alice’s Store</h1><p>This version is for building the product catalogue before the shop trial.</p><form onSubmit={e=>{e.preventDefault();void verify(code)}}><label>Preview access code<input autoFocus inputMode="numeric" value={code} onChange={e=>setCode(e.target.value)} placeholder="Enter access code"/></label>{error&&<p className="error-note">{error}</p>}<button className="pay-button" disabled={!code}>Open catalogue</button></form></section></main>
}
