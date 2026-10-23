import fs from "node:fs";
import path from "node:path";
import type { EventBus } from "./events.js";

/**
 * Güvenlik denetimi raporları — denetçi ajanın (config'te `securityReport: true`
 * olan düğüm) yapılandırılmış çıktısı her koşuda runs/guvenlik/<id>.json olarak
 * saklanır; /guvenlik sayfası bunları listeler ve gösterir. runs/ .gitignore'da.
 */

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface SecurityFinding {
  severity: Severity;
  title: string;
  file: string;
  line?: number;
  category?: string;
  cwe?: string;
  description: string;
  evidence?: string;
  recommendation: string;
}

export interface SecurityReport {
  id: string;
  createdAt: string;
  /** Oturum kimliği ve adı (panelde "oturuma git" için) */
  session?: string;
  sessionName?: string;
  task: string;
  targetDir: string;
  model?: string;
  /** Denetlenen dosyalar: akışta saha timinin değiştirdikleri, bağımsız denetimde
   *  denetçinin okudukları (çalışma dizinine göre) */
  files: string[];
  /** Bağımsız denetim (/guvenlik sayfasından, kod tabanının tamamı) — akıştaki değil */
  standalone?: boolean;
  /** Genel risk düzeyi: none | low | medium | high | critical (çıktı gelmediyse yok) */
  risk?: string;
  summary?: string;
  findings: SecurityFinding[];
  positives: string[];
  /** Yapılandırılmış çıktı gelmediyse ajanın düz metni — sayfa onu gösterir */
  rawText?: string;
}

/** Listede gösterilen özet (tam raporu sayfa ayrıca ister) */
export type SecurityReportSummary = Pick<SecurityReport, "id" | "createdAt" | "task" | "risk" | "sessionName" | "standalone"> & {
  counts: Record<Severity, number>;
};

export function countBySeverity(findings: SecurityFinding[]): Record<Severity, number> {
  const c = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) if (f.severity in c) c[f.severity]++;
  return c;
}

/** Ajan çıktısını (şemalı olsa da olmasa da) güvenli bir rapora çevirir */
export function toReport(
  base: Omit<SecurityReport, "id" | "createdAt" | "findings" | "positives" | "risk" | "summary" | "rawText">,
  structured: unknown,
  text: string,
): SecurityReport {
  const st = (structured && typeof structured === "object" ? structured : null) as Record<string, unknown> | null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const findings: SecurityFinding[] = Array.isArray(st?.findings)
    ? (st!.findings as Array<Record<string, unknown>>)
        .filter((f) => f && typeof f === "object")
        .map((f) => ({
          severity: (SEVERITIES as readonly string[]).includes(String(f.severity)) ? (f.severity as Severity) : "info",
          title: str(f.title) ?? "Adsız bulgu",
          file: str(f.file) ?? "",
          ...(Number.isInteger(f.line) && (f.line as number) > 0 ? { line: f.line as number } : {}),
          ...(str(f.category) ? { category: str(f.category) } : {}),
          ...(str(f.cwe) ? { cwe: str(f.cwe) } : {}),
          description: str(f.description) ?? "",
          ...(str(f.evidence) ? { evidence: String(f.evidence).replace(/\s+$/, "") } : {}),
          recommendation: str(f.recommendation) ?? "",
        }))
        // Önem sırasına göre: kritik en üstte
        .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
    : [];
  const now = new Date();
  return {
    id: `${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: now.toISOString(),
    ...base,
    ...(st && str(st.risk) ? { risk: str(st.risk) } : {}),
    ...(st && str(st.summary) ? { summary: str(st.summary) } : {}),
    findings,
    positives: Array.isArray(st?.positives) ? (st!.positives as unknown[]).map(str).filter((s): s is string => !!s) : [],
    ...(st ? {} : { rawText: text }),
  };
}

export class SecurityReportStore {
  constructor(private readonly dir: string) {}

  save(report: SecurityReport): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${report.id}.json`), JSON.stringify(report, null, 2));
  }

  /** En yeni önce; bozuk dosyalar atlanır */
  list(limit = 200): SecurityReportSummary[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: SecurityReportSummary[] = [];
    for (const n of names.sort().reverse().slice(0, limit)) {
      const r = this.get(n.slice(0, -5));
      if (r) {
        out.push({
          id: r.id,
          createdAt: r.createdAt,
          task: r.task,
          risk: r.risk,
          sessionName: r.sessionName,
          ...(r.standalone ? { standalone: true } : {}),
          counts: countBySeverity(r.findings),
        });
      }
    }
    return out;
  }

  get(id: string): SecurityReport | undefined {
    if (!/^[\w-]+$/.test(id)) return undefined; // yol enjeksiyonuna karşı
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8")) as SecurityReport;
    } catch {
      return undefined;
    }
  }
}

/**
 * Koşunun olay kanalını dinler: denetçi ajan (isReportAgent) bitince çıktısını rapora
 * çevirip kaydeder ve "security_report" olayı yayınlar (panel bağlantı gösterir).
 * Denetlenen dosyalar = o ana kadarki en son "changes" listesi (saha timinin çıktısı).
 * Dinlemeyi bırakmak için dönen fonksiyonu çağır.
 */
export function watchSecurityReports(
  bus: EventBus,
  store: SecurityReportStore,
  o: {
    isReportAgent: (agent: string) => boolean;
    base: Omit<SecurityReport, "id" | "createdAt" | "findings" | "positives" | "risk" | "summary" | "rawText" | "files">;
    label?: string;
  },
): () => void {
  let lastChanged: string[] = [];
  return bus.subscribe((e) => {
    if (e.type !== "agent_finished") return;
    const changes = (e.structured as { changes?: Array<{ file?: unknown }> } | undefined)?.changes;
    if (Array.isArray(changes)) {
      const files = changes.map((c) => c?.file).filter((f): f is string => typeof f === "string" && !!f);
      if (files.length) lastChanged = [...new Set(files)];
    }
    if (!o.isReportAgent(e.agent)) return;
    try {
      const report = toReport({ ...o.base, files: lastChanged }, e.structured, e.output);
      store.save(report);
      console.log(`🛡  ${o.label ? `[${o.label}] ` : ""}Güvenlik raporu: ${report.findings.length} bulgu, risk ${report.risk ?? "?"}`);
      // Hemen yayınla: bu dinleyici koşu başında en son abone olduğu için önceki dinleyiciler
      // (panel, kayıt) agent_finished'i çoktan almıştır; sıra "denetçi bitti → rapor → akış bitti" olur
      bus.emit({
        type: "security_report",
        id: report.id,
        agent: e.agent,
        risk: report.risk,
        counts: countBySeverity(report.findings),
        structured: report.rawText === undefined,
      });
    } catch (err) {
      console.error("⚠ Güvenlik raporu kaydedilemedi:", err instanceof Error ? err.message : err);
    }
  });
}
