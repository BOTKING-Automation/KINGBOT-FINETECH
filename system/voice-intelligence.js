/*
 KINGBOT VOICE INTELLIGENCE
 ElevenLabs TTS + browser voice input fallback.
 API keys never enter the browser.
*/
(function(window){
  "use strict";

  if(window.__KINGBOT_VOICE_LOADED)return;
  window.__KINGBOT_VOICE_LOADED=true;

  const state={
    ready:false,
    speaking:false,
    recording:false,
    audio:null,
    scribeWs:null,
    scribeStream:null,
    scribeContext:null,
    scribeSource:null,
    scribeProcessor:null,
    latestText:"",
    latestTerminal:null,
    lastStatus:null
  };

  function notify(message,tone="good"){
    const toast=document.getElementById("toast");
    if(toast){
      toast.textContent=String(message||"");
      toast.dataset.tone=tone;
      toast.classList.add("show");
      clearTimeout(notify.timer);
      notify.timer=setTimeout(()=>toast.classList.remove("show"),2600);
    }
  }

  async function getStatus(){
    try{
      const data=await window.KINGBOT_API.json("/voice/status");
      state.ready=Boolean(data?.ttsConfigured);
      state.lastStatus=data;
      const el=document.getElementById("kbVoiceState");
      if(el){
        el.textContent=state.ready?"ELEVENLABS READY":"SET VOICE KEY";
        el.className="kb-voice-state "+(state.ready?"ready":"warn");
      }
      return data;
    }catch{
      state.ready=false;
      const el=document.getElementById("kbVoiceState");
      if(el){el.textContent="VOICE OFFLINE";el.className="kb-voice-state warn";}
      return null;
    }
  }

  function stop(){
    if(state.audio){
      try{state.audio.pause();state.audio.currentTime=0;}catch{}
    }
    state.audio=null;
    state.speaking=false;
    const b=document.getElementById("kbVoiceSpeak");
    if(b)b.textContent="▶ SPEAK";
  }

  async function speak(text){
    const clean=String(text||"").replace(/\s+/g," ").trim().slice(0,5000);
    if(!clean)return;
    if(!state.ready){
      await getStatus();
      if(!state.ready){notify("ElevenLabs voice is not configured on the backend.","warn");return;}
    }

    stop();
    state.latestText=clean;

    const button=document.getElementById("kbVoiceSpeak");
    if(button)button.textContent="◼ SPEAKING";

    try{
      const response=await window.KINGBOT_API.request("/voice/tts",{
        method:"POST",
        body:JSON.stringify({text:clean})
      });
      if(!response.ok){
        const detail=await response.json().catch(()=>({}));
        throw new Error(detail.error||detail.message||"VOICE_SYNTHESIS_FAILED");
      }

      const blob=await response.blob();
      const url=URL.createObjectURL(blob);
      const audio=new Audio(url);
      state.audio=audio;
      state.speaking=true;

      audio.onended=()=>{
        state.speaking=false;
        if(state.audio===audio)state.audio=null;
        URL.revokeObjectURL(url);
        if(button)button.textContent="▶ SPEAK";
      };
      audio.onerror=()=>{
        state.speaking=false;
        if(state.audio===audio)state.audio=null;
        URL.revokeObjectURL(url);
        if(button)button.textContent="▶ SPEAK";
        notify("Voice playback failed.","warn");
      };

      await audio.play();
    }catch(error){
      state.speaking=false;
      if(button)button.textContent="▶ SPEAK";
      notify(error?.message||"Voice synthesis unavailable.","warn");
    }
  }

  function terminalSummary(){
    const p=state.latestTerminal;
    if(!p)return "KINGBOT Terminal has not supplied a live snapshot yet.";
    const a=p.account||{};
    const positions=Array.isArray(p.positions)?p.positions:[];
    const n=v=>Number.isFinite(Number(v))?Number(v).toFixed(2):"unavailable";
    const parts=[
      "KINGBOT Terminal live state.",
      "Broker "+String(a.broker||"unknown")+".",
      "Mode "+String(a.executionMode||"unknown")+".",
      "Balance "+n(a.balance)+".",
      "Equity "+n(a.equity)+".",
      "Floating P and L "+n(a.floatingPnl)+".",
      positions.length+" open position"+(positions.length===1?"":"s")+"."
    ];
    return parts.join(" ");
  }

  function speakLatest(){
    if(state.latestText)return speak(state.latestText);
    return speak(terminalSummary());
  }

  function autoEnabled(){
    try{return localStorage.getItem("KINGBOT_VOICE_AUTOPLAY")==="1";}catch{return false;}
  }

  function onAiResponse(event){
    const text=String(event?.detail?.text||"").trim();
    if(!text)return;
    state.latestText=text;
    if(autoEnabled())void speak(text);
  }

  function onTerminalSnapshot(event){
    state.latestTerminal=event?.detail||null;
  }

  function floatTo16BitBase64(float32){
    const bytes=new Uint8Array(float32.length*2);
    const view=new DataView(bytes.buffer);
    for(let i=0;i<float32.length;i++){
      const sample=Math.max(-1,Math.min(1,float32[i]));
      view.setInt16(i*2,sample<0?sample*0x8000:sample*0x7fff,true);
    }
    let binary="";
    const step=0x8000;
    for(let i=0;i<bytes.length;i+=step){
      binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+step,bytes.length)));
    }
    return btoa(binary);
  }

  function downsampleTo16k(buffer,inputRate){
    const target=16000;
    if(inputRate===target)return buffer;
    const ratio=inputRate/target;
    const newLength=Math.max(1,Math.round(buffer.length/ratio));
    const result=new Float32Array(newLength);
    let offset=0;
    for(let i=0;i<newLength;i++){
      const start=Math.floor(i*ratio);
      const end=Math.min(buffer.length,Math.floor((i+1)*ratio));
      let total=0,count=0;
      for(let j=start;j<end;j++){total+=buffer[j];count++;}
      result[i]=count?total/count:buffer[Math.min(start,buffer.length-1)]||0;
      offset++;
    }
    return result;
  }

  function stopElevenScribe(){
    if(state.scribeWs){
      try{state.scribeWs.close();}catch{}
      state.scribeWs=null;
    }
    if(state.scribeProcessor){
      try{state.scribeProcessor.disconnect();}catch{}
      state.scribeProcessor=null;
    }
    if(state.scribeSource){
      try{state.scribeSource.disconnect();}catch{}
      state.scribeSource=null;
    }
    if(state.scribeStream){
      try{state.scribeStream.getTracks().forEach(track=>track.stop());}catch{}
      state.scribeStream=null;
    }
    if(state.scribeContext){
      try{void state.scribeContext.close();}catch{}
      state.scribeContext=null;
    }
    state.recording=false;
  }

  async function startElevenScribe(){
    if(!window.KINGBOT_API?.json)throw new Error("API_NOT_READY");
    const input=document.getElementById("commandInput");
    if(!input)throw new Error("Open the AI Command Console to use voice input.");

    const tokenResponse=await window.KINGBOT_API.json("/voice/scribe-token",{
      method:"POST",
      body:JSON.stringify({})
    });
    if(!tokenResponse?.token)throw new Error("ELEVENLABS_SCRIBE_TOKEN_UNAVAILABLE");

    if(!navigator.mediaDevices?.getUserMedia)throw new Error("MICROPHONE_API_UNAVAILABLE");

    const stream=await navigator.mediaDevices.getUserMedia({
      audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}
    });

    const wsUrl=
      "wss://api.elevenlabs.io/v1/speech-to-text/realtime"+
      "?model_id="+encodeURIComponent(tokenResponse.model||"scribe_v2_realtime")+
      "&token="+encodeURIComponent(tokenResponse.token)+
      "&audio_format=pcm_16000"+
      "&sample_rate=16000"+
      "&commit_strategy=vad"+
      "&language_code=en";

    const ws=new WebSocket(wsUrl);
    state.scribeWs=ws;
    state.scribeStream=stream;
    state.recording=true;

    const mic=document.getElementById("kbVoiceMic");
    if(mic)mic.textContent="● ELEVEN STT";

    await new Promise((resolve,reject)=>{
      let opened=false;

      ws.onopen=()=>{
        opened=true;
        try{
          const AudioContext=window.AudioContext||window.webkitAudioContext;
          if(!AudioContext)throw new Error("AUDIO_CONTEXT_UNAVAILABLE");

          const ctx=new AudioContext();
          state.scribeContext=ctx;
          const source=ctx.createMediaStreamSource(stream);
          const processor=ctx.createScriptProcessor(4096,1,1);
          state.scribeSource=source;
          state.scribeProcessor=processor;

          processor.onaudioprocess=event=>{
            if(ws.readyState!==WebSocket.OPEN||!state.recording)return;
            const mono=event.inputBuffer.getChannelData(0);
            const pcm=downsampleTo16k(mono,ctx.sampleRate);
            try{
              ws.send(JSON.stringify({
                message_type:"input_audio_chunk",
                audio_base_64:floatTo16BitBase64(pcm)
              }));
            }catch{}
          };

          source.connect(processor);
          processor.connect(ctx.destination);
          void ctx.resume();

          resolve();
        }catch(error){
          try{ws.close();}catch{}
          reject(error);
        }
      };

      ws.onerror=()=>{
        if(!opened)reject(new Error("ELEVENLABS_SCRIBE_CONNECTION_FAILED"));
      };

      ws.onclose=event=>{
        if(!opened)reject(new Error("ELEVENLABS_SCRIBE_CONNECTION_FAILED"));
        else if(state.recording && event.code!==1000)notify("ElevenLabs voice session closed.","warn");
        state.recording=false;
        if(mic)mic.textContent="⌕ VOICE INPUT";
        if(state.scribeWs===ws)stopElevenScribe();
      };

      ws.onmessage=event=>{
        try{
          const data=JSON.parse(event.data);
          if(data.message_type==="partial_transcript"){
            input.value=String(data.text||"");
          }else if(data.message_type==="committed_transcript"){
            const finalText=String(data.text||"").trim();
            if(finalText){
              input.value=(input.value?input.value+" ":"")+finalText;
              input.dispatchEvent(new Event("input",{bubbles:true}));
            }
          }else if(data.message_type==="error"||data.message_type==="rate_limited"){
            notify("ElevenLabs voice input is unavailable right now.","warn");
          }
        }catch{}
      };
    });

    notify("ElevenLabs Scribe is listening.","good");
  }

  function startBrowserSpeechInput(){
    const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SpeechRecognition){
      notify("Live voice input is not supported by this browser.","warn");
      return;
    }

    const input=document.getElementById("commandInput");
    if(!input){
      notify("Open the AI Command Console to use voice input.","warn");
      return;
    }

    const recognition=new SpeechRecognition();
    recognition.lang="en-US";
    recognition.continuous=false;
    recognition.interimResults=true;
    state.recording=true;

    const mic=document.getElementById("kbVoiceMic");
    if(mic)mic.textContent="● LISTENING";

    recognition.onresult=event=>{
      let transcript="";
      for(let i=0;i<event.results.length;i++)transcript+=event.results[i][0].transcript;
      input.value=transcript;
      input.dispatchEvent(new Event("input",{bubbles:true}));
    };

    recognition.onerror=event=>{
      notify("Voice input: "+String(event.error||"unavailable"),"warn");
    };

    recognition.onend=()=>{
      state.recording=false;
      if(mic)mic.textContent="⌕ VOICE INPUT";
      input.focus();
    };

    recognition.start();
  }

  async function startSpeechInput(){
    if(state.recording){
      stopElevenScribe();
      return;
    }
    try{
      await startElevenScribe();
    }catch(error){
      stopElevenScribe();
      notify("ElevenLabs STT unavailable; using browser voice input.","warn");
      startBrowserSpeechInput();
    }
  }

  function inject(){
    if(document.getElementById("kbVoiceDock"))return;

    const style=document.createElement("style");
    style.textContent=
      "#kbVoiceDock{position:fixed;right:18px;bottom:18px;z-index:2500;width:min(360px,calc(100vw - 24px));border:1px solid rgba(28,232,255,.20);border-radius:17px;background:linear-gradient(145deg,rgba(8,13,28,.96),rgba(3,6,15,.96));box-shadow:0 22px 70px rgba(0,0,0,.45),0 0 38px rgba(28,232,255,.08);backdrop-filter:blur(20px);font-family:Inter,system-ui,sans-serif}"+
      "#kbVoiceDock:before{content:\\\"\\\";display:block;height:2px;border-radius:17px 17px 0 0;background:linear-gradient(90deg,#19e6ff,#9b5cff,#ff4fd8,#ffc84a)}"+
      ".kb-voice-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 13px 8px}"+
      ".kb-voice-title{font:800 9px JetBrains Mono;letter-spacing:.12em;color:#eef4ff}"+
      ".kb-voice-state{font:800 7px JetBrains Mono;letter-spacing:.07em;padding:5px 7px;border-radius:999px;border:1px solid rgba(255,255,255,.08);color:#7f8aa3}"+
      ".kb-voice-state.ready{color:#8dffd4;border-color:rgba(46,243,162,.18);background:rgba(46,243,162,.045)}"+
      ".kb-voice-state.warn{color:#ffd57b;border-color:rgba(255,209,90,.17);background:rgba(255,209,90,.04)}"+
      ".kb-voice-controls{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:5px 13px 10px}"+
      ".kb-voice-btn{min-height:38px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.035);color:#dfe7f8;font:800 8px JetBrains Mono;letter-spacing:.05em}"+
      ".kb-voice-btn:hover{border-color:rgba(28,232,255,.25);background:rgba(28,232,255,.05)}"+
      ".kb-voice-btn.primary{color:#07111a;background:linear-gradient(135deg,#19e6ff,#8a69ff)}"+
      ".kb-voice-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 13px 12px;color:#77839b;font:700 8px JetBrains Mono}"+
      ".kb-voice-switch{display:flex;align-items:center;gap:7px}"+
      ".kb-voice-switch input{accent-color:#19e6ff}"+
      ".kb-voice-note{padding:9px 13px 12px;color:#59657d;font:700 7px/1.55 JetBrains Mono;border-top:1px solid rgba(255,255,255,.05)}"+
      "@media(max-width:520px){#kbVoiceDock{right:8px;bottom:8px;width:calc(100vw - 16px)}}";

    const dock=document.createElement("section");
    dock.id="kbVoiceDock";
    dock.innerHTML=
      '<div class="kb-voice-head">'+
        '<div class="kb-voice-title">KINGBOT · VOICE INTELLIGENCE</div>'+
        '<span id="kbVoiceState" class="kb-voice-state">CHECKING</span>'+
      '</div>'+
      '<div class="kb-voice-controls">'+
        '<button id="kbVoiceSpeak" class="kb-voice-btn primary" type="button">▶ SPEAK</button>'+
        '<button id="kbVoiceStateBtn" class="kb-voice-btn" type="button">◉ SPEAK STATE</button>'+
        '<button id="kbVoiceMic" class="kb-voice-btn" type="button">⌕ VOICE INPUT</button>'+
        '<button id="kbVoiceStop" class="kb-voice-btn" type="button">■ STOP</button>'+
      '</div>'+
      '<div class="kb-voice-row">'+
        '<label class="kb-voice-switch"><input id="kbVoiceAuto" type="checkbox"> AUTO-SPEAK AI RESPONSES</label>'+
        '<span>SECURE SERVER TTS</span>'+
      '</div>'+
      '<div class="kb-voice-note">Voice output is decision-support only. Voice input fills the AI console and never bypasses platform risk or execution controls.</div>';

    document.head.appendChild(style);
    document.body.appendChild(dock);

    document.getElementById("kbVoiceSpeak").addEventListener("click",()=>void speakLatest());
    document.getElementById("kbVoiceStateBtn").addEventListener("click",()=>void speak(terminalSummary()));
    document.getElementById("kbVoiceMic").addEventListener("click",startSpeechInput);
    document.getElementById("kbVoiceStop").addEventListener("click",stop);

    const auto=document.getElementById("kbVoiceAuto");
    auto.checked=autoEnabled();
    auto.addEventListener("change",event=>{
      try{localStorage.setItem("KINGBOT_VOICE_AUTOPLAY",event.target.checked?"1":"0");}catch{}
    });

    void getStatus();
    window.addEventListener("kingbot:session-change",()=>void getStatus());
    window.addEventListener("kingbot:access-ready",()=>void getStatus(),{once:false});
  }

  function init(){
    if(!window.KINGBOT_API?.request){
      window.setTimeout(init,400);
      return;
    }
    inject();
    window.addEventListener("kingbot:ai-response",onAiResponse);
    window.addEventListener("kingbot:terminal-snapshot",onTerminalSnapshot);
  }

  window.KINGBOT_VOICE={
    speak,
    stop,
    speakLatest,
    speakState:()=>speak(terminalSummary()),
    getState:()=>({...state})
  };

  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",init,{once:true});
  }else{
    init();
  }
})(window);
