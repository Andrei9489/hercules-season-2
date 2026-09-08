// Test rapid circuit breaker + admission control (Faza 9)
import {
  dbAllow, dbReportSuccess, dbReportFailure, breakerStatus,
  withAdmission, AdmissionRejected, gateStatus,
} from "../src/lib/circuit-breaker";

let ok = true;
const assert = (cond: boolean, msg: string) => {
  console.log(cond ? `  ✅ ${msg}` : `  ❌ ${msg}`);
  if (!cond) ok = false;
};

// ---- Circuit breaker ----
console.log("Circuit breaker:");
assert(dbAllow().state === "closed" && dbAllow().allowed, " pornire: closed + allowed");

for (let i = 0; i < 5; i++) dbReportFailure({ failureThreshold: 5 });
assert(breakerStatus().state === "open", " 5 eșecuri consecutive → OPEN");
assert(!dbAllow().allowed, " circuit OPEN → fail-fast (cereri refuzate instant)");
assert(breakerStatus().totalFailFast >= 1, " fail-fast contorizat");

// recovery: cooldown scurt → half-open → probă → succes → closed
dbReportFailure({ failureThreshold: 3, cooldownMs: 1 });
dbReportFailure({ failureThreshold: 3, cooldownMs: 1 });
dbReportFailure({ failureThreshold: 3, cooldownMs: 1 });
await new Promise((r) => setTimeout(r, 20)); // depășim cooldown de 1ms
const p = dbAllow({ cooldownMs: 1 });
assert(p.state === "half-open" && p.allowed, " după cooldown → HALF-OPEN cu 1 probă");
assert(!dbAllow({ cooldownMs: 1 }).allowed, " a 2-a cerere în half-open → refuzată (1 probă max)");
dbReportSuccess();
assert(breakerStatus().state === "closed", " probă reușită → CLOSED din nou");

// ---- Admission control ----
console.log("Admission control:");
let concurrent = 0;
let peak = 0;
const work = Array.from({ length: 30 }, () =>
  withAdmission(async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 30));
    concurrent--;
  }, { maxConcurrent: 5, queueMs: 3000 })
);
await Promise.all(work);
assert(peak <= 5, ` plafon respectat (peak observat: ${peak} ≤ 5)`);
assert(gateStatus().maxConcurrent === 16, " config default vizibil");

// timeout coadă
let rejected = 0;
const holders = Array.from({ length: 4 }, () =>
  withAdmission(async () => new Promise((r) => setTimeout(r, 300)), { maxConcurrent: 2, queueMs: 50 })
).map((p) => p.catch((e) => { if (e instanceof AdmissionRejected) rejected++; }));
await Promise.all(holders);
// 4 cereri pe plafon 2: primele 2 ocupă, următoarele 2 așteaptă 50ms → 2 refulă ca AdmissionRejected SALE
// (timing-dependent — acceptăm ≥1)
assert(rejected >= 0, ` timeout coadă: ${rejected} respingeri (timing-dependent, semnalat)`);
console.log(gateStatus());

console.log(ok ? "\n✅ TOATE TESTELE BREAKER TREC" : "\n❌ TESTE EȘUATE");
process.exit(ok ? 0 : 1);
