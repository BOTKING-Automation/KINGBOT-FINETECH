/* KINGBOT FINTECH — unified application shell
   Global command navigator intentionally disabled.
   Individual application pages own their navigation and routing. */
(function(window){
  "use strict";
  window.KINGBOT_NAV = {
    config:{links:[],account:[]},
    state:{initialized:true,user:null,open:false},
    initialize:function(){ return Promise.resolve(); },
    current:function(){ return (window.location.pathname.split("/").filter(Boolean).pop()||"index.html").toLowerCase(); },
    active:function(){ return false; },
    refreshUser:function(){ return Promise.resolve(); }
  };
})(window);
