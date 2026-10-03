import fs from "node:fs";
import path from "node:path";
import { sameTenant } from "../src/security.js";

const root=path.resolve("src");
const files=fs.readdirSync(root).filter(name=>name.endsWith(".js"));
const violations=[];

for(const file of files){
  const source=fs.readFileSync(path.join(root,file),"utf8");
  const hasUserAuth=/(requireUser|resolveFirebaseUser)\s*\(/.test(source);
  const acceptsExplicitUserId=/(req\.(params|query|body)[^\n]{0,120}\buserId\b)/.test(source);
  if(hasUserAuth && acceptsExplicitUserId){
    violations.push({
      file,
      reason:"Route accepts explicit userId input; bind resource ownership to authenticated context."
    });
  }
}

if(!sameTenant({id:"tenant-a"},"tenant-a") || sameTenant({id:"tenant-a"},"tenant-b")){
  throw new Error("TENANT_HELPER_REGRESSION");
}

if(violations.length){
  console.error("Potential tenant-boundary review findings:");
  for(const item of violations) console.error("- "+item.file+": "+item.reason);
  process.exitCode=1;
}else{
  console.log("Tenant boundary audit passed: "+files.length+" backend modules scanned.");
}
