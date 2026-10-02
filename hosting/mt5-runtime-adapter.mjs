import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const TERMINAL_EXE=String(process.env.KINGBOT_MT5_TERMINAL_EXE||"C:\\Program Files\\MetaTrader 5\\terminal64.exe");
const METAEDITOR_EXE=String(process.env.KINGBOT_MT5_METAEDITOR_EXE||"C:\\Program Files\\MetaTrader 5\\metaeditor64.exe");
const RUNTIME_ROOT=path.resolve(String(process.env.KINGBOT_MT5_RUNTIME_ROOT||path.join(process.env.ProgramData||"C:\\ProgramData","KINGBOT","mt5")));
const SOURCE_ROOT=path.resolve(String(process.env.KINGBOT_MT5_SOURCE_ROOT||path.resolve(process.cwd(),"mt5")));

const BOT_EA_FILES={
  strategic:"KINGBOT_STRATEGIC.ex5",
  flipper:"KINGBOT_FLIPPER.ex5",
  breakout:"KINGBOT_BREAKOUT.ex5",
  "smc-pro":"KINGBOT_SMC_PRO.ex5",
  "ladder-flip":"KINGBOT_LADDER_FLIP_V8.ex5"
};
const BOT_EA_SOURCES={
  strategic:"KINGBOT_STRATEGIC.mq5",
  flipper:"KINGBOT_FLIPPER.mq5",
  breakout:"KINGBOT_BREAKOUT.mq5",
  "smc-pro":"KINGBOT_SMC_PRO.mq5",
  "ladder-flip":"KINGBOT_LADDER_FLIP_V8.mq5"
};

function clean(value,max=240){return String(value??"").trim().slice(0,max);}
async function exists(file){try{await fs.access(file);return true;}catch{return false;}}
async function run(command,args=[],timeoutMs=30000){
  return await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{windowsHide:true});
    let stdout="",stderr="",settled=false;
    const timer=setTimeout(()=>{if(!settled){settled=true;child.kill();reject(new Error("PROCESS_TIMEOUT"));}},timeoutMs);
    child.stdout?.on("data",d=>{stdout+=d;});
    child.stderr?.on("data",d=>{stderr+=d;});
    child.on("error",e=>{if(!settled){settled=true;clearTimeout(timer);reject(e);}});
    child.on("close",code=>{if(settled)return;settled=true;clearTimeout(timer);resolve({code,stdout,stderr});});
  });
}

export class Mt5RuntimeAdapter{
  constructor({terminalExe=TERMINAL_EXE,metaeditorExe=METAEDITOR_EXE,runtimeRoot=RUNTIME_ROOT,sourceRoot=SOURCE_ROOT}={}){
    this.terminalExe=terminalExe;
    this.metaeditorExe=metaeditorExe;
    this.runtimeRoot=runtimeRoot;
    this.sourceRoot=sourceRoot;
    this.processes=new Map();
  }

  async preflight(){
    if(process.platform!=="win32")return {ok:false,error:"MT5_HOST_REQUIRES_WINDOWS_RUNTIME"};
    if(!(await exists(this.terminalExe)))return {ok:false,error:"MT5_TERMINAL_NOT_FOUND",terminalExe:this.terminalExe};
    return {ok:true,terminalExe:this.terminalExe,metaeditorAvailable:await exists(this.metaeditorExe),runtimeRoot:this.runtimeRoot};
  }

  async prepareDeployment(deployment){
    const id=clean(deployment?.id,100);
    const botId=clean(deployment?.bot_id||"strategic",60).toLowerCase();
    if(!id)throw new Error("DEPLOYMENT_ID_REQUIRED");
    if(!BOT_EA_FILES[botId])throw new Error("UNSUPPORTED_BOT_ID");
    const check=await this.preflight();
    if(!check.ok)throw new Error(check.error);

    const terminalRoot=path.join(this.runtimeRoot,id);
    const expertsRoot=path.join(terminalRoot,"MQL5","Experts","KINGBOT");
    await fs.mkdir(expertsRoot,{recursive:true});

    const manifest={
      deploymentId:id,
      botId,
      executionMode:String(deployment.execution_mode||"DEMO").toUpperCase(),
      terminalRoot,
      terminalExe:this.terminalExe,
      eaFile:BOT_EA_FILES[botId],
      preparedAt:new Date().toISOString(),
      host:os.hostname()
    };
    await fs.writeFile(path.join(terminalRoot,"deployment.json"),JSON.stringify(manifest,null,2),"utf8");

    const source=path.join(this.sourceRoot,BOT_EA_SOURCES[botId]);
    const compiled=path.join(this.sourceRoot,BOT_EA_FILES[botId]);

    if(await exists(compiled)){
      await fs.copyFile(compiled,path.join(expertsRoot,BOT_EA_FILES[botId]));
    }else if(await exists(source)&&await exists(this.metaeditorExe)){
      const compile=await run(this.metaeditorExe,["/compile:"+source,"/log"],120000);
      if(compile.code!==0||!(await exists(compiled)))throw new Error("EA_COMPILE_FAILED");
      await fs.copyFile(compiled,path.join(expertsRoot,BOT_EA_FILES[botId]));
    }else{
      throw new Error("EA_ARTIFACT_NOT_AVAILABLE");
    }
    return manifest;
  }

  async launchDeployment(deployment){
    const id=clean(deployment?.id,100);
    const manifest=JSON.parse(await fs.readFile(path.join(this.runtimeRoot,id,"deployment.json"),"utf8"));
    const child=spawn(this.terminalExe,["/portable"],{cwd:manifest.terminalRoot,detached:true,stdio:"ignore",windowsHide:true});
    child.unref();
    this.processes.set(id,{pid:child.pid,startedAt:Date.now(),terminalData:manifest.terminalRoot});
    return {pid:child.pid,startedAt:new Date().toISOString(),terminalData:manifest.terminalRoot};
  }

  async stopDeployment(deploymentId){
    const id=clean(deploymentId,100);
    const proc=this.processes.get(id);
    if(proc?.pid){
      const killer=spawn("taskkill",["/PID",String(proc.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
      await new Promise(resolve=>killer.on("close",resolve));
      this.processes.delete(id);
    }
    return {stopped:true};
  }

  async inspectDeployment(deploymentId){
    const id=clean(deploymentId,100);
    const manifestPath=path.join(this.runtimeRoot,id,"deployment.json");
    if(!(await exists(manifestPath)))return {ready:false,error:"DEPLOYMENT_MANIFEST_NOT_FOUND"};
    const manifest=JSON.parse(await fs.readFile(manifestPath,"utf8"));
    return {ready:true,running:Boolean(this.processes.get(id)),manifest,pid:this.processes.get(id)?.pid||null};
  }
}
