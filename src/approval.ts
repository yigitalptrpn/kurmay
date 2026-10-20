import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { EventBus } from "./events.js";
import { RunCancelledError, type StructuredMiss } from "./types.js";

/** run sinyali abort edilirse RunCancelledError ile reddeden promise (yarışlara eklenir) */
function cancelPromise(runSignal?: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (!runSignal) return; // asla çözülmez
    if (runSignal.aborted) reject(new RunCancelledError());
    else runSignal.addEventListener("abort", () => reject(new RunCancelledError()), { once: true });
  });
}

export interface ApprovalResult {
  approved: boolean;
  /** Reddedildiyse kullanıcının düzeltme talebi */
  comment?: string;
  /** Onaylandıysa çalıştırmanın erteleneceği zaman (epoch ms). Yoksa/geçmişse hemen. */
  runAt?: number;
}

/** Zamanlanmış beklemenin nasıl sona erdiği */
export type ScheduleOutcome = "fired" | "run_now" | "cancelled";

/** Web panelinden onay + zamanlama denetimi bekleme kanalı (server.ts sağlar) */
export interface WebApprovalChannel {
  /** true ise onay/zamanlama YALNIZCA panelden: terminal (stdin) yarışa girmez.
   *  Sunucu modunda birden çok oturum aynı anda soru sorabilir; stdin'den gelen
   *  cevabın hangi oturuma ait olduğu belirsiz olurdu. */
  exclusive?: boolean;
  wait(): Promise<ApprovalResult>;
  cancel(): void;
  /** Zamanlanmış bekleme sırasında panelden "şimdi çalıştır/iptal" bekler */
  waitSchedule(): Promise<Extract<ScheduleOutcome, "run_now" | "cancelled">>;
  cancelSchedule(): void;
}

const MAX_TIMEOUT = 2 ** 31 - 1; // setTimeout üst sınırı (~24.8 gün)

/** Tarihi Türkçe gün.ay.yıl saat:dakika biçiminde gösterir */
export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Kullanıcı girdisini çalıştırma zamanına (epoch ms) çevirir. Boş → undefined
 * (hemen). Göreli biçim: "+30m", "+2h", "+1d". Mutlak biçim: Date.parse'ın
 * anladığı her şey ("2026-07-10 14:00", ISO vb.). Anlaşılamazsa undefined.
 */
export function parseRunAt(input: string): number | undefined {
  const s = input.trim();
  if (!s) return undefined;

  const rel = s.match(/^\+\s*(\d+)\s*(m|h|d)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return Date.now() + n * ms;
  }

  const abs = Date.parse(s);
  return Number.isNaN(abs) ? undefined : abs;
}

async function askTerminal(
  agentName: string,
  signal: AbortSignal,
  endsFlow = false,
): Promise<ApprovalResult> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const soru = endsFlow
      ? `\n❓ ${agentName} kod değişikliği gerekmediğini söylüyor. Akış burada bitsin mi? (e=bitir / h=gerekçeyle yeniden planlat): `
      : `\n❓ ${agentName} çıktısını onaylıyor musun? (e/h): `;
    const answer = (await rl.question(soru, { signal })).trim().toLowerCase();

    if (answer === "e" || answer === "evet" || answer === "y" || answer === "yes") {
      // Akış zaten bitiyorsa ileri tarih sormanın anlamı yok
      if (endsFlow) return { approved: true };
      const when = await rl.question(
        "Ne zaman çalışsın? (boş=hemen, örn 2026-07-10 14:00 veya +30m/+2h/+1d): ",
        { signal },
      );
      const runAt = parseRunAt(when);
      if (when.trim() && runAt === undefined) {
        console.warn("⚠ Zaman anlaşılamadı — hemen çalıştırılacak.");
      }
      return { approved: true, runAt };
    }

    const comment = await rl.question("Neyin değişmesini istiyorsun? ", { signal });
    return { approved: false, comment: comment.trim() || undefined };
  } finally {
    rl.close();
  }
}

/**
 * Kullanıcı onayı — kodda gerçek bir duraklama. Terminal (e/h) ve web paneli
 * aynı anda dinlenir; hangisi önce cevap verirse o geçerli olur, diğeri iptal
 * edilir. Reddedilirse alınan yorum aynı ajana geri bildirim olarak döner.
 */
export async function askUserApproval(
  agentName: string,
  output: string,
  bus: EventBus,
  web?: WebApprovalChannel,
  structured?: unknown,
  runSignal?: AbortSignal,
  endsFlow = false,
  miss?: StructuredMiss,
  /** Otomatik iletme açık ama plan iletilemedi — kart nedenini yazar */
  autoForward?: "empty" | "unreadable",
): Promise<ApprovalResult> {
  bus.emit({ type: "approval_required", agent: agentName, output, structured, endsFlow, miss, autoForward });

  // Kaybeden taraf sessizce beklemede kalsın diye hatalar asla-çözülmeyen
  // bir promise'e çevrilir (kapalı stdin, abort vb. yarışı düşürmesin)
  const never = new Promise<never>(() => {});
  const ac = new AbortController();

  const candidates: Promise<{ result: ApprovalResult; source: "terminal" | "web" }>[] = [];
  if (!web?.exclusive) {
    candidates.push(
      askTerminal(agentName, ac.signal, endsFlow)
        .then((result) => ({ result, source: "terminal" as const }))
        .catch(() => never),
    );
  }
  if (web) {
    candidates.push(
      web
        .wait()
        .then((result) => ({ result, source: "web" as const }))
        .catch(() => never),
    );
  }
  // Kullanıcı iptali bekleme sırasında da geçerli — RunCancelledError fırlatır
  candidates.push(cancelPromise(runSignal));

  let winner;
  try {
    winner = await Promise.race(candidates);
  } finally {
    ac.abort();
    web?.cancel();
  }

  if (winner.source === "web") {
    console.log(`\n🌐 Onay web panelinden geldi: ${winner.result.approved ? "onaylandı" : "reddedildi"}`);
  }

  bus.emit({
    type: "approval_resolved",
    agent: agentName,
    approved: winner.result.approved,
    comment: winner.result.comment,
    source: winner.source,
  });

  return winner.result;
}

/** Uzun ertelemeleri setTimeout üst sınırını aşmadan zincirler */
function fireAt(runAt: number, signal: AbortSignal, resolve: () => void): void {
  const remaining = runAt - Date.now();
  if (remaining <= 0) {
    resolve();
    return;
  }
  const t = setTimeout(() => fireAt(runAt, signal, resolve), Math.min(remaining, MAX_TIMEOUT));
  signal.addEventListener("abort", () => clearTimeout(t), { once: true });
}

/** Terminalden zamanlama denetimi: c=şimdi çalıştır, i=iptal (abort'a kadar bloklar) */
async function askTerminalSchedule(runAt: number, signal: AbortSignal): Promise<ScheduleOutcome> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\n⏰ ${fmtDate(runAt)} için zamanlandı.`);
    while (true) {
      const ans = (
        await rl.question("[c]=şimdi çalıştır, [i]=iptal (yoksa zamanı bekle): ", { signal })
      )
        .trim()
        .toLowerCase();
      if (ans === "c" || ans === "calistir") return "run_now";
      if (ans === "i" || ans === "iptal") return "cancelled";
      // tanınmayan giriş → tekrar sor
    }
  } finally {
    rl.close();
  }
}

/**
 * Onay sonrası zamanlı duraklama — kodda gerçek bir bekleme. Üç kanal yarışır:
 * zamanlayıcı (zamanı gelince "fired"), terminal ve web paneli ("run_now"/
 * "cancelled"). Hangisi önce sonuçlanırsa o geçerli; diğerleri iptal edilir.
 * Süreç ayakta kaldığı sürece çalışır (serve modu). Not: kalıcı değildir —
 * yeniden başlatma bekleyen zamanlamayı kaybeder.
 */
export async function waitForScheduledTime(
  runAt: number,
  web?: WebApprovalChannel,
  runSignal?: AbortSignal,
): Promise<{ outcome: ScheduleOutcome; source: "timer" | "terminal" | "web" }> {
  const never = new Promise<never>(() => {});
  const ac = new AbortController();

  const candidates: Promise<{ outcome: ScheduleOutcome; source: "timer" | "terminal" | "web" }>[] = [
    new Promise<void>((resolve) => fireAt(runAt, ac.signal, resolve)).then(() => ({
      outcome: "fired" as const,
      source: "timer" as const,
    })),
  ];
  if (!web?.exclusive) {
    candidates.push(
      askTerminalSchedule(runAt, ac.signal)
        .then((outcome) => ({ outcome, source: "terminal" as const }))
        .catch(() => never),
    );
  }
  if (web) {
    candidates.push(
      web
        .waitSchedule()
        .then((outcome) => ({ outcome, source: "web" as const }))
        .catch(() => never),
    );
  }
  // Kullanıcı iptali zamanlı bekleme sırasında da geçerli
  candidates.push(cancelPromise(runSignal));

  try {
    return await Promise.race(candidates);
  } finally {
    ac.abort();
    web?.cancelSchedule();
  }
}
