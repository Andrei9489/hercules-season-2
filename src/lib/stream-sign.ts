// ============================================================
// Faza 10 — Semnare URL stream server-side (token/HMAC/JWT).
// Utilizatorul încarcă un stream protejat și configurează schema
// de semnare; secretul se salvează în Neon (content.meta.signing)
// și NU pleacă niciodată spre browser. La redare, playerul cere
// /api/stream/sign → serverul aplică semnătura la momentul tau.
//
// Scheme suportate (compatibile CDN/pachete obișnuite):
//  - "query"       : ?param=<secret> (+ exp opțional + extra params)
//  - "hmac-md5"    : ?param=<md5(secret+payload+exp)>&exp=<t>
//  - "hmac-sha256" : ?param=<hmac_sha256(secret, payload+exp)>&exp=<t>
//      payload = pathname (implicit) sau full URL (hashPayload)
//      (stil Wowza/Flussonic/Nginx secure_link)
//  - "jwt"         : ?param=<JWT HS256 {iat, exp}>&exp=<t>
// ============================================================

import { createHash, createHmac } from "node:crypto";

export type SigningConfig = {
  type: "query" | "hmac-md5" | "hmac-sha256" | "jwt";
  param: string;        // numele parametrului de query (ex: token, st, auth)
  secret: string;       // secretul shared cu CDN-ul/streamul
  ttlSec: number;       // durata de valabilitate a semnăturii
  hashPayload?: "path" | "fullurl"; // pentru hmac: ce se hashuiește
  extraParams?: Record<string, string>; // parametri suplimentari (ex: ip, ref)
};

export type SignedUrl = {
  url: string;
  expiresAt: number;    // epoch ms
  type: SigningConfig["type"];
};

/** Validează + normalizează configurația primită din UI/API. */
export function parseSigningConfig(raw: unknown): SigningConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = String(r.type || "");
  if (!["query", "hmac-md5", "hmac-sha256", "jwt"].includes(type)) return null;
  const secret = String(r.secret || "").trim();
  if (!secret || secret.length < 4) return null; // secret minim 4 caractere
  const param = String(r.param || "token").trim().replace(/[^a-zA-Z0-9_-]/g, "") || "token";
  let ttlSec = Number(r.ttlSec) || 300;
  ttlSec = Math.min(Math.max(ttlSec, 30), 86_400); // 30s … 24h
  const hashPayload = r.hashPayload === "fullurl" ? "fullurl" : "path";
  let extraParams: Record<string, string> | undefined;
  if (r.extraParams && typeof r.extraParams === "object") {
    const entries = Object.entries(r.extraParams as Record<string, unknown>)
      .slice(0, 8)
      .map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 200)] as const)
      .filter(([k]) => /^[a-zA-Z0-9_-]+$/.test(k));
    if (entries.length) extraParams = Object.fromEntries(entries);
  }
  return { type: type as SigningConfig["type"], param, secret, ttlSec, hashPayload, extraParams };
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Aplică schema de semnare pe URL la momentul cererii. */
export function applySigning(rawUrl: string, cfg: SigningConfig): SignedUrl {
  const u = new URL(rawUrl);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + cfg.ttlSec;
  const expiresAt = exp * 1000;

  for (const [k, v] of Object.entries(cfg.extraParams || {})) {
    u.searchParams.set(k, v);
  }

  switch (cfg.type) {
    case "query": {
      u.searchParams.set(cfg.param, cfg.secret);
      u.searchParams.set("exp", String(exp));
      break;
    }
    case "hmac-md5":
    case "hmac-sha256": {
      const payload = cfg.hashPayload === "fullurl"
        ? u.toString()
        : (u.pathname || "/") + u.search; // path + query existent (fără semnătură)
      const digest = cfg.type === "hmac-md5"
        ? createHash("md5").update(`${cfg.secret}${payload}${exp}`).digest("hex")
        : createHmac("sha256", cfg.secret).update(`${payload}${exp}`).digest("hex");
      u.searchParams.set(cfg.param, digest);
      u.searchParams.set("exp", String(exp));
      break;
    }
    case "jwt": {
      const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const body = b64url(JSON.stringify({ iat: now, exp, ...cfg.extraParams }));
      const sig = b64url(createHmac("sha256", cfg.secret).update(`${header}.${body}`).digest());
      u.searchParams.set(cfg.param, `${header}.${body}.${sig}`);
      break;
    }
  }
  return { url: u.toString(), expiresAt, type: cfg.type };
}
