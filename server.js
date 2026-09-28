import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SNAPSHOT } from "./data.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DASHBOARD_DATA_JSON = process.env.DASHBOARD_DATA_JSON;

if (!DASHBOARD_PASSWORD) throw new Error("Missing DASHBOARD_PASSWORD");
if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");

const app = express();
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  referrerPolicy: { policy: "no-referrer" },
}));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "100kb" }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
function signToken(expires) {
  const payload = String(expires);
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes(".")) return false;
  const [expiresRaw, sig] = token.split(".");
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(expiresRaw).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isAuthed(req) { return verifyToken(parseCookies(req).gen_c_auth); }
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
  return res.redirect("/login");
}

const loginPage = (error = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gen C Dashboard — Sign in</title><style>
body{margin:0;background:#eef3f7;color:#11243c;font-family:Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
form{width:min(92vw,380px);background:white;border:1px solid #dce5ec;border-radius:16px;padding:28px;box-shadow:0 15px 40px rgba(20,50,80,.1)}
h1{margin:0 0 5px;font-size:22px}p{margin:0 0 22px;color:#68798a;font-size:13px}
label{display:block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;margin-bottom:7px}
input{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:11px;border:1px solid #cfdbe4;border-radius:10px}
button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:10px;background:#0b3155;color:white;font-weight:800;font:inherit;cursor:pointer}
.err{color:#a62732;margin-bottom:12px;font-size:12px}small{display:block;margin-top:16px;color:#7b8793;line-height:1.4}
</style></head><body><form method="post" action="/login">
<h1>Gen C dashboard</h1><p>Private principal briefing</p>${error ? `<div class="err">${error}</div>` : ""}
<label for="password">Access password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Open dashboard</button>
<small>The presentation exposes aggregate statistics only. Contact details remain in the restricted database.</small>
</form></body></html>`;

app.get("/login", (req, res) => {
  if (isAuthed(req)) return res.redirect("/");
  res.set("Cache-Control", "no-store");
  res.send(loginPage());
});
app.post("/login", loginLimiter, (req, res) => {
  const submitted = Buffer.from(String(req.body.password || ""));
  const expected = Buffer.from(DASHBOARD_PASSWORD);
  const ok = submitted.length === expected.length && crypto.timingSafeEqual(submitted, expected);
  if (!ok) return res.status(401).set("Cache-Control", "no-store").send(loginPage("Incorrect password."));
  const expires = Date.now() + 12 * 60 * 60 * 1000;
  res.cookie("gen_c_auth", signToken(expires), {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
    maxAge: 12 * 60 * 60 * 1000, path: "/",
  });
  res.redirect("/");
});
app.post("/logout", (req, res) => {
  res.clearCookie("gen_c_auth", { path: "/" });
  res.redirect("/login");
});
let dashboardPayload = SNAPSHOT;
if (DASHBOARD_DATA_JSON) {
  try {
    dashboardPayload = JSON.parse(DASHBOARD_DATA_JSON);
  } catch (err) {
    console.error("Invalid DASHBOARD_DATA_JSON; using sanitized fallback snapshot", err);
  }
}

app.get("/api/dashboard", requireAuth, (req, res) => {
  res.set("Cache-Control", "no-store, private");
  res.json(dashboardPayload);
});
app.use(requireAuth);
app.use(express.static(__dirname, {
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "10m" : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith("data.js") || filePath.endsWith("config.js")) res.setHeader("Cache-Control", "no-store");
  },
}));
app.listen(PORT, () => console.log(`Gen C dashboard listening on port ${PORT}`));
