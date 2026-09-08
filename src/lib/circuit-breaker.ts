// ============================================================
// Circuit Breaker + Admission Control (Faza 9)
// „Fără ca nimic să pice" — chiar și când Neon e lent/indisponibil:
//
//  1. CIRCUIT BREAKER: urmărește eșecurile DB în fereastră glisantă.
//     - CLOSED (normal): toate cererile trec.
//     - OPEN (DB picat): cererile eșuează INSTANT (fail-fast) → straturile
//       de deasupra servesc din cache L1/L2 (mod degradat), fără 500-uri.
//     - HALF-OPEN: după cooldown, 1 cerere de probă testează recuperarea.
//
//  2. ADMISSION CONTROL: plafon pe interogările origin simultane.
//     Peste plafon → așteaptă în coadă (max `queueMs`) → timeout.
//     Protejează compute-ul Neon de avalanșe (ținta: 10.000 căutări
//     simultane fără ca origin-ul să colapseze).
//
//  3. STALE-WHILE-ERROR: la eșec origin, servim cache expirat dacă
//     există (mai bun decât o eroare pentru utilizator).
//
// Stateless per instanță; la scale orizontal fiecare instanță
// protejează local, iar L2 shared din Neon absoarbe restul traficului.
// ============================================================

// ---------- Circuit Breaker ----------

export type BreakerState = "closed" | "open" | "half-open";

type BreakerConfig = {
  /** număr de eșecuri consecutive care deschide circuitul */
  failureThreshold: number;
  /** ms în care circuitul deschis permite o probă de test (half-open) */
  cooldownMs: number;
  /** fereastră (ms) în care se contorizează eșecuri consecutive */
  windowMs: number;
};

const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 10_000,
  windowMs: 30_000,
};

type BreakerRuntime = {
  state: BreakerState;
  failures: number;
  firstFailureAt: number;
  lastFailureAt: number;
  openedAt: number;
  probes: number; // cereri de probă în half-open
  totalTrips: number; // metrică: de câte ori s-a deschis
  totalFailFast: number; // metrică: cereri refuzate instant
};

const g = globalThis as unknown as { __breaker?: BreakerRuntime };

function rt(): BreakerRuntime {
  if (!g.__breaker) {
    g.__breaker = {
      state: "closed",
      failures: 0,
      firstFailureAt: 0,
      lastFailureAt: 0,
      openedAt: 0,
      probes: 0,
      totalTrips: 0,
      totalFailFast: 0,
    };
  }
  return g.__breaker;
}

/** Cere permisiunea de a trimite o interogare către DB. */
export function dbAllow(cfg: Partial<BreakerConfig> = {}): {
  allowed: boolean;
  state: BreakerState;
} {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  const b = rt();
  const now = Date.now();

  if (b.state === "closed") return { allowed: true, state: "closed" };

  if (b.state === "open") {
    if (now - b.openedAt >= c.cooldownMs) {
      // trecem în half-open și permitem o singură probă
      b.state = "half-open";
      b.probes = 0;
    } else {
      b.totalFailFast++;
      return { allowed: false, state: "open" };
    }
  }

  // half-open: permite maximum 1 probă simultan
  if (b.probes >= 1) {
    b.totalFailFast++;
    return { allowed: false, state: "half-open" };
  }
  b.probes++;
  return { allowed: true, state: "half-open" };
}

/** Raportează succesul unei interogări (închide circuitul / resetează contorul). */
export function dbReportSuccess(): void {
  const b = rt();
  b.state = "closed";
  b.failures = 0;
  b.firstFailureAt = 0;
  b.probes = 0;
}

/** Raportează eșecul unei interogări; deschide circuitul la prag. */
export function dbReportFailure(cfg: Partial<BreakerConfig> = {}): void {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  const b = rt();
  const now = Date.now();

  // fereastră glisantă: eșecuri mai vechi decât windowMs se resetează
  if (b.firstFailureAt && now - b.firstFailureAt > c.windowMs) {
    b.failures = 0;
    b.firstFailureAt = 0;
  }

  if (b.state === "half-open") {
    // proba a eșuat → redeschidem imediat pentru un nou cooldown
    b.state = "open";
    b.openedAt = now;
    b.totalTrips++;
    b.probes = 0;
    return;
  }

  if (b.failures === 0) b.firstFailureAt = now;
  b.failures++;
  b.lastFailureAt = now;

  if (b.failures >= c.failureThreshold && b.state === "closed") {
    b.state = "open";
    b.openedAt = now;
    b.totalTrips++;
  }
}

/** Starea curentă + metrici pentru /api/health și /api/status. */
export function breakerStatus(): {
  state: BreakerState;
  failures: number;
  totalTrips: number;
  totalFailFast: number;
  openedAt: number | null;
} {
  const b = rt();
  return {
    state: b.state,
    failures: b.failures,
    totalTrips: b.totalTrips,
    totalFailFast: b.totalFailFast,
    openedAt: b.state === "open" ? b.openedAt : null,
  };
}

// ---------- Admission Control (coadă pe origin) ----------

type GateConfig = {
  /** maxim de interogări origin în zbor, per instanță */
  maxConcurrent: number;
  /** ms max de așteptat în coadă pentru un slot */
  queueMs: number;
};

const GATE_DEFAULT: GateConfig = { maxConcurrent: 16, queueMs: 1_500 };

type GateRuntime = { inFlight: number; waiters: number; maxObserved: number; timedOut: number };

const gg = globalThis as unknown as { __gate?: GateRuntime };

function gate(): GateRuntime {
  if (!gg.__gate) gg.__gate = { inFlight: 0, waiters: 0, maxObserved: 0, timedOut: 0 };
  return gg.__gate;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Rulează `fn` sub plafonul de concurență. Când plafonul e atins,
 * așteaptă până la `queueMs` un slot liber; la timeout → eroare
 * AdmissionRejected (apelantul servește cache/degradat).
 */
export async function withAdmission<T>(
  fn: () => Promise<T>,
  cfg: Partial<GateConfig> = {}
): Promise<T> {
  const c = { ...GATE_DEFAULT, ...cfg };
  const s = gate();
  const deadline = Date.now() + c.queueMs;

  // buclă de așteptare cu back-off scurt (fără dependențe externe)
  while (s.inFlight >= c.maxConcurrent) {
    if (Date.now() >= deadline) {
      s.timedOut++;
      throw new AdmissionRejected(`origin la capacitate (${c.maxConcurrent} în zbor)`);
    }
    s.waiters++;
    try {
      await sleep(25 + Math.random() * 25); // jitter anti-thundering-herd
    } finally {
      s.waiters--;
    }
  }

  s.inFlight++;
  if (s.inFlight > s.maxObserved) s.maxObserved = s.inFlight;
  try {
    return await fn();
  } finally {
    s.inFlight--;
  }
}

/** Aruncată când admission control refuză cererea (origin supraîncărcat). */
export class AdmissionRejected extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AdmissionRejected";
  }
}

export function gateStatus(): {
  inFlight: number;
  waiting: number;
  maxConcurrent: number;
  maxObserved: number;
  timedOut: number;
} {
  const s = gate();
  return {
    inFlight: s.inFlight,
    waiting: s.waiters,
    maxConcurrent: GATE_DEFAULT.maxConcurrent,
    maxObserved: s.maxObserved,
    timedOut: s.timedOut,
  };
}
