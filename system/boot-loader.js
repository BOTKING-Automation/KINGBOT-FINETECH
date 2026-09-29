/* KINGBOT FINTECH — 20-second neural startup sequence */
(function(window,document){
"use strict";
if(document.documentElement.dataset.kingbotBootLoaded==="1")return;
document.documentElement.dataset.kingbotBootLoaded="1";
if(!/index\.html?$/i.test(window.location.pathname.split("/").pop()||"index.html"))return;
function inject(){
 if(document.getElementById("kb-boot-loader"))return;
 const style=document.createElement("style");
 style.id="kb-boot-style";
 style.textContent=`
html.kb-boot-lock,html.kb-boot-lock body{overflow:hidden!important}
#kb-boot-loader{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;overflow:hidden;background:#02040a;color:#eef3ff;font-family:Inter,system-ui,sans-serif}
#kb-boot-loader:before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 50% 42%,rgba(25,230,255,.11),transparent 22%),radial-gradient(circle at 15% 15%,rgba(255,79,216,.09),transparent 30%),radial-gradient(circle at 90% 82%,rgba(246,185,59,.09),transparent 29%),linear-gradient(145deg,#02040a,#050b18)}
#kb-boot-loader:after{content:"";position:absolute;inset:0;opacity:.22;background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:44px 44px;mask-image:linear-gradient(to bottom,black,transparent)}
.kb-boot-core{position:relative;z-index:2;width:min(760px,92vw);text-align:center;padding:28px 18px}
.kb-boot-brand{font:900 13px Orbitron,sans-serif;letter-spacing:.18em;background:linear-gradient(90deg,#19e6ff,#9b5cff,#ff4fd8,#f6b93b,#23f7a3,#19e6ff);background-size:350% auto;-webkit-background-clip:text;background-clip:text;color:transparent;animation:kbBootGradient 4s linear infinite}
.kb-boot-sub{margin-top:8px;color:#697695;font:700 7px JetBrains Mono,monospace;letter-spacing:.23em}
.kb-boot-stage{position:relative;width:min(520px,90vw);height:330px;margin:24px auto 14px;display:grid;place-items:center}
.kb-boot-halo{position:absolute;width:310px;height:310px;border-radius:50%;border:1px solid rgba(25,230,255,.18);box-shadow:0 0 65px rgba(25,230,255,.08),inset 0 0 55px rgba(246,185,59,.05);animation:kbBootSpin 15s linear infinite}
.kb-boot-halo:before,.kb-boot-halo:after{content:"";position:absolute;inset:28px;border-radius:50%;border:1px dashed rgba(155,92,255,.22);animation:kbBootSpinReverse 9s linear infinite}
.kb-boot-halo:after{inset:54px;border-style:solid;border-color:rgba(246,185,59,.16);animation-duration:13s}
.kb-boot-brain{position:relative;width:260px;height:208px;filter:drop-shadow(0 0 15px rgba(25,230,255,.24));animation:kbBootHue 5s linear infinite,kbBootFloat 2.2s ease-in-out infinite}
.kb-boot-brain svg{width:100%;height:100%;overflow:visible}
.kb-boot-brain .brain-fill{fill:url(#kbBrainGradient);fill-opacity:.16;stroke:url(#kbBrainStroke);stroke-width:2.2;stroke-linejoin:round}
.kb-boot-brain .brain-line{fill:none;stroke:url(#kbBrainStroke);stroke-width:1.8;stroke-linecap:round;filter:drop-shadow(0 0 5px rgba(25,230,255,.65))}
.kb-boot-candles{position:absolute;inset:auto 50% 33px;transform:translateX(-50%);width:210px;height:95px;display:flex;align-items:flex-end;justify-content:space-between;padding:0 15px;border-bottom:1px solid rgba(25,230,255,.25);background:linear-gradient(180deg,rgba(25,230,255,.03),rgba(155,92,255,.04));box-shadow:0 0 30px rgba(25,230,255,.05)}
.kb-candle{position:relative;width:15px;height:var(--h);background:linear-gradient(180deg,#23f7a3,#19e6ff);box-shadow:0 0 11px rgba(35,247,163,.5);animation:kbCandleGlow 1.4s ease-in-out infinite alternate}
.kb-candle:nth-child(2n){background:linear-gradient(180deg,#ff4fd8,#9b5cff);box-shadow:0 0 11px rgba(255,79,216,.48);animation-delay:.15s}
.kb-candle:nth-child(3n){background:linear-gradient(180deg,#f6b93b,#ff7a18);box-shadow:0 0 11px rgba(246,185,59,.45);animation-delay:.3s}
.kb-candle:before{content:"";position:absolute;left:50%;top:-18px;width:1px;height:18px;transform:translateX(-50%);background:currentColor;box-shadow:0 0 8px currentColor}.kb-candle:after{content:"";position:absolute;left:50%;bottom:-14px;width:1px;height:14px;transform:translateX(-50%);background:currentColor;box-shadow:0 0 8px currentColor}
.kb-boot-pulse{position:absolute;top:50%;left:50%;width:16px;height:16px;border-radius:50%;background:#19e6ff;box-shadow:0 0 20px #19e6ff,0 0 55px rgba(25,230,255,.5);transform:translate(-50%,-50%);animation:kbBootPulse 1.1s ease-in-out infinite}
.kb-boot-readout{display:flex;justify-content:space-between;gap:15px;width:min(520px,90vw);margin:0 auto;color:#677492;font:700 7px JetBrains Mono,monospace;letter-spacing:.08em}
.kb-boot-readout b{color:#eef3ff}
.kb-boot-status{min-height:21px;margin-top:18px;font:800 9px Orbitron,sans-serif;letter-spacing:.16em;background:linear-gradient(90deg,#19e6ff,#9b5cff,#ff4fd8,#f6b93b,#23f7a3);-webkit-background-clip:text;background-clip:text;color:transparent}
.kb-boot-progress{width:min(520px,90vw);height:4px;margin:12px auto 0;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden;border:1px solid rgba(255,255,255,.07)}
.kb-boot-progress i{display:block;width:0;height:100%;border-radius:999px;background:linear-gradient(90deg,#19e6ff,#9b5cff,#ff4fd8,#f6b93b,#23f7a3);box-shadow:0 0 16px rgba(25,230,255,.45);animation:kbBootProgress 20s linear forwards}
.kb-boot-foot{margin-top:14px;color:#4f5d78;font:600 6px JetBrains Mono,monospace;letter-spacing:.10em}
@keyframes kbBootGradient{to{background-position:350% center}} @keyframes kbBootSpin{to{transform:rotate(360deg)}} @keyframes kbBootSpinReverse{to{transform:rotate(-360deg)}} @keyframes kbBootHue{0%,100%{filter:drop-shadow(0 0 15px rgba(25,230,255,.24)) hue-rotate(0deg)}50%{filter:drop-shadow(0 0 23px rgba(255,79,216,.38)) hue-rotate(120deg)}} @keyframes kbBootFloat{50%{transform:translateY(-7px)}} @keyframes kbBootPulse{50%{transform:translate(-50%,-50%) scale(1.7);opacity:.45}} @keyframes kbCandleGlow{to{transform:translateY(-3px);filter:brightness(1.3)}} @keyframes kbBootProgress{to{width:100%}}
@media(prefers-reduced-motion:reduce){#kb-boot-loader *{animation-duration:.01ms!important;animation-iteration-count:1!important}}
`;
 document.head.appendChild(style);
 document.documentElement.classList.add("kb-boot-lock");
 const el=document.createElement("div");el.id="kb-boot-loader";el.setAttribute("aria-label","KINGBOT neural startup");
 el.innerHTML=`
 <div class="kb-boot-core">
  <div class="kb-boot-brand">KINGBOT FINTECH</div>
  <div class="kb-boot-sub">NEURAL TRADING INFRASTRUCTURE · SECURE INITIALIZATION</div>
  <div class="kb-boot-stage">
   <div class="kb-boot-halo"></div>
   <div class="kb-boot-brain">
    <svg viewBox="0 0 260 208" role="img" aria-label="Animated trading bot brain">
     <defs>
      <linearGradient id="kbBrainGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#19e6ff"/><stop offset="30%" stop-color="#9b5cff"/><stop offset="58%" stop-color="#ff4fd8"/><stop offset="78%" stop-color="#f6b93b"/><stop offset="100%" stop-color="#23f7a3"/></linearGradient>
      <linearGradient id="kbBrainStroke" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#19e6ff"/><stop offset="30%" stop-color="#9b5cff"/><stop offset="58%" stop-color="#ff4fd8"/><stop offset="78%" stop-color="#f6b93b"/><stop offset="100%" stop-color="#23f7a3"/></linearGradient>
     </defs>
     <path class="brain-fill" d="M126 26c-18-20-54-17-65 11-25-8-48 10-45 35-16 13-13 41 7 51-5 26 17 43 41 38 11 28 51 30 64 7 13 23 53 21 64-7 24 5 46-12 41-38 20-10 23-38 7-51 3-25-20-43-45-35-11-28-47-31-65-11Z"/>
     <path class="brain-line" d="M128 31v151M83 42c18 17 21 36 18 55-3 18 5 34 23 39M53 75c20 3 28 15 29 31M45 112c18-6 31 0 37 16M84 151c13-7 25-6 35 5M174 42c-18 17-21 36-18 55 3 18-5 34-23 39M204 75c-20 3-28 15-29 31M212 112c-18-6-31 0-37 16M173 151c-13-7-25-6-35 5M104 73c7-8 13-10 24-4M156 73c-7-8-13-10-24-4M100 112c10-9 20-9 28 0M160 112c-10-9-20-9-28 0"/>
    </svg>
    <div class="kb-boot-pulse"></div>
    <div class="kb-boot-candles">
      <i class="kb-candle" style="--h:26px;color:#23f7a3"></i><i class="kb-candle" style="--h:42px;color:#ff4fd8"></i><i class="kb-candle" style="--h:55px;color:#f6b93b"></i><i class="kb-candle" style="--h:34px;color:#19e6ff"></i><i class="kb-candle" style="--h:63px;color:#9b5cff"></i><i class="kb-candle" style="--h:47px;color:#ff4fd8"></i><i class="kb-candle" style="--h:70px;color:#23f7a3"></i><i class="kb-candle" style="--h:38px;color:#f6b93b"></i><i class="kb-candle" style="--h:58px;color:#19e6ff"></i>
    </div>
   </div>
  </div>
  <div class="kb-boot-readout"><span>AI CORE <b>ACTIVE</b></span><span>MARKET MATRIX <b>LINKING</b></span><span>AUTH <b>READY</b></span></div>
  <div class="kb-boot-status" id="kb-boot-status">NEURAL CORE INITIALIZING</div>
  <div class="kb-boot-progress"><i></i></div>
  <div class="kb-boot-foot">GIBSONFX TECH · KINGBOT FINTECH · 20.00 SEC STARTUP SEQUENCE</div>
 </div>`;
 (document.body || document.documentElement).prepend(el);
 const states=["NEURAL CORE INITIALIZING","MARKET MATRIX LINKING","BOT BRAIN SYNCHRONIZING","RISK ENGINE ONLINE","AUTH GATE READY"];
 let n=0;const status=el.querySelector("#kb-boot-status"),ticker=setInterval(()=>{n=(n+1)%states.length;status.textContent=states[n]},900);
 const remove=()=>{clearInterval(ticker);el.style.transition="opacity .45s ease";el.style.opacity="0";setTimeout(()=>{el.remove();document.documentElement.classList.remove("kb-boot-lock")},460)};
 const getLocalAuth=()=>{
  try{
    const user=window.KINGBOT_FIREBASE?.auth?.currentUser||null;
    if(user){
      return {authenticated:true,user:{verified:Boolean(user.emailVerified),email:user.email||""}};
    }
  }catch(error){
    console.warn("[KINGBOT BOOT] Local auth read failed:",error?.message||error);
  }
  return {authenticated:false,user:null};
 };

 const routeAfterBoot=async()=>{
  let session=getLocalAuth();

  if(!session.authenticated && window.KINGBOT_SESSION?.check){
    try{
      const checked=await Promise.race([
        window.KINGBOT_SESSION.check({force:true}),
        new Promise(resolve=>setTimeout(()=>resolve(null),1500))
      ]);
      if(checked) session=checked;
    }catch(error){
      console.warn("[KINGBOT BOOT] Session preflight failed:",error?.message||error);
    }
  }

  if(!session?.authenticated){
    window.location.replace("access.html");
    return;
  }

  if(!session?.user?.verified){
    window.location.replace("verify.html");
    return;
  }

  remove();
 };

 setTimeout(routeAfterBoot,20000);
}
inject();
})(window);
