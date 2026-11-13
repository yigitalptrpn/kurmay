import type { TimedEvent } from "./events.js";

/**
 * Onay kartındaki planı dışarı vermek: başka bir ajana elle verilecek dosya
 * (Markdown / JSON indirme) ya da başka makinedeki bir ajana REST isteği.
 * Plan, oturumun olay geçmişindeki son "approval_required" olayından okunur;
 * görev ve dizin o koşunun "workflow_started" olayından gelir.
 */

/** Analist planının şeması (.claude/agents/analist.md) — eksik alanlar boş geçilir */
interface PlanChange {
  location?: string;
  before?: string;
  after?: string;
  rationale?: string;
}
interface PlanFile {
  path?: string;
  action?: string;
  summary?: string;
  changes?: PlanChange[];
}
interface PlanStructured {
  summary?: string;
  assumptions?: string[];
  file_plan?: PlanFile[];
  answer?: string;
}

export interface FoundPlan {
  agent: string;
  task: string;
  targetDir: string;
  /** Onay kartına düştüğü an */
  at: string;
  /** Ajanın yapılandırılmış çıktısı; gelmediyse undefined (metin `output`'ta) */
  structured?: unknown;
  output: string;
  /** Kart açık mı (onay hâlâ bekleniyor) */
  pending: boolean;
}

/** Oturum geçmişindeki son onay planı; hiç onay sorulmadıysa undefined */
export function findPlan(history: readonly TimedEvent[]): FoundPlan | undefined {
  let task = "";
  let targetDir = "";
  let found: FoundPlan | undefined;
  for (const e of history) {
    if (e.type === "workflow_started") {
      task = e.task;
      targetDir = e.targetDir;
    } else if (e.type === "approval_required") {
      found = { agent: e.agent, task, targetDir, at: e.ts, structured: e.structured, output: e.output, pending: true };
    } else if (
      found &&
      (e.type === "approval_resolved" ||
        e.type === "workflow_cancelled" ||
        e.type === "workflow_failed" ||
        e.type === "workflow_finished")
    ) {
      found.pending = false;
    }
  }
  return found;
}

/** Uzak ajana giden / JSON olarak indirilen gövde */
export function planPayload(p: FoundPlan, meta: { session: string; version: string }) {
  return {
    source: "kurmay",
    version: meta.version,
    session: meta.session,
    agent: p.agent,
    createdAt: p.at,
    task: p.task,
    targetDir: p.targetDir,
    // Analist şeması: summary, assumptions[], file_plan[{path, action, summary, changes[{location, before, after, rationale}]}]
    plan: p.structured ?? null,
    // Yapılandırılmış çıktı gelmediyse ajanın metni (plan bunun içinde olabilir)
    ...(p.structured ? {} : { text: p.output }),
    // Aynı plan okunur biçimde — doğrudan bir ajana verilebilir
    markdown: planMarkdown(p),
  };
}

const ACTION_NAMES: Record<string, string> = { create: "yeni dosya", modify: "değişecek", delete: "silinecek" };

/** Kod bloğunu içerikteki ``` dizilerinden uzun bir çitle sarar */
function fence(code: string): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((s) => s.length));
  const f = "`".repeat(longest + 1);
  return `${f}\n${code.replace(/\s+$/, "")}\n${f}`;
}

/** Planın başka bir ajana verilecek okunur hali */
export function planMarkdown(p: FoundPlan): string {
  const s = (p.structured && typeof p.structured === "object" ? p.structured : {}) as PlanStructured;
  const out: string[] = ["# Uygulama planı", ""];
  if (p.task) out.push("## Görev", "", p.task.trim(), "");
  if (p.targetDir) out.push(`Proje dizini: \`${p.targetDir}\``, "");
  if (!p.structured) {
    out.push("## Plan", "", p.output.trim() || "(plan boş)", "");
    return out.join("\n");
  }
  if (s.summary) out.push("## Özet", "", s.summary.trim(), "");
  if (s.answer) out.push("## Cevap", "", s.answer.trim(), "");
  if (s.assumptions?.length) {
    out.push("## Varsayımlar", "", ...s.assumptions.map((a) => `- ${a}`), "");
  }
  const files = Array.isArray(s.file_plan) ? s.file_plan : [];
  if (files.length) {
    out.push("## Dosyalar", "");
    files.forEach((f, i) => {
      const action = f.action ? ` (${ACTION_NAMES[f.action] ?? f.action})` : "";
      out.push(`### ${i + 1}. \`${f.path ?? "?"}\`${action}`, "");
      if (f.summary) out.push(f.summary.trim(), "");
      for (const c of f.changes ?? []) {
        if (c.location) out.push(`**Nerede:** ${c.location}`, "");
        if (c.before?.trim()) out.push("Önce:", "", fence(c.before), "");
        if (c.after?.trim()) out.push("Sonra:", "", fence(c.after), "");
        if (c.rationale) out.push(`**Neden:** ${c.rationale}`, "");
      }
    });
  }
  return out.join("\n");
}

/** İndirilen dosyanın adı: plan-2026-11-06-1430.md */
export function planFileName(p: FoundPlan, ext: "md" | "json"): string {
  const d = new Date(p.at);
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = Number.isNaN(d.getTime())
    ? "plan"
    : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  return `plan-${stamp}.${ext}`;
}

/** Uzak ajana gönderim sonucu */
export interface PlanSendResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** Karşı tarafın yanıtının başı (panelde ipucu olarak) */
  body?: string;
}

/**
 * Planı başka makinedeki ajana JSON olarak POST eder. Sunucudan gider (tarayıcının
 * çapraz köken kısıtı yok, anahtar tarayıcıdan geçmez). 30 sn sınır.
 */
export async function sendPlan(target: { url: string; apiKey?: string }, payload: unknown): Promise<PlanSendResult> {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.text().catch(() => "")).slice(0, 500);
    return res.ok
      ? { ok: true, status: res.status, body }
      : { ok: false, status: res.status, body, error: `sunucu ${res.status} döndü` };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (err.name === "TimeoutError") return { ok: false, error: "30 sn içinde yanıt gelmedi" };
    const why = err.cause?.code ?? err.cause?.message ?? err.message;
    return { ok: false, error: `bağlanılamadı (${why})` };
  }
}
