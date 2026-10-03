//+------------------------------------------------------------------+
//| KINGBOT_MT5_BRIDGE.mq5                                           |
//| Native KINGBOT FINTECH bridge for MetaTrader 5                   |
//+------------------------------------------------------------------+
#property strict
#property version "1.0"

#include <Trade/Trade.mqh>

input string BridgeURL="https://kingbot-fintech-api-etfv.onrender.com/api/mt5/bridge/poll";
input string AckURL="https://kingbot-fintech-api-etfv.onrender.com/api/mt5/bridge/ack";
input string BridgeToken="";
input string WatchSymbolsCSV="XAUUSD,EURUSD,GBPUSD,BTCUSD";
input int PollMilliseconds=500;
input int HistoryRefreshMilliseconds=10000;
input int HTTPTimeoutMilliseconds=4500;
input ulong MagicNumber=870055;
input bool AllowRemoteTrading=true;
input bool AllowLiveExecution=true;
input int HistoryDealLimit=40;
input int HistoryOrderLimit=40;

CTrade Trade;
ulong LastHistoryMs=0;
datetime LastLogTime=0;
string DoneIds[];
int DoneCount=0;

string Clean(string v,int maxLen=300)
{
   StringTrimLeft(v); StringTrimRight(v);
   if(StringLen(v)>maxLen)v=StringSubstr(v,0,maxLen);
   return v;
}
string Upper(string v){v=Clean(v);StringToUpper(v);return v;}
string JsonEscape(string v)
{
   StringReplace(v,"\\","\\\\");
   StringReplace(v,"\"","\\\"");
   StringReplace(v,"\r","\\r");
   StringReplace(v,"\n","\\n");
   return v;
}
string JsonString(string json,string key)
{
   string marker="\"" + key + "\":\"";
   int p=StringFind(json,marker);
   if(p<0)return "";
   int start=p+StringLen(marker);
   bool esc=false;
   string out="";
   for(int i=start;i<StringLen(json);i++)
   {
      ushort ch=StringGetCharacter(json,i);
      if(esc){out+=CharToString((uchar)ch);esc=false;continue;}
      if(ch=='\\'){esc=true;continue;}
      if(ch=='"')break;
      out+=CharToString((uchar)ch);
   }
   StringReplace(out,"\\\"","\"");
   StringReplace(out,"\\\\","\\");
   return out;
}
string JsonScalar(string json,string key)
{
   string marker="\"" + key + "\":";
   int p=StringFind(json,marker);
   if(p<0)return "";
   int start=p+StringLen(marker);
   while(start<StringLen(json))
   {
      ushort ch=StringGetCharacter(json,start);
      if(ch==' '||ch=='\r'||ch=='\n'||ch=='\t')start++; else break;
   }
   int end=start;
   if(start<StringLen(json)&&StringGetCharacter(json,start)=='"')
   {
      end++;
      while(end<StringLen(json))
      {
         if(StringGetCharacter(json,end)=='"'&&StringGetCharacter(json,end-1)!='\\')break;
         end++;
      }
      if(end<StringLen(json))end++;
   }
   else
   {
      while(end<StringLen(json))
      {
         ushort ch=StringGetCharacter(json,end);
         if(ch==','||ch=='}'||ch==']'||ch=='\r'||ch=='\n')break;
         end++;
      }
   }
   string value=Clean(StringSubstr(json,start,end-start),100);
   if(StringLen(value)>=2&&StringGetCharacter(value,0)=='"'&&StringGetCharacter(value,StringLen(value)-1)=='"')
      value=StringSubstr(value,1,StringLen(value)-2);
   return value;
}
double JsonDouble(string json,string key,double fallback=0.0)
{
   string v=JsonScalar(json,key);
   if(v==""||v=="null")return fallback;
   return StringToDouble(v);
}
int VolumeDigits(double step)
{
   int d=0; double x=step;
   while(d<8&&MathAbs(x-MathRound(x))>1e-10){x*=10.0;d++;}
   return d;
}
double NormalizeVolume(string symbol,double volume)
{
   double minV=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN);
   double maxV=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX);
   double step=SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP);
   if(minV<=0||maxV<=0||step<=0)return 0.0;
   if(volume<minV-1e-12||volume>maxV+1e-12)return 0.0;
   double v=minV+MathRound((volume-minV)/step)*step;
   if(v<minV-1e-12||v>maxV+1e-12)return 0.0;
   return NormalizeDouble(v,VolumeDigits(step));
}
double NormalizePrice(string symbol,double price)
{
   if(price<=0)return 0.0;
   return NormalizeDouble(price,(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS));
}
bool TradeOK(uint code)
{
   return code==TRADE_RETCODE_DONE||code==TRADE_RETCODE_PLACED||
          code==TRADE_RETCODE_DONE_PARTIAL||code==TRADE_RETCODE_NO_CHANGES;
}
string AccountType()
{
   return AccountInfoInteger(ACCOUNT_TRADE_MODE)==ACCOUNT_TRADE_MODE_REAL?"REAL":"DEMO";
}
string Epoch(datetime t){return LongToString((long)t);}
string ResolveSymbol(string requested)
{
   string wanted=Upper(requested);
   if(wanted=="")return _Symbol;
   if(SymbolInfoInteger(wanted,SYMBOL_EXIST)>0)return wanted;
   int total=SymbolsTotal(true);
   for(int i=0;i<total;i++)
   {
      string s=SymbolName(i,true);
      if(Upper(s)==wanted)return s;
      if(StringFind(Upper(s),wanted,0)==0)return s;
   }
   return "";
}
int WatchSymbols(string &out[])
{
   ArrayResize(out,0);
   string parts[];
   int n=StringSplit(WatchSymbolsCSV,',',parts);
   for(int i=0;i<n;i++)
   {
      string s=ResolveSymbol(parts[i]);
      if(s=="")continue;
      if(SymbolInfoInteger(s,SYMBOL_SELECT)==0)SymbolSelect(s,true);
      bool dupe=false;
      for(int j=0;j<ArraySize(out);j++)if(Upper(out[j])==Upper(s))dupe=true;
      if(dupe)continue;
      int m=ArraySize(out);ArrayResize(out,m+1);out[m]=s;
   }
   if(ArraySize(out)==0){ArrayResize(out,1);out[0]=_Symbol;}
   return ArraySize(out);
}
string JsonNumber(double v,int digits=10)
{
   if(!MathIsValidNumber(v))return "null";
   return DoubleToString(v,digits);
}
bool HttpPost(string url,string body,string &response,int &code)
{
   response="";code=0;
   if(StringFind(Upper(url),"HTTPS://",0)!=0)return false;
   char data[];int size=StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);
   if(size>0)ArrayResize(data,size-1);
   char result[];string resultHeaders="";
   string headers="Content-Type: application/json\r\nAccept: application/json\r\nUser-Agent: KINGBOT-MT5-Bridge/1.0\r\n";
   ResetLastError();
   code=WebRequest("POST",url,headers,HTTPTimeoutMilliseconds,data,ArraySize(data),result,resultHeaders);
   if(code<0)
   {
      int err=GetLastError();
      if(TimeCurrent()-LastLogTime>=10)
      {
         PrintFormat("[KINGBOT BRIDGE] WebRequest error=%d. Add %s to MT5 allowed WebRequest URLs.",err,"https://kingbot-fintech-api-etfv.onrender.com");
         LastLogTime=TimeCurrent();
      }
      return false;
   }
   response=CharArrayToString(result,0,-1,CP_UTF8);
   return true;
}

string BuildAccount()
{
   string j="{";
   j+="\"login\":\""+LongToString(AccountInfoInteger(ACCOUNT_LOGIN))+"\",";
   j+="\"server\":\""+JsonEscape(AccountInfoString(ACCOUNT_SERVER))+"\",";
   j+="\"currency\":\""+JsonEscape(AccountInfoString(ACCOUNT_CURRENCY))+"\",";
   j+="\"accountType\":\""+AccountType()+"\",";
   j+="\"balance\":"+JsonNumber(AccountInfoDouble(ACCOUNT_BALANCE),2)+",";
   j+="\"equity\":"+JsonNumber(AccountInfoDouble(ACCOUNT_EQUITY),2)+",";
   j+="\"margin\":"+JsonNumber(AccountInfoDouble(ACCOUNT_MARGIN),2)+",";
   j+="\"freeMargin\":"+JsonNumber(AccountInfoDouble(ACCOUNT_MARGIN_FREE),2)+",";
   j+="\"marginLevel\":"+JsonNumber(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL),2)+",";
   j+="\"leverage\":"+LongToString(AccountInfoInteger(ACCOUNT_LEVERAGE))+",";
   j+="\"tradeAllowed\":"+(AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)!=0?"true":"false")+",";
   j+="\"tradingEnabled\":"+(AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)!=0?"true":"false")+",";
   j+="\"time\":"+Epoch(TimeCurrent());
   j+="}";
   return j;
}
double PositionCommission(ulong positionId)
{
   if(!HistorySelectByPosition(positionId))return 0.0;
   double commission=0.0;
   int total=HistoryDealsTotal();
   for(int i=0;i<total;i++)
   {
      ulong deal=HistoryDealGetTicket(i);
      if(deal==0)continue;
      commission+=HistoryDealGetDouble(deal,DEAL_COMMISSION);
   }
   return commission;
}
string BuildPositions()
{
   string j="[";bool first=true;
   for(int i=0;i<PositionsTotal();i++)
   {
      ulong ticket=PositionGetTicket(i);
      if(ticket==0||!PositionSelectByTicket(ticket))continue;
      string symbol=PositionGetString(POSITION_SYMBOL);
      int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
      if(!first)j+=",";
      first=false;
      j+="{";
      j+="\"id\":\""+LongToString((long)ticket)+"\",";
      j+="\"ticket\":\""+LongToString((long)ticket)+"\",";
      j+="\"time\":"+LongToString((long)PositionGetInteger(POSITION_TIME))+",";
      j+="\"symbol\":\""+JsonEscape(symbol)+"\",";
      j+="\"side\":\""+(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY?"BUY":"SELL")+"\",";
      j+="\"volume\":"+JsonNumber(PositionGetDouble(POSITION_VOLUME),4)+",";
      j+="\"openPrice\":"+JsonNumber(PositionGetDouble(POSITION_PRICE_OPEN),digits)+",";
      j+="\"stopLoss\":"+JsonNumber(PositionGetDouble(POSITION_SL),digits)+",";
      j+="\"takeProfit\":"+JsonNumber(PositionGetDouble(POSITION_TP),digits)+",";
      j+="\"currentPrice\":"+JsonNumber(PositionGetDouble(POSITION_PRICE_CURRENT),digits)+",";
      j+="\"swap\":"+JsonNumber(PositionGetDouble(POSITION_SWAP),2)+",";
      j+="\"commission\":"+JsonNumber(PositionCommission(ticket),2)+",";
      j+="\"profit\":"+JsonNumber(PositionGetDouble(POSITION_PROFIT),2)+",";
      j+="\"magic\":"+LongToString((long)PositionGetInteger(POSITION_MAGIC))+",";
      j+="\"comment\":\""+JsonEscape(PositionGetString(POSITION_COMMENT))+"\",";
      j+="\"status\":\"OPEN\"}";
   }
   j+="]";return j;
}
string BuildOrders()
{
   string j="[";bool first=true;
   for(int i=0;i<OrdersTotal();i++)
   {
      ulong ticket=OrderGetTicket(i);if(ticket==0)continue;
      string symbol=OrderGetString(ORDER_SYMBOL);int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
      ENUM_ORDER_TYPE t=(ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      string side="OTHER";
      if(t==ORDER_TYPE_BUY_LIMIT||t==ORDER_TYPE_BUY_STOP||t==ORDER_TYPE_BUY_STOP_LIMIT)side="BUY";
      if(t==ORDER_TYPE_SELL_LIMIT||t==ORDER_TYPE_SELL_STOP||t==ORDER_TYPE_SELL_STOP_LIMIT)side="SELL";
      if(!first)j+=",";
      first=false;
      j+="{\"id\":\""+LongToString((long)ticket)+"\",\"ticket\":\""+LongToString((long)ticket)+"\",";
      j+="\"time\":"+LongToString((long)OrderGetInteger(ORDER_TIME_SETUP))+",";
      j+="\"symbol\":\""+JsonEscape(symbol)+"\",\"side\":\""+side+"\",";
      j+="\"volume\":"+JsonNumber(OrderGetDouble(ORDER_VOLUME_INITIAL),4)+",";
      j+="\"price\":"+JsonNumber(OrderGetDouble(ORDER_PRICE_OPEN),digits)+",";
      j+="\"status\":\""+LongToString(OrderGetInteger(ORDER_STATE))+"\"}";
   }
   j+="]";return j;
}
string BuildQuotes()
{
   string symbols[];WatchSymbols(symbols);string j="{";bool first=true;
   for(int i=0;i<ArraySize(symbols);i++)
   {
      string s=symbols[i];MqlTick tick;if(!SymbolInfoTick(s,tick))continue;
      double p=(tick.bid>0&&tick.ask>0)?(tick.bid+tick.ask)/2.0:(tick.bid>0?tick.bid:tick.ask);
      int digits=(int)SymbolInfoInteger(s,SYMBOL_DIGITS);
      if(!first)j+=",";
      first=false;
      j+="\""+JsonEscape(s)+"\":{";
      j+="\"symbol\":\""+JsonEscape(s)+"\",\"bid\":"+JsonNumber(tick.bid,digits)+",";
      j+="\"ask\":"+JsonNumber(tick.ask,digits)+",\"price\":"+JsonNumber(p,digits)+",";
      j+="\"time\":"+LongToString((long)tick.time)+",";
      j+="\"epoch\":"+LongToString((long)tick.time_msc/1000)+"}";
   }
   j+="}";return j;
}
string BuildSpecs()
{
   string symbols[];WatchSymbols(symbols);string j="{";bool first=true;
   for(int i=0;i<ArraySize(symbols);i++)
   {
      string s=symbols[i];
      if(!first)j+=",";
      first=false;
      j+="\""+JsonEscape(s)+"\":{";
      j+="\"symbol\":\""+JsonEscape(s)+"\",\"name\":\""+JsonEscape(s)+"\",";
      j+="\"description\":\""+JsonEscape(SymbolInfoString(s,SYMBOL_DESCRIPTION))+"\",";
      j+="\"minVolume\":"+JsonNumber(SymbolInfoDouble(s,SYMBOL_VOLUME_MIN),4)+",";
      j+="\"maxVolume\":"+JsonNumber(SymbolInfoDouble(s,SYMBOL_VOLUME_MAX),4)+",";
      j+="\"volumeStep\":"+JsonNumber(SymbolInfoDouble(s,SYMBOL_VOLUME_STEP),4)+",";
      j+="\"point\":"+JsonNumber(SymbolInfoDouble(s,SYMBOL_POINT),10)+",";
      j+="\"tickSize\":"+JsonNumber(SymbolInfoDouble(s,SYMBOL_TRADE_TICK_SIZE),10)+",";
      j+="\"tickValue\":"+JsonNumber(SymbolInfoDouble(s,SYMBOL_TRADE_TICK_VALUE),10)+",";
      j+="\"contractSize\":"+JsonNumber(SymbolInfoDouble(s,SYMBOL_TRADE_CONTRACT_SIZE),4)+",";
      j+="\"stopsLevel\":"+LongToString(SymbolInfoInteger(s,SYMBOL_TRADE_STOPS_LEVEL))+",";
      j+="\"digits\":"+LongToString(SymbolInfoInteger(s,SYMBOL_DIGITS))+",";
      j+="\"tradeMode\":"+LongToString(SymbolInfoInteger(s,SYMBOL_TRADE_MODE))+",";
      j+="\"tradeable\":"+(SymbolInfoInteger(s,SYMBOL_TRADE_MODE)!=SYMBOL_TRADE_MODE_DISABLED?"true":"false")+"}";
   }
   j+="}";return j;
}
string BuildSymbols()
{
   string symbols[];WatchSymbols(symbols);string j="[";bool first=true;
   for(int i=0;i<ArraySize(symbols);i++)
   {
      string s=symbols[i];
      if(!first)j+=",";
      first=false;
      j+="{\"symbol\":\""+JsonEscape(s)+"\",\"name\":\""+JsonEscape(s)+"\",";
      j+="\"description\":\""+JsonEscape(SymbolInfoString(s,SYMBOL_DESCRIPTION))+"\",\"category\":\"CFD\",";
      j+="\"minVolume\":"+JsonNumber(SymbolInfoDouble(s,SYMBOL_VOLUME_MIN),4)+",";
      j+="\"maxVolume\":"+JsonNumber(SymbolInfoDouble(s,SYMBOL_VOLUME_MAX),4)+",";
      j+="\"volumeStep\":"+JsonNumber(SymbolInfoDouble(s,SYMBOL_VOLUME_STEP),4)+",";
      j+="\"digits\":"+LongToString(SymbolInfoInteger(s,SYMBOL_DIGITS))+",";
      j+="\"tradeable\":"+(SymbolInfoInteger(s,SYMBOL_TRADE_MODE)!=SYMBOL_TRADE_MODE_DISABLED?"true":"false")+"}";
   }
   j+="]";return j;
}
string BuildHistory()
{
   if(!HistorySelect(TimeCurrent()-86400,TimeCurrent()))return "{\"deals\":[],\"orders\":[]}";
   int dealsTotal=HistoryDealsTotal(),ordersTotal=HistoryOrdersTotal();
   int ds=MathMax(0,dealsTotal-HistoryDealLimit),os=MathMax(0,ordersTotal-HistoryOrderLimit);
   string deals="[";bool first=true;
   for(int i=ds;i<dealsTotal;i++)
   {
      ulong ticket=HistoryDealGetTicket(i);if(ticket==0)continue;
      string s=HistoryDealGetString(ticket,DEAL_SYMBOL);int digits=(int)SymbolInfoInteger(s,SYMBOL_DIGITS);
      if(!first)deals+=",";
      first=false;
      deals+="{\"id\":\""+LongToString((long)ticket)+"\",\"ticket\":\""+LongToString((long)ticket)+"\",";
      deals+="\"time\":"+LongToString((long)HistoryDealGetInteger(ticket,DEAL_TIME))+",";
      deals+="\"symbol\":\""+JsonEscape(s)+"\",\"type\":"+LongToString(HistoryDealGetInteger(ticket,DEAL_TYPE))+",";
      deals+="\"volume\":"+JsonNumber(HistoryDealGetDouble(ticket,DEAL_VOLUME),4)+",";
      deals+="\"price\":"+JsonNumber(HistoryDealGetDouble(ticket,DEAL_PRICE),digits)+",";
      deals+="\"profit\":"+JsonNumber(HistoryDealGetDouble(ticket,DEAL_PROFIT),2)+",";
      deals+="\"swap\":"+JsonNumber(HistoryDealGetDouble(ticket,DEAL_SWAP),2)+",";
      deals+="\"commission\":"+JsonNumber(HistoryDealGetDouble(ticket,DEAL_COMMISSION),2)+",";
      deals+="\"order\":\""+LongToString((long)HistoryDealGetInteger(ticket,DEAL_ORDER))+"\",";
      deals+="\"positionId\":\""+LongToString((long)HistoryDealGetInteger(ticket,DEAL_POSITION_ID))+"\"}";
   }
   deals+="]";
   string orders="[";first=true;
   for(int i=os;i<ordersTotal;i++)
   {
      ulong ticket=HistoryOrderGetTicket(i);if(ticket==0)continue;
      string s=HistoryOrderGetString(ticket,ORDER_SYMBOL);int digits=(int)SymbolInfoInteger(s,SYMBOL_DIGITS);
      if(!first)orders+=",";
      first=false;
      orders+="{\"id\":\""+LongToString((long)ticket)+"\",\"ticket\":\""+LongToString((long)ticket)+"\",";
      orders+="\"time\":"+LongToString((long)HistoryOrderGetInteger(ticket,ORDER_TIME_SETUP))+",";
      orders+="\"symbol\":\""+JsonEscape(s)+"\",\"type\":"+LongToString(HistoryOrderGetInteger(ticket,ORDER_TYPE))+",";
      orders+="\"volume\":"+JsonNumber(HistoryOrderGetDouble(ticket,ORDER_VOLUME_INITIAL),4)+",";
      orders+="\"price\":"+JsonNumber(HistoryOrderGetDouble(ticket,ORDER_PRICE_OPEN),digits)+",";
      orders+="\"state\":"+LongToString(HistoryOrderGetInteger(ticket,ORDER_STATE))+"}";
   }
   orders+="]";
   return "{\"deals\":"+deals+",\"orders\":"+orders+"}";
}
string BuildState(bool withHistory)
{
   string j="{\"account\":"+BuildAccount()+",";
   j+="\"positions\":"+BuildPositions()+",\"orders\":"+BuildOrders()+",";
   j+="\"quotes\":"+BuildQuotes()+",\"specs\":"+BuildSpecs()+",\"symbols\":"+BuildSymbols()+",";
   j+="\"history\":"+(withHistory?BuildHistory():"{\"deals\":[],\"orders\":[]}")+"}";
   return j;
}

int FindCommandEnd(string json,int start)
{
   int depth=0;bool quoted=false;bool escaped=false;
   for(int i=start;i<StringLen(json);i++)
   {
      ushort ch=StringGetCharacter(json,i);
      if(quoted)
      {
         if(escaped){escaped=false;continue;}
         if(ch=='\\'){escaped=true;continue;}
         if(ch=='"')quoted=false;
         continue;
      }
      if(ch=='"'){quoted=true;continue;}
      if(ch=='{')depth++;
      if(ch=='}'){depth--;if(depth==0)return i+1;}
   }
   return -1;
}
string CommandObject(string response)
{
   string marker="\"command\":";
   int p=StringFind(response,marker);if(p<0)return "";
   int start=p+StringLen(marker);
   while(start<StringLen(response))
   {
      ushort ch=StringGetCharacter(response,start);
      if(ch==' '||ch=='\r'||ch=='\n'||ch=='\t')start++;else break;
   }
   if(start>=StringLen(response)||StringGetCharacter(response,start)!='{')return "";
   int end=FindCommandEnd(response,start);if(end<0)return "";
   return StringSubstr(response,start,end-start);
}
bool AlreadyDone(string id){for(int i=0;i<DoneCount;i++)if(DoneIds[i]==id)return true;return false;}
void MarkDone(string id)
{
   if(id==""||AlreadyDone(id))return;
   if(DoneCount>=100){for(int i=1;i<DoneCount;i++)DoneIds[i-1]=DoneIds[i];DoneCount=99;}
   ArrayResize(DoneIds,DoneCount+1);DoneIds[DoneCount]=id;DoneCount++;
}
void Ack(string id,string status,string result,string message)
{
   string body="{\"token\":\""+JsonEscape(BridgeToken)+"\",\"commandId\":\""+JsonEscape(id)+"\",";
   body+="\"status\":\""+status+"\",\"message\":\""+JsonEscape(message)+"\",\"result\":"+result+"}";
   string response;int code=0;HttpPost(AckURL,body,response,code);
}
void ExecuteOpen(string id,string cmd)
{
   if(!AllowRemoteTrading){Ack(id,"REJECTED","{}","Remote trading is disabled.");MarkDone(id);return;}
   if(!AllowLiveExecution&&AccountType()=="REAL"){Ack(id,"REJECTED","{}","Live execution is disabled.");MarkDone(id);return;}
   string side=Upper(JsonString(cmd,"side")),symbol=ResolveSymbol(JsonString(cmd,"symbol"));
   double volume=NormalizeVolume(symbol,JsonDouble(cmd,"volume",0));
   double sl=NormalizePrice(symbol,JsonDouble(cmd,"stopLoss",0));
   double tp=NormalizePrice(symbol,JsonDouble(cmd,"takeProfit",0));
   string comment=Clean(JsonString(cmd,"comment"),100);
   if(symbol==""||(side!="BUY"&&side!="SELL")){Ack(id,"REJECTED","{}","Invalid MT5 symbol or side.");MarkDone(id);return;}
   if(volume<=0){Ack(id,"REJECTED","{}","Invalid broker lot volume or step.");MarkDone(id);return;}
   MqlTick tick;if(!SymbolInfoTick(symbol,tick)){Ack(id,"REJECTED","{}","MT5 price unavailable.");MarkDone(id);return;}
   Trade.SetExpertMagicNumber(MagicNumber);Trade.SetTypeFillingBySymbol(symbol);
   bool ok=(side=="BUY")?Trade.Buy(volume,symbol,0,sl,tp,comment):Trade.Sell(volume,symbol,0,sl,tp,comment);
   uint rc=Trade.ResultRetcode();
   if(!ok||!TradeOK(rc)){Ack(id,"REJECTED","{\"retcode\":"+LongToString((long)rc)+"}",Trade.ResultRetcodeDescription());MarkDone(id);return;}
   string result="{\"retcode\":"+LongToString((long)rc)+",";
   result+="\"orderTicket\":\""+LongToString((long)Trade.ResultOrder())+"\",";
   result+="\"dealTicket\":\""+LongToString((long)Trade.ResultDeal())+"\",";
   result+="\"volume\":"+JsonNumber(Trade.ResultVolume(),4)+",";
   result+="\"price\":"+JsonNumber(Trade.ResultPrice(),(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS))+"}";
   Ack(id,"FILLED",result,Trade.ResultRetcodeDescription());MarkDone(id);
}
void ExecuteModify(string id,string cmd)
{
   if(!AllowRemoteTrading){Ack(id,"REJECTED","{}","Remote trading is disabled.");MarkDone(id);return;}
   ulong ticket=(ulong)StringToInteger(JsonString(cmd,"positionId"));
   if(ticket==0||!PositionSelectByTicket(ticket)){Ack(id,"REJECTED","{}","MT5 position is not open.");MarkDone(id);return;}
   string symbol=PositionGetString(POSITION_SYMBOL);
   double sl=NormalizePrice(symbol,JsonDouble(cmd,"stopLoss",0)),tp=NormalizePrice(symbol,JsonDouble(cmd,"takeProfit",0));
   Trade.SetExpertMagicNumber(MagicNumber);
   bool ok=Trade.PositionModify(ticket,sl,tp);uint rc=Trade.ResultRetcode();
   if(!ok||!TradeOK(rc)){Ack(id,"REJECTED","{}",Trade.ResultRetcodeDescription());MarkDone(id);return;}
   Ack(id,"FILLED","{\"retcode\":"+LongToString((long)rc)+",\"positionTicket\":\""+LongToString((long)ticket)+"\"}",Trade.ResultRetcodeDescription());MarkDone(id);
}
void ExecuteClose(string id,string cmd)
{
   if(!AllowRemoteTrading){Ack(id,"REJECTED","{}","Remote trading is disabled.");MarkDone(id);return;}
   ulong ticket=(ulong)StringToInteger(JsonString(cmd,"positionId"));
   if(ticket==0||!PositionSelectByTicket(ticket)){Ack(id,"REJECTED","{}","MT5 position is not open.");MarkDone(id);return;}
   string symbol=PositionGetString(POSITION_SYMBOL);double volume=PositionGetDouble(POSITION_VOLUME);
   Trade.SetExpertMagicNumber(MagicNumber);Trade.SetTypeFillingBySymbol(symbol);
   bool ok=Trade.PositionClose(ticket);uint rc=Trade.ResultRetcode();
   if(!ok||!TradeOK(rc)){Ack(id,"REJECTED","{}",Trade.ResultRetcodeDescription());MarkDone(id);return;}
   string result="{\"retcode\":"+LongToString((long)rc)+",\"positionTicket\":\""+LongToString((long)ticket)+"\",";
   result+="\"closedVolume\":"+JsonNumber(volume,4)+"}";
   Ack(id,"FILLED",result,Trade.ResultRetcodeDescription());MarkDone(id);
}
ENUM_TIMEFRAMES ParseTimeframe(string tf)
{
   string s=Upper(tf);
   if(s=="1M")return PERIOD_M1;if(s=="2M")return PERIOD_M2;if(s=="3M")return PERIOD_M3;if(s=="4M")return PERIOD_M4;
   if(s=="5M")return PERIOD_M5;if(s=="6M")return PERIOD_M6;if(s=="10M")return PERIOD_M10;if(s=="12M")return PERIOD_M12;
   if(s=="15M")return PERIOD_M15;if(s=="20M")return PERIOD_M20;if(s=="30M")return PERIOD_M30;if(s=="1H")return PERIOD_H1;
   if(s=="2H")return PERIOD_H2;if(s=="3H")return PERIOD_H3;if(s=="4H")return PERIOD_H4;if(s=="6H")return PERIOD_H6;
   if(s=="8H")return PERIOD_H8;if(s=="12H")return PERIOD_H12;if(s=="1D")return PERIOD_D1;if(s=="1W")return PERIOD_W1;if(s=="1MN")return PERIOD_MN1;
   return PERIOD_M5;
}
void ExecuteCandles(string id,string cmd)
{
   string symbol=ResolveSymbol(JsonString(cmd,"symbol"));int limit=(int)JsonDouble(cmd,"limit",100);
   limit=MathMax(10,MathMin(1000,limit));
   if(symbol==""){Ack(id,"REJECTED","{}","MT5 symbol unavailable.");MarkDone(id);return;}
   MqlRates rates[];ArraySetAsSeries(rates,true);
   int copied=CopyRates(symbol,ParseTimeframe(JsonString(cmd,"timeframe")),0,limit,rates);
   if(copied<=0){Ack(id,"REJECTED","{}","MT5 candle history unavailable.");MarkDone(id);return;}
   string candles="[";bool first=true;int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   for(int i=copied-1;i>=0;i--)
   {
      if(!first)candles+=",";
      first=false;
      candles+="{\"time\":"+LongToString((long)rates[i].time)+",";
      candles+="\"open\":"+JsonNumber(rates[i].open,digits)+",\"high\":"+JsonNumber(rates[i].high,digits)+",";
      candles+="\"low\":"+JsonNumber(rates[i].low,digits)+",\"close\":"+JsonNumber(rates[i].close,digits)+",";
      candles+="\"tickVolume\":"+LongToString((long)rates[i].tick_volume)+",";
      candles+="\"spread\":"+LongToString((long)rates[i].spread)+",\"volume\":"+LongToString((long)rates[i].real_volume)+"}";
   }
   candles+="]";
   string result="{\"symbol\":\""+JsonEscape(symbol)+"\",\"timeframe\":\""+JsonEscape(JsonString(cmd,"timeframe"))+"\",\"candles\":"+candles+"}";
   Ack(id,"FILLED",result,"MT5 candle history synchronized.");MarkDone(id);
}
void ExecuteCommand(string cmd)
{
   string id=JsonString(cmd,"commandId");if(id==""||AlreadyDone(id))return;
   string type=Upper(JsonString(cmd,"type"));
   if(type=="OPEN_POSITION")ExecuteOpen(id,cmd);
   else if(type=="MODIFY_POSITION")ExecuteModify(id,cmd);
   else if(type=="CLOSE_POSITION")ExecuteClose(id,cmd);
   else if(type=="GET_CANDLES")ExecuteCandles(id,cmd);
   else {Ack(id,"REJECTED","{}","Unsupported KINGBOT command.");MarkDone(id);}
}
void PollBridge()
{
   if(Clean(BridgeToken)=="")return;
   ulong now=GetTickCount64();
   bool withHistory=(now-LastHistoryMs)>=(ulong)HistoryRefreshMilliseconds;
   string body="{";
   body+="\"token\":\""+JsonEscape(BridgeToken)+"\",";
   body+="\"login\":\""+LongToString(AccountInfoInteger(ACCOUNT_LOGIN))+"\",";
   body+="\"server\":\""+JsonEscape(AccountInfoString(ACCOUNT_SERVER))+"\",";
   body+="\"accountType\":\""+AccountType()+"\",";
   body+="\"mode\":\""+(AccountType()=="REAL"?"LIVE":"DEMO")+"\",";
   body+="\"state\":"+BuildState(withHistory)+"}";
   string response;int code=0;
   if(!HttpPost(BridgeURL,body,response,code))return;
   if(code==401||code==409)
   {
      if(TimeCurrent()-LastLogTime>=10)
      {
         PrintFormat("[KINGBOT BRIDGE] Heartbeat rejected. HTTP=%d response=%s",code,response);
         LastLogTime=TimeCurrent();
      }
      return;
   }
   if(code<200||code>=300)return;
   if(withHistory)LastHistoryMs=now;
   string command=CommandObject(response);
   if(command!="")ExecuteCommand(command);
}
int OnInit()
{
   if(Clean(BridgeToken)==""){Print("[KINGBOT BRIDGE] BridgeToken is required.");return INIT_PARAMETERS_INCORRECT;}
   if(StringFind(Upper(BridgeURL),"HTTPS://",0)!=0||StringFind(Upper(AckURL),"HTTPS://",0)!=0){Print("[KINGBOT BRIDGE] HTTPS required.");return INIT_PARAMETERS_INCORRECT;}
   Trade.SetExpertMagicNumber(MagicNumber);
   EventSetMillisecondTimer(MathMax(250,PollMilliseconds));
   PrintFormat("[KINGBOT BRIDGE] Started | login=%I64d | server=%s | mode=%s",AccountInfoInteger(ACCOUNT_LOGIN),AccountInfoString(ACCOUNT_SERVER),AccountType());
   return INIT_SUCCEEDED;
}
void OnDeinit(const int reason){EventKillTimer();PrintFormat("[KINGBOT BRIDGE] Stopped | reason=%d",reason);}
void OnTimer(){PollBridge();}
void OnTick(){}
