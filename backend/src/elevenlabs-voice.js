import { Readable } from "node:stream";

const ELEVENLABS_API="https://api.elevenlabs.io/v1";
const DEFAULT_MODEL="eleven_flash_v2_5";
const DEFAULT_OUTPUT="mp3_44100_128";

function cleanEnv(value=""){
  return String(value||"").trim();
}

function cleanText(value,max=4000){
  return String(value||"").replace(/\s+/g," ").trim().slice(0,max);
}

function buildErrorPayload(data,fallback){
  const detail=data?.detail;
  if(typeof detail==="string")return detail;
  if(detail?.message)return detail.message;
  if(data?.message)return data.message;
  if(data?.error)return data.error;
  return fallback;
}

export function registerElevenLabsVoice(app,{requireUser,pool,rateLimit}={}){
  const apiKey=cleanEnv(process.env.ELEVENLABS_API_KEY);
  const voiceId=cleanEnv(process.env.ELEVENLABS_VOICE_ID);
  const modelId=cleanEnv(process.env.ELEVENLABS_MODEL)||DEFAULT_MODEL;
  const outputFormat=cleanEnv(process.env.ELEVENLABS_OUTPUT_FORMAT)||DEFAULT_OUTPUT;
  const ttsLimiter=typeof rateLimit==="function"
    ? rateLimit({
        windowMs:60*1000,
        limit:Number(process.env.ELEVENLABS_TTS_RPM||20),
        standardHeaders:"draft-8",
        legacyHeaders:false,
        message:{ok:false,error:"VOICE_RATE_LIMIT_REACHED"}
      })
    : (_req,_res,next)=>next();
  const tokenLimiter=typeof rateLimit==="function"
    ? rateLimit({
        windowMs:60*1000,
        limit:Number(process.env.ELEVENLABS_TOKEN_RPM||10),
        standardHeaders:"draft-8",
        legacyHeaders:false,
        message:{ok:false,error:"VOICE_TOKEN_RATE_LIMIT_REACHED"}
      })
    : (_req,_res,next)=>next();

  app.get("/api/voice/status",async(req,res)=>{
    const user=await requireUser(pool,req,res);
    if(!user)return;

    res.json({
      ok:true,
      provider:"elevenlabs",
      configured:Boolean(apiKey&&voiceId),
      ttsConfigured:Boolean(apiKey&&voiceId),
      sttConfigured:Boolean(apiKey),
      model:modelId,
      outputFormat,
      voiceConfigured:Boolean(voiceId),
      source:"server-side-elevenlabs"
    });
  });

  app.post("/api/voice/tts",ttsLimiter,async(req,res)=>{
    const user=await requireUser(pool,req,res);
    if(!user)return;

    if(!apiKey||!voiceId){
      return res.status(503).json({
        ok:false,
        error:"ELEVENLABS_TTS_NOT_CONFIGURED",
        message:"Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in the server environment."
      });
    }

    const text=cleanText(req.body?.text,4000);
    if(!text){
      return res.status(400).json({ok:false,error:"VOICE_TEXT_REQUIRED"});
    }

    try{
      const upstream=await fetch(
        ELEVENLABS_API+"/text-to-speech/"+encodeURIComponent(voiceId)+"/stream?output_format="+encodeURIComponent(outputFormat),
        {
          method:"POST",
          headers:{
            "xi-api-key":apiKey,
            "Content-Type":"application/json",
            "Accept":"audio/mpeg"
          },
          body:JSON.stringify({
            text,
            model_id:modelId
          })
        }
      );

      if(!upstream.ok){
        const data=await upstream.json().catch(()=>({}));
        return res.status(upstream.status>=400&&upstream.status<500?400:502).json({
          ok:false,
          error:"ELEVENLABS_TTS_FAILED",
          message:buildErrorPayload(data,"ElevenLabs text-to-speech request failed.")
        });
      }

      res.statusCode=200;
      res.setHeader("Content-Type",upstream.headers.get("content-type")||"audio/mpeg");
      res.setHeader("Cache-Control","no-store");
      res.setHeader("Content-Disposition",'inline; filename="kingbot-voice.mp3"');
      res.setHeader("X-KINGBOT-Voice-Provider","elevenlabs");

      if(!upstream.body){
        const buffer=Buffer.from(await upstream.arrayBuffer());
        return res.end(buffer);
      }

      Readable.fromWeb(upstream.body).pipe(res);
    }catch(error){
      console.error("[KINGBOT VOICE] TTS failed:",error?.message||error);
      if(!res.headersSent){
        return res.status(502).json({
          ok:false,
          error:"ELEVENLABS_TTS_UNAVAILABLE",
          message:"Voice synthesis service is temporarily unavailable."
        });
      }
      try{res.end();}catch{}
    }
  });

  app.post("/api/voice/scribe-token",tokenLimiter,async(req,res)=>{
    const user=await requireUser(pool,req,res);
    if(!user)return;

    if(!apiKey){
      return res.status(503).json({
        ok:false,
        error:"ELEVENLABS_STT_NOT_CONFIGURED"
      });
    }

    try{
      const upstream=await fetch(ELEVENLABS_API+"/single-use-token/realtime_scribe",{
        method:"POST",
        headers:{
          "xi-api-key":apiKey,
          "Accept":"application/json"
        }
      });
      const data=await upstream.json().catch(()=>({}));
      if(!upstream.ok||!data?.token){
        return res.status(upstream.status>=400&&upstream.status<500?400:502).json({
          ok:false,
          error:"ELEVENLABS_SCRIBE_TOKEN_FAILED",
          message:buildErrorPayload(data,"Unable to create a realtime speech token.")
        });
      }
      res.json({
        ok:true,
        token:data.token,
        model:"scribe_v2_realtime",
        expiresInSeconds:900,
        source:"server-issued-single-use-token"
      });
    }catch(error){
      console.error("[KINGBOT VOICE] Scribe token failed:",error?.message||error);
      res.status(502).json({
        ok:false,
        error:"ELEVENLABS_SCRIBE_TOKEN_UNAVAILABLE"
      });
    }
  });
}
