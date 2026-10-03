import crypto from "node:crypto";
import rateLimit from "express-rate-limit";

const DEFAULT_ORIGINS = [
  "https://botking-automation.github.io",
  "https://kingbot-finetech.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173"
];

export function allowedOrigins(){
  const configured = [
    String(process.env.FRONTEND_ORIGINS || ""),
    String(process.env.FRONTEND_ORIGIN || "")
  ].join(",").split(",").map(x => x.trim()).filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_ORIGINS);
}

export function corsOptions(){
  const origins = allowedOrigins();
  return {
    origin(origin, callback){
      if(!origin || origins.has(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: false,
    methods: ["GET","POST","OPTIONS"],
    allowedHeaders: ["Content-Type","Authorization","X-Request-ID"],
    exposedHeaders: ["X-Request-ID"],
    maxAge: 600,
    optionsSuccessStatus: 204
  };
}

export function requestSecurity(req,res,next){
  const requestId = String(req.get("X-Request-ID") || "").trim();
  req.requestId = /^[A-Za-z0-9._:-]{8,120}$/.test(requestId) ? requestId : crypto.randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if(req.secure || req.get("x-forwarded-proto") === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if(req.path.startsWith("/api/")) res.setHeader("Cache-Control","no-store");
  return next();
}

export function createApiLimiter(){
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 2000,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: req => req.method === "OPTIONS"
  });
}

export function createWriteLimiter(){
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: req => req.method === "GET" || req.method === "OPTIONS"
  });
}

export function sameTenant(user, resourceUserId){
  return Boolean(user?.id && resourceUserId && String(user.id) === String(resourceUserId));
}

export function redactLogValue(value, max=160){
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return text.slice(0, max);
}
