import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

let firebaseAuth=null;
export function getFirebaseAuth(){
 if(firebaseAuth)return firebaseAuth;
 if(!getApps().length){
  const raw=String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON||"").trim();
  if(!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON_NOT_CONFIGURED");
  const service=JSON.parse(raw);
  initializeApp({credential:cert({
   projectId:service.project_id||service.projectId,
   clientEmail:service.client_email||service.clientEmail,
   privateKey:String(service.private_key||service.privateKey||"").replace(/\\n/g,"\n")
  })});
 }
 firebaseAuth=getAuth();
 return firebaseAuth;
}
export async function verifyFirebaseToken(req){
 const header=String(req.headers.authorization||"");
 if(!header.startsWith("Bearer ")) return null;
 return getFirebaseAuth().verifyIdToken(header.slice(7).trim());
}
