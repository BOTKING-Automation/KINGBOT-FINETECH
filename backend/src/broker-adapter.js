export class NoopBroker {
 constructor(){this.id="noop";this.connected=false;this.executionMode="NOT_CONNECTED";}
 async connect(){return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_NOT_CONFIGURED"};}
 async disconnect(){this.connected=false;return {connected:false};}
 async getAccount(){return {connected:false,data:null};}
 async getPositions(){return {connected:false,data:[]};}
 async getOrders(){return {connected:false,data:[]};}
 async getTrades(){return {connected:false,data:[]};}
 async placeOrder(){throw new Error("BROKER_NOT_CONNECTED");}
}
export function createBroker(){return new NoopBroker();}
