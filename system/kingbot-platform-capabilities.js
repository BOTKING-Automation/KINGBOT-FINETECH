/* KINGBOT FINTECH — central product capability registry */
(function(window){
  "use strict";
  const capabilities=[
    {id:"market-data",name:"Market Data Fabric",group:"Trading Core",status:"live",href:"markets.html",desc:"Real-time quotes, market context and research surfaces."},
    {id:"ai-intelligence",name:"KINGBOT Intelligence",group:"Trading Core",status:"live",href:"ai.html",desc:"Native intelligence, verified context and adaptive decision support."},
    {id:"ai-scanner",name:"AI Market Scanner",group:"Trading Core",status:"live",href:"scanner.html",desc:"Live market scanning and setup analysis."},
    {id:"trading-terminal",name:"Professional Terminal",group:"Trading Core",status:"live",href:"terminal.html",desc:"Account-aware terminal, positions, execution telemetry and engine state."},
    {id:"bot-engines",name:"Bot Engine Platform",group:"Trading Core",status:"live",href:"bots.html",desc:"Strategic, Flipper, Breakout, SMC PRO and Ladder Flip V8."},
    {id:"risk-governor",name:"Risk Governor",group:"Trading Core",status:"live",href:"analytics.html",desc:"Execution controls, risk state, reconciliation and kill-switch architecture."},
    {id:"broker-connectivity",name:"Broker Connectivity",group:"Execution",status:"live",href:"broker-connect.html",desc:"Broker account linking and MT5/Deriv infrastructure."},
    {id:"mt5-cloud",name:"MT5 Cloud / VPS",group:"Execution",status:"live",href:"vps-dashboard.html",desc:"Hosted MT5 deployment and bridge operations."},
    {id:"execution-journal",name:"Execution Audit Trail",group:"Execution",status:"live",href:"reports.html",desc:"Server-side execution history and operational evidence."},
    {id:"event-bus",name:"Central Event Bus",group:"Infrastructure",status:"live",href:"platform-os.html",desc:"Durable events, correlation IDs, SSE distribution and central state."},
    {id:"adaptive-memory",name:"Adaptive Intelligence Memory",group:"Intelligence",status:"live",href:"ai.html",desc:"Persistent non-sensitive user preferences and outcome-driven learning."},
    {id:"developer-api",name:"Developer API",group:"Platform",status:"live",href:"developer.html",desc:"Versioned read-only integration API with scoped keys."},
    {id:"subscription-engine",name:"Subscription Engine",group:"Commercial",status:"live",href:"subscription.html",desc:"Plans, entitlements, payment verification and access control."},
    {id:"partner-revenue",name:"Partner Revenue",group:"Commercial",status:"live",href:"partner-revenue.html",desc:"Broker referral attribution and partner analytics."},
    {id:"fintech-ops",name:"Fintech Operations OS",group:"Trust",status:"live",href:"fintech-ops.html",desc:"Operations, incidents, compliance workflows and reconciliation."},
    {id:"security-center",name:"Security Center",group:"Trust",status:"live",href:"security-center.html",desc:"Security controls, account protection and operational safeguards."},
    {id:"support",name:"Customer Support",group:"Customer",status:"live",href:"support-center.html",desc:"Support intake and operational assistance."},
    {id:"academy",name:"Academy",group:"Customer",status:"live",href:"academy.html",desc:"Trading education, research and learning products."},
    {id:"gold-desk",name:"Gold Signal Desk",group:"Research",status:"live",href:"gold-signals.html",desc:"XAUUSD-focused signal and research workflow."},
    {id:"white-label",name:"White-Label Platform",group:"Scale",status:"planned",href:"contact.html",desc:"Tenant-isolated branded trading infrastructure for institutions and partners."},
    {id:"strategy-marketplace",name:"Strategy Marketplace",group:"Scale",status:"planned",href:"bots.html",desc:"Third-party strategy distribution with validation, entitlements and revenue sharing."},
    {id:"enterprise-workspaces",name:"Enterprise Workspaces",group:"Scale",status:"planned",href:"contact.html",desc:"Teams, seats, permissions, organization billing and institutional controls."},
    {id:"copy-trading",name:"Copy / Social Trading",group:"Scale",status:"planned",href:"contact.html",desc:"Broker-native or regulated-partner copy workflows with risk constraints."},
    {id:"data-products",name:"Market Data Products",group:"Scale",status:"planned",href:"developer.html",desc:"Premium datasets, webhooks, historical data and analytics APIs."},
    {id:"mobile-app",name:"Mobile Trading App",group:"Scale",status:"planned",href:"contact.html",desc:"Dedicated iOS/Android client sharing the same identity, state and event fabric."},
    {id:"institutional",name:"Institutional Suite",group:"Scale",status:"planned",href:"contact.html",desc:"Advanced reporting, controls, SSO, audit exports and service-level operations."},
    {id:"global-billing",name:"Global Billing & Revenue Ops",group:"Scale",status:"planned",href:"subscription.html",desc:"Multi-currency billing, invoicing, taxes, refunds, revenue recognition and dunning."},
    {id:"observability",name:"Reliability & Observability",group:"Infrastructure",status:"foundation",href:"reports.html",desc:"Uptime, traces, error budgets, deployment health and incident automation."},
    {id:"compliance-automation",name:"Compliance Automation",group:"Trust",status:"foundation",href:"compliance.html",desc:"KYC/AML workflows, suitability/appropriateness, consent, records and jurisdiction controls."},
    {id:"non-custodial-wallet",name:"Non-Custodial Commercial Ledger",group:"Commercial",status:"foundation",href:"fintech-ops.html",desc:"Merchant balances, invoices, partner commissions and reconciliation without holding trading funds."}
  ];
  window.KINGBOT_CAPABILITIES=Object.freeze(capabilities.map(x=>Object.freeze({...x})));
})(window);
