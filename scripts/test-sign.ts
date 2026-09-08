// Test unitar Faza 10 — semnare URL (query/HMAC/JWT) + detecție MPEG-TS
// + protocoale non-HTTP. Rulează: bun scripts/test-sign.ts
import { createHmac } from "node:crypto";
import { applySigning, parseSigningConfig } from "../src/lib/stream-sign";
import { resolveSource } from "../src/lib/source-resolver";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

console.log("— parseSigningConfig —");
const cfg = parseSigningConfig({ type: "hmac-sha256", param: "st", secret: "topsecret", ttlSec: 600 });
check("config hmac validă", !!cfg && cfg.param === "st" && cfg.ttlSec === 600);
check("secret scurt respins", parseSigningConfig({ type: "query", secret: "ab" }) === null);
check("tip necunoscut respins", parseSigningConfig({ type: "rsa", secret: "abcdefgh" }) === null);
check("null pentru non-obiect", parseSigningConfig(null) === null);
check("TTL clamp 30s", parseSigningConfig({ type: "query", secret: "abcdefgh", ttlSec: 1 })?.ttlSec === 30);

console.log("— query token —");
const q1 = applySigning("https://cdn.example.com/live/index.m3u8", parseSigningConfig!({ type: "query", param: "token", secret: "abc123", ttlSec: 300 })!);
check("conține token=abc123", q1.url.includes("token=abc123"));
check("conține exp", /exp=\d{10}/.test(q1.url));
check("expiră în ~300s", Math.abs(q1.expiresAt - (Date.now() + 300_000)) < 5_000);

console.log("— hmac-sha256 (stil Wowza/Flussonic) —");
const h1 = applySigning("https://cdn.example.com/vod/film.mp4?x=1", parseSigningConfig!({ type: "hmac-sha256", param: "st", secret: "s3cr3t", ttlSec: 120 })!);
check("conține st=<64 hex>", /st=[a-f0-9]{64}/.test(h1.url));
check("păstrează query existent", h1.url.includes("x=1"));
check("conține exp", /exp=\d{10}/.test(h1.url));

console.log("— hmac-md5 —");
const h2 = applySigning("https://cdn.example.com/live/stream.ts", parseSigningConfig!({ type: "hmac-md5", param: "auth", secret: "md5key", ttlSec: 60 })!);
check("conține auth=<32 hex>", /auth=[a-f0-9]{32}/.test(h2.url));

console.log("— jwt HS256 —");
const j1 = applySigning("https://cdn.example.com/hls/master.m3u8", parseSigningConfig!({ type: "jwt", param: "jwt", secret: "jwtsecret", ttlSec: 900 })!);
const jwt = j1.url.match(/jwt=([\w-]+\.[\w-]+\.[\w-]+)/)?.[1] || "";
check("format JWT 3 segmente", jwt.split(".").length === 3);
const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
check("JWT are iat+exp", typeof payload.iat === "number" && payload.exp - payload.iat === 900);
const parts = jwt.split(".");
const expectedSig = Buffer.from(
  createHmac("sha256", "jwtsecret").update(`${parts[0]}.${parts[1]}`).digest()
).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
check("semnătură HS256 validă", parts[2] === expectedSig);

console.log("— detecție surse (resolver) —");
const ts = resolveSource("http://server.tv/live/stream.ts");
check(".ts → kind ts + mpegts", ts?.kind === "ts" && ts.providerLabel === "MPEG-TS direct");
const srt = resolveSource("srt://broker.example.com:9000?streamid=live");
check("srt:// → unplayable + protocol srt", srt?.kind === "unplayable" && srt.protocol === "srt");
const rtmp = resolveSource("rtmp://ingest.example.com/live/key");
check("rtmp:// → unplayable", rtmp?.kind === "unplayable" && rtmp.protocol === "rtmp");
const rtsp = resolveSource("rtsp://cam.example.com/stream1");
check("rtsp:// → unplayable", rtsp?.kind === "unplayable" && rtsp.protocol === "rtsp");
const udp = resolveSource("udp://@239.1.1.1:5000");
check("udp:// → unplayable", udp?.kind === "unplayable" && udp.protocol === "udp");
const hls = resolveSource("https://tv.example.com/live/index.m3u8");
check("m3u8 rămâne HLS", hls?.kind === "hls");
const mp4 = resolveSource("https://files.example.com/movie.mp4?token=x");
check(".mp4 rămâne video", mp4?.kind === "video");

console.log(`\nRezultat: ${pass} OK, ${fail} EȘUATE`);
process.exit(fail > 0 ? 1 : 0);
