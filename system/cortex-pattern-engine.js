(function(root,factory){
  "use strict";
  const api=factory();
  root.KINGBOT_CORTEX_PATTERNS=api;
  if(typeof module==="object"&&module&&module.exports)module.exports=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const TF_SECONDS={"1m":60,"3m":180,"5m":300,"15m":900,"30m":1800,"1h":3600,"2h":7200,"4h":14400,"1d":86400,"1w":604800};
  const finite=value=>{const n=Number(value);return Number.isFinite(n)?n:null;};
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
  const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
  function seconds(value){
    if(value&&typeof value==="object"&&Number.isFinite(value.year))return Math.floor(Date.UTC(value.year,value.month-1,value.day)/1000);
    const n=Number(value);
    if(Number.isFinite(n)&&n>0)return Math.floor(n>1e12?n/1000:n);
    const parsed=Date.parse(String(value||""));
    return Number.isFinite(parsed)&&parsed>0?Math.floor(parsed/1000):null;
  }
  function normalizeBars(input,timeframe,now){
    const interval=TF_SECONDS[String(timeframe||"5m").toLowerCase()]||300,byTime=new Map();
    for(const row of Array.isArray(input)?input:[]){
      if(!row||typeof row!=="object")continue;
      const time=seconds(row.time??row.timestamp??row.datetime),open=finite(row.open),high=finite(row.high),low=finite(row.low),close=finite(row.close);
      if(!Number.isSafeInteger(time)||![open,high,low,close].every(Number.isFinite))continue;
      if(low<=0||high<low||high<Math.max(open,close)||low>Math.min(open,close))continue;
      byTime.set(time,{time,open,high,low,close,volume:finite(row.volume)});
    }
    const bars=[...byTime.values()].sort((a,b)=>a.time-b.time);
    let activeBarTime=null;
    const last=bars[bars.length-1];
    if(last&&now>=last.time*1000&&now<(last.time+interval)*1000){activeBarTime=last.time;bars.pop();}
    return {bars,interval,activeBarTime};
  }
  function averageTrueRange(bars,period=14){
    if(bars.length<period+1)return null;
    const ranges=[];
    for(let i=Math.max(1,bars.length-period);i<bars.length;i++){
      const bar=bars[i],previous=bars[i-1];
      ranges.push(Math.max(bar.high-bar.low,Math.abs(bar.high-previous.close),Math.abs(bar.low-previous.close)));
    }
    return mean(ranges);
  }
  function findPivots(bars,left=3,right=3){
    const highs=[],lows=[],events=[];
    for(let i=left;i<bars.length-right;i++){
      const bar=bars[i];
      const isHigh=bars.slice(i-left,i).every(item=>item.high<=bar.high)&&bars.slice(i+1,i+1+right).every(item=>item.high<bar.high);
      const isLow=bars.slice(i-left,i).every(item=>item.low>=bar.low)&&bars.slice(i+1,i+1+right).every(item=>item.low>bar.low);
      if(isHigh&&!isLow){const point={index:i,time:bar.time,price:bar.high,kind:"H"};highs.push(point);events.push(point);}
      if(isLow&&!isHigh){const point={index:i,time:bar.time,price:bar.low,kind:"L"};lows.push(point);events.push(point);}
    }
    return {highs,lows,events};
  }
  function makePattern(type,name,direction,state,qualityScore,summary,points,lines,levels,extra){
    const allTimes=(points||[]).map(point=>point.time).filter(Number.isFinite);
    return {id:type+":"+String(allTimes[0]||"")+":"+String(allTimes[allTimes.length-1]||""),type,name,direction,state,qualityScore:Math.round(clamp(qualityScore,0,100)),summary,points:points||[],lines:lines||[],levels:levels||[],...(extra||{})};
  }
  function detectCandles(bars,atr){
    const found=[];if(bars.length<3)return found;
    const n=bars.length,last=bars[n-1],previous=bars[n-2],before=bars[n-3];
    const candle=bar=>({body:Math.abs(bar.close-bar.open),range:Math.max(bar.high-bar.low,1e-12),upper:bar.high-Math.max(bar.open,bar.close),lower:Math.min(bar.open,bar.close)-bar.low});
    const a=candle(last),b=candle(previous),c=candle(before);
    const add=(type,name,direction,quality,summary,items)=>{
      const points=items.map(item=>({time:item.time,price:direction==="BEARISH"?item.high:item.low,label:"CANDLE"}));
      found.push(makePattern(type,name,direction,"CONFIRMED",quality,summary,points,[],[],{startTime:items[0].time,endTime:last.time,trigger:null,invalidation:null,target:null,confirmation:"Closed-candle formation"}));
    };
    if(previous.close<previous.open&&last.close>last.open&&last.open<=previous.close&&last.close>=previous.open)
      add("BULLISH_ENGULFING","Bullish Engulfing","BULLISH",82,"Completed bullish body engulfs the preceding bearish body.",[previous,last]);
    else if(previous.close>previous.open&&last.close<last.open&&last.open>=previous.close&&last.close<=previous.open)
      add("BEARISH_ENGULFING","Bearish Engulfing","BEARISH",82,"Completed bearish body engulfs the preceding bullish body.",[previous,last]);
    const bodyFloor=Math.max(a.body,last.close*0.00001);
    if(a.lower>=bodyFloor*2.1&&a.upper<=bodyFloor*0.8&&a.body/a.range<=0.42)
      add("HAMMER","Hammer","BULLISH",74,"Long lower rejection wick; market context is required.",[last]);
    if(a.upper>=bodyFloor*2.1&&a.lower<=bodyFloor*0.8&&a.body/a.range<=0.42)
      add("SHOOTING_STAR","Shooting Star","BEARISH",74,"Long upper rejection wick; market context is required.",[last]);
    const smallMiddle=b.body<=Math.max(c.body*0.45,(atr||last.close*0.001)*0.18);
    if(before.close<before.open&&smallMiddle&&last.close>last.open&&last.close>=(before.open+before.close)/2)
      add("MORNING_STAR","Morning Star","BULLISH",84,"Three-candle reversal completed above the first candle midpoint.",[before,previous,last]);
    if(before.close>before.open&&smallMiddle&&last.close<last.open&&last.close<=(before.open+before.close)/2)
      add("EVENING_STAR","Evening Star","BEARISH",84,"Three-candle reversal completed below the first candle midpoint.",[before,previous,last]);
    if(a.body/a.range<=0.08)add("DOJI","Doji","NEUTRAL",68,"Small real body relative to range; indecision, not direction.",[last]);
    if(last.high<previous.high&&last.low>previous.low)add("INSIDE_BAR","Inside Bar","NEUTRAL",66,"Completed candle is contained within the preceding range.",[previous,last]);
    else if(last.high>previous.high&&last.low<previous.low)add("OUTSIDE_BAR","Outside Bar",last.close>last.open?"BULLISH":last.close<last.open?"BEARISH":"NEUTRAL",70,"Completed candle expands beyond both sides of the preceding range.",[previous,last]);
    return found;
  }
  function detectDoublePatterns(bars,pivots,atr){
    const found=[],last=bars[bars.length-1],n=bars.length,tolerance=Math.max((atr||last.close*0.001)*0.48,Math.abs(last.close)*0.00045);
    const search=(points,kind)=>{
      for(let i=points.length-1;i>=1;i--){
        const second=points[i];if(second.index<n-5)continue;
        for(let j=i-1;j>=Math.max(0,i-5);j--){
          const first=points[j],separation=second.index-first.index;
          if(separation<6||separation>65||Math.abs(first.price-second.price)>tolerance)continue;
          const between=bars.slice(first.index+1,second.index);if(between.length<3)continue;
          const necklinePoint=kind==="TOP"
            ?between.reduce((best,bar,index)=>bar.low<best.price?{price:bar.low,index:first.index+1+index}:best,{price:Infinity,index:first.index+1})
            :between.reduce((best,bar,index)=>bar.high>best.price?{price:bar.high,index:first.index+1+index}:best,{price:-Infinity,index:first.index+1});
          const neckline=necklinePoint.price;if(!Number.isFinite(neckline))continue;
          const height=kind==="TOP"?Math.max(first.price,second.price)-neckline:neckline-Math.min(first.price,second.price);if(height<=0)continue;
          const confirmed=kind==="TOP"?last.close<neckline-(atr||0)*0.06:last.close>neckline+(atr||0)*0.06;
          const invalidated=kind==="TOP"?last.close>Math.max(first.price,second.price)+(atr||0)*0.35:last.close<Math.min(first.price,second.price)-(atr||0)*0.35;
          const state=confirmed?"CONFIRMED":invalidated?"INVALIDATED":"DEVELOPING",name=kind==="TOP"?"Double Top":"Double Bottom",direction=kind==="TOP"?"BEARISH":"BULLISH";
          const target=kind==="TOP"?neckline-height:neckline+height,levelTo=last.time;
          const pointsOut=[{time:first.time,price:first.price,label:"A"},{time:bars[necklinePoint.index].time,price:neckline,label:"NECK"},{time:second.time,price:second.price,label:"B"}];
          const levels=[
            {price:neckline,label:"NECKLINE",role:"neckline",fromTime:first.time,toTime:levelTo},
            {price:target,label:"MEASURED TARGET",role:"target",fromTime:second.time,toTime:levelTo},
            {price:kind==="TOP"?Math.max(first.price,second.price)+tolerance:Math.min(first.price,second.price)-tolerance,label:"INVALIDATION",role:"invalidation",fromTime:second.time,toTime:levelTo}
          ];
          found.push(makePattern(kind==="TOP"?"DOUBLE_TOP":"DOUBLE_BOTTOM",name,direction,state,82-Math.round(Math.abs(first.price-second.price)/Math.max(tolerance,1e-9)*18),
            confirmed?"Neckline breached by a completed candle.":invalidated?"Price crossed the pattern invalidation boundary.":"Two comparable pivots formed; wait for a completed neckline breakout.",
            pointsOut,[{fromTime:first.time,fromPrice:first.price,toTime:second.time,toPrice:second.price,label:"TWIN PEAKS"},{fromTime:bars[necklinePoint.index].time,fromPrice:neckline,toTime:last.time,toPrice:neckline,label:"NECKLINE"}],levels,
            {startTime:first.time,endTime:last.time,trigger:{price:neckline,condition:kind==="TOP"?"Completed close below neckline":"Completed close above neckline"},invalidation:{price:levels[2].price,condition:"Close beyond opposite boundary"},target:{price:target,method:"Measured pattern height"}}));
          return;
        }
        if(found.length)break;
      }
    };
    search(pivots.highs.filter(point=>point.index>=n-90),"TOP");
    search(pivots.lows.filter(point=>point.index>=n-90),"BOTTOM");
    return found;
  }
  function detectHeadAndShoulders(bars,pivots,atr){
    const found=[],events=pivots.events.filter(point=>point.index>=bars.length-100);if(events.length<5)return found;
    for(let i=events.length-5;i>=Math.max(0,events.length-13);i--){
      const seq=events.slice(i,i+5),kinds=seq.map(point=>point.kind).join("");
      if(kinds!=="HLHLH"&&kinds!=="LHLHL")continue;
      const inverse=kinds==="LHLHL",left=seq[0],neck1=seq[1],head=seq[2],neck2=seq[3],right=seq[4];
      const tolerance=Math.max((atr||head.price*0.001)*0.8,head.price*0.0007),shoulderDiff=Math.abs(left.price-right.price);
      const clearance=inverse?Math.min(left.price,right.price)-head.price:head.price-Math.max(left.price,right.price);
      if(shoulderDiff>tolerance||clearance<(atr||head.price*0.001)*0.45)continue;
      const neckline=(neck1.price+neck2.price)/2,last=bars[bars.length-1];
      const confirmed=inverse?last.close>neckline+(atr||0)*0.06:last.close<neckline-(atr||0)*0.06;
      const invalidated=inverse?last.close<head.price-(atr||0)*0.2:last.close>head.price+(atr||0)*0.2;
      const state=confirmed?"CONFIRMED":invalidated?"INVALIDATED":"DEVELOPING",direction=inverse?"BULLISH":"BEARISH";
      const height=inverse?neckline-head.price:head.price-neckline;if(height<=0)continue;
      const name=inverse?"Inverse Head and Shoulders":"Head and Shoulders",target=inverse?neckline+height:neckline-height;
      const points=seq.map((point,index)=>({time:point.time,price:point.price,label:["LS","N1","HEAD","N2","RS"][index]}));
      const levels=[{price:neckline,label:"NECKLINE",role:"neckline",fromTime:left.time,toTime:last.time},{price:target,label:"MEASURED TARGET",role:"target",fromTime:right.time,toTime:last.time}];
      found.push(makePattern(inverse?"INVERSE_HEAD_SHOULDERS":"HEAD_SHOULDERS",name,direction,state,84-Math.round(shoulderDiff/Math.max(tolerance,1e-9)*16),
        confirmed?"Neckline broken by a completed candle.":"Shoulder/head geometry is present; completed neckline break is still required.",points,
        [{fromTime:left.time,fromPrice:left.price,toTime:head.time,toPrice:head.price,label:"LEFT SHOULDER → HEAD"},{fromTime:head.time,fromPrice:head.price,toTime:right.time,toPrice:right.price,label:"HEAD → RIGHT SHOULDER"},{fromTime:neck1.time,fromPrice:neck1.price,toTime:neck2.time,toPrice:neck2.price,label:"NECKLINE"}],
        levels,{startTime:left.time,endTime:last.time,trigger:{price:neckline,condition:inverse?"Completed close above neckline":"Completed close below neckline"},invalidation:{price:head.price,condition:"Close beyond head extreme"},target:{price:target,method:"Head-to-neckline measured move"}}));
      break;
    }
    return found;
  }
  function linearFit(points){
    if(points.length<2)return null;
    const xMean=mean(points.map(point=>point.index)),yMean=mean(points.map(point=>point.price));let numerator=0,denominator=0;
    points.forEach(point=>{numerator+=(point.index-xMean)*(point.price-yMean);denominator+=(point.index-xMean)**2;});
    if(!denominator)return null;const slope=numerator/denominator;
    return {slope,intercept:yMean-slope*xMean,at:index=>slope*index+(yMean-slope*xMean)};
  }
  function detectConvergingPatterns(bars,pivots,atr){
    const n=bars.length,last=bars[n-1],highs=pivots.highs.filter(p=>p.index>=n-55).slice(-4),lows=pivots.lows.filter(p=>p.index>=n-55).slice(-4);
    if(highs.length<3||lows.length<3)return [];
    const top=linearFit(highs),bottom=linearFit(lows);if(!top||!bottom)return [];
    const startIndex=Math.max(Math.min(highs[0].index,lows[0].index),n-55),endIndex=n-1;
    const upperStart=top.at(startIndex),lowerStart=bottom.at(startIndex),upperNow=top.at(endIndex),lowerNow=bottom.at(endIndex);
    const startGap=upperStart-lowerStart,endGap=upperNow-lowerNow;if(startGap<=0||endGap<=0||endGap>=startGap*0.86)return [];
    const scale=atr||Math.abs(last.close)*0.001,upperMove=upperNow-upperStart,lowerMove=lowerNow-lowerStart;
    const flat=Math.abs(upperMove)<=scale*0.55?"UPPER":Math.abs(lowerMove)<=scale*0.55?"LOWER":null;
    let type=null,name=null,direction="NEUTRAL";
    if(flat==="UPPER"&&lowerMove>scale*0.45){type="ASCENDING_TRIANGLE";name="Ascending Triangle";direction="BULLISH";}
    else if(upperMove< -scale*0.45&&flat==="LOWER"){type="DESCENDING_TRIANGLE";name="Descending Triangle";direction="BEARISH";}
    else if(upperMove< -scale*0.35&&lowerMove>scale*0.35){type="SYMMETRICAL_TRIANGLE";name="Symmetrical Triangle";}
    else if(upperMove>scale*0.25&&lowerMove>upperMove+scale*0.2){type="RISING_WEDGE";name="Rising Wedge";direction="BEARISH";}
    else if(lowerMove< -scale*0.25&&upperMove<lowerMove-scale*0.2){type="FALLING_WEDGE";name="Falling Wedge";direction="BULLISH";}
    if(!type)return [];
    const buffer=scale*0.06;let state="DEVELOPING";
    if(last.close>upperNow+buffer){state="CONFIRMED";direction="BULLISH";}
    else if(last.close<lowerNow-buffer){state="CONFIRMED";direction="BEARISH";}
    if(type==="ASCENDING_TRIANGLE"&&state==="CONFIRMED"&&direction==="BEARISH")state="INVALIDATED";
    if(type==="DESCENDING_TRIANGLE"&&state==="CONFIRMED"&&direction==="BULLISH")state="INVALIDATED";
    const height=startGap,trigger=direction==="BEARISH"?lowerNow:upperNow,target=direction==="BEARISH"?trigger-height:trigger+height;
    const quality=clamp(68+Math.round((1-endGap/startGap)*45),60,91),points=[...highs,...lows].sort((a,b)=>a.index-b.index).map(p=>({time:p.time,price:p.price,label:p.kind}));
    const startTime=bars[startIndex].time,endTime=last.time;
    return [makePattern(type,name,direction,state,quality,state==="CONFIRMED"?"Completed candle closed beyond the converging boundary.":"Trend boundaries are converging; wait for a completed breakout candle.",points,
      [{fromTime:highs[0].time,fromPrice:highs[0].price,toTime:endTime,toPrice:upperNow,label:"UPPER BOUNDARY"},{fromTime:lows[0].time,fromPrice:lows[0].price,toTime:endTime,toPrice:lowerNow,label:"LOWER BOUNDARY"}],
      [{price:upperNow,label:"UPPER TRIGGER",role:"trigger",fromTime:startTime,toTime:endTime},{price:lowerNow,label:"LOWER TRIGGER",role:"neckline",fromTime:startTime,toTime:endTime},{price:target,label:"MEASURED TARGET",role:"target",fromTime:startTime,toTime:endTime}],
      {startTime,endTime,trigger:{price:trigger,condition:"Completed close outside converging boundaries"},invalidation:{price:direction==="BEARISH"?upperNow:lowerNow,condition:"Opposite boundary break"},target:{price:target,method:"Initial triangle height"}})];
  }
  function detectFlags(bars,atr){
    if(bars.length<28||!atr)return [];
    const n=bars.length,impulseStart=bars[n-20],impulseEnd=bars[n-9],last=bars[n-1],impulse=impulseEnd.close-impulseStart.close;
    if(Math.abs(impulse)<atr*2.4)return [];
    const consolidation=bars.slice(n-8,n),ceiling=Math.max(...consolidation.map(b=>b.high)),floor=Math.min(...consolidation.map(b=>b.low));
    if(ceiling-floor>atr*4.6)return [];
    const bullish=impulse>0,breakout=bullish?last.close>ceiling:last.close<floor,invalidated=bullish?last.close<floor:last.close>ceiling;
    const state=breakout?"CONFIRMED":invalidated?"INVALIDATED":"DEVELOPING",trigger=bullish?ceiling:floor,target=bullish?trigger+Math.abs(impulse):trigger-Math.abs(impulse);
    return [makePattern(bullish?"BULL_FLAG":"BEAR_FLAG",bullish?"Bull Flag":"Bear Flag",bullish?"BULLISH":"BEARISH",state,clamp(69+Math.round((atr*4.6-(ceiling-floor))/atr*4),60,88),
      state==="CONFIRMED"?"Completed candle broke the flag range in the impulse direction.":"Impulse leg followed by compact consolidation; breakout confirmation is pending.",
      [{time:impulseStart.time,price:impulseStart.close,label:"IMPULSE START"},{time:impulseEnd.time,price:impulseEnd.close,label:"IMPULSE END"},{time:consolidation[0].time,price:ceiling,label:"FLAG HIGH"},{time:last.time,price:floor,label:"FLAG LOW"}],
      [{fromTime:consolidation[0].time,fromPrice:ceiling,toTime:last.time,toPrice:ceiling,label:"FLAG CEILING"},{fromTime:consolidation[0].time,fromPrice:floor,toTime:last.time,toPrice:floor,label:"FLAG FLOOR"}],
      [{price:trigger,label:"BREAKOUT TRIGGER",role:"trigger",fromTime:consolidation[0].time,toTime:last.time},{price:target,label:"MEASURED TARGET",role:"target",fromTime:consolidation[0].time,toTime:last.time}],
      {startTime:impulseStart.time,endTime:last.time,trigger:{price:trigger,condition:"Completed close outside flag range"},invalidation:{price:bullish?floor:ceiling,condition:"Close through opposite side of flag"},target:{price:target,method:"Impulse-leg projection"}})];
  }
  function analyze(input,timeframe="5m",now=Date.now()){
    const normalized=normalizeBars(input,timeframe,now),bars=normalized.bars;
    if(bars.length<20)return {ok:false,reason:"INSUFFICIENT_CLOSED_BARS",barCount:bars.length,activeBarExcluded:Boolean(normalized.activeBarTime),activeBarTime:normalized.activeBarTime,latestClosedBarTime:bars.at(-1)?.time??null,patterns:[]};
    const atr=averageTrueRange(bars,14),pivots=findPivots(bars,3,3);
    const patterns=[...detectCandles(bars,atr),...detectDoublePatterns(bars,pivots,atr),...detectHeadAndShoulders(bars,pivots,atr),...detectConvergingPatterns(bars,pivots,atr),...detectFlags(bars,atr)];
    const order={CONFIRMED:0,DEVELOPING:1,INVALIDATED:2};patterns.sort((a,b)=>(order[a.state]-order[b.state])||(b.qualityScore-a.qualityScore));
    const unique=[],seen=new Set();
    for(const pattern of patterns){if(seen.has(pattern.type))continue;seen.add(pattern.type);unique.push(pattern);if(unique.length>=8)break;}
    return {ok:true,barCount:bars.length,activeBarExcluded:Boolean(normalized.activeBarTime),activeBarTime:normalized.activeBarTime,latestClosedBarTime:bars.at(-1)?.time??null,atr14:atr,patternCount:unique.length,patterns:unique};
  }
  return Object.freeze({analyze,normalizeBars,findPivots});
});
