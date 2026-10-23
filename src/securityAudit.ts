import fs from "node:fs";
import path from "node:path";
import { EventBus } from "./events.js";
import { runAgent } from "./runAgent.js";
import { countBySeverity, toReport, type SecurityReportStore } from "./securityReport.js";
import type { AgentDefinition, AppConfig } from "./types.js";

/**
 * Bağımsız güvenlik denetimi — /guvenlik sayfasından başlatılır: denetçi ajan akışın
 * DIŞINDA, seçilen dizindeki kod tabanının tamamını inceler. Rapor akıştakiyle aynı
 * biçimde runs/guvenlik/'e yazılır (standalone: true). İşler bellekte tutulur: servis
 * yeniden başlarsa süren denetim kaybolur, bitmişlerin raporu diskte kalır. Olaylar
 * runs/<iş kimliği>.jsonl'e de yazılır (akıştaki koşu kayıtları gibi).
 */

export type AuditStatus = "running" | "finished" | "failed" | "cancelled";

export interface AuditStep {
  ts: string;
  /** Araç adı (Read, Grep, Glob, mcp__…) — sayfa simgeye çevirir */
  tool: string;
  /** Okunan dosya (dizine göre) ya da arama/listeleme ayrıntısı */
  text: string;
}

export interface AuditJob {
  id: string;
  dir: string;
  model?: string;
  startedAt: string;
  finishedAt?: string;
  status: AuditStatus;
  /** Bitince yazılan raporun kimliği (GET /security-reports/<id>) */
  reportId?: string;
  /** Raporun özeti — sayfa iş listesinde rapora geçmeden gösterir */
  risk?: string;
  findings?: number;
  error?: string;
  /** Canlı ilerleme: okunan farklı dosya sayısı, arama/listeleme sayısı, son adımlar */
  filesRead: number;
  searches: number;
  steps: AuditStep[];
  /** Bekleme notu (bağlantı sorunu, konuşma özetleniyor…) — sıradaki adımda silinir */
  note?: string;
  /** Durdur'a basıldı, ajan süreci kapanıyor (bir iki saniye sürer) */
  stopping?: boolean;
}

/** Sayfada gösterilen son adım sayısı */
const STEP_KEEP = 12;
/** Bellekte tutulan iş sayısı (bitmişlerin raporu diskte) */
const JOB_KEEP = 30;

/** Denetçiye giden görev — rol tanımındaki "bağımsız denetim" kipini seçtirir */
export const STANDALONE_AUDIT_PROMPT = [
  "# Görev",
  "Bağımsız güvenlik denetimi: çalışma dizinindeki kod tabanının tamamını denetle.",
  "Bu denetim kullanıcı tarafından Kurmay akışının dışında başlatıldı — Saha Timi'nin değişiklik listesi yok, kapsam projenin tamamı.",
  "",
  "# Nasıl çalış",
  "1. Önce yapıyı çıkar: Glob ile klasörlere, dillere ve çatılara, bağımlılık (package.json, pom.xml, build.gradle, requirements.txt, go.mod…) ve yapılandırma dosyalarına bak.",
  "2. Dışarıdan girdi alan uçları, kimlik doğrulama ve yetkilendirmeyi, veritabanı erişimini, dosya ve süreç işlemlerini, serileştirmeyi, kriptografiyi ve gizli bilgi taşıyabilecek yapılandırmayı öncelikle oku.",
  "3. Grep ile tehlikeli kalıpları ara (ör. dize birleştirmeyle kurulan sorgu, komut çalıştırma, eval, kaçışlanmadan basılan HTML, parola/anahtar/belirteç geçen satırlar) ve bulduklarını dosyayı okuyarak doğrula.",
  "4. node_modules, target, build, dist, vendor, .git gibi üretilmiş ya da dışarıdan gelmiş klasörleri okuma.",
  "5. Raporu rol tanımındaki kurallara göre yaz; özette neyi incelediğini, neyi incelemediğini belirt.",
].join("\n");

export class SecurityAuditRunner {
  private jobs: AuditJob[] = [];
  private controllers = new Map<string, AbortController>();

  constructor(private readonly o: { store: SecurityReportStore; runsDir: string }) {}

  /** En yeni önce */
  list(): AuditJob[] {
    return this.jobs.map((j) => ({ ...j, steps: [...j.steps] }));
  }

  running(): number {
    return this.jobs.filter((j) => j.status === "running").length;
  }

  runningIn(dir: string): boolean {
    return this.jobs.some((j) => j.status === "running" && j.dir === dir);
  }

  /** Denetimi arka planda başlatır; iş hemen döner, ilerleme list() ile izlenir */
  start(dir: string, agent: AgentDefinition, cfg: AppConfig): AuditJob {
    const now = new Date();
    const job: AuditJob = {
      id: `denetim-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`,
      dir,
      model: agent.config.model ?? cfg.model,
      startedAt: now.toISOString(),
      status: "running",
      filesRead: 0,
      searches: 0,
      steps: [],
    };
    this.jobs.unshift(job);
    // Eski bitmiş işler bellekten düşer (raporları diskte)
    for (let i = this.jobs.length - 1; i >= 0 && this.jobs.length > JOB_KEEP; i--) {
      if (this.jobs[i].status !== "running") this.jobs.splice(i, 1);
    }
    const ac = new AbortController();
    this.controllers.set(job.id, ac);
    void this.run(job, agent, cfg, ac);
    return job;
  }

  /** Süren denetimi durdurur; durdurulacak iş yoksa false */
  cancel(id: string): boolean {
    const ac = this.controllers.get(id);
    if (!ac) return false;
    const job = this.jobs.find((j) => j.id === id);
    if (job) job.stopping = true;
    ac.abort();
    return true;
  }

  private async run(job: AuditJob, agent: AgentDefinition, cfg: AppConfig, ac: AbortController): Promise<void> {
    const bus = new EventBus();
    const log = path.join(this.o.runsDir, `${job.id}.jsonl`);
    const read = new Set<string>();
    const rel = (f: string) => {
      const r = path.relative(job.dir, path.resolve(job.dir, f));
      return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.split(path.sep).join("/") : f;
    };
    bus.subscribe((e) => {
      try {
        fs.appendFileSync(log, JSON.stringify(e) + "\n");
      } catch {
        /* kayıt yazılamadı — denetim sürsün */
      }
      if (e.type === "tool_used") {
        job.note = undefined;
        const text = e.file ? rel(e.file) : e.detail;
        if (e.tool === "Read" && e.file) {
          read.add(rel(e.file));
          job.filesRead = read.size;
        } else if (e.tool === "Grep" || e.tool === "Glob") {
          job.searches++;
        }
        job.steps.push({ ts: e.ts, tool: e.tool, text });
        if (job.steps.length > STEP_KEEP) job.steps.splice(0, job.steps.length - STEP_KEEP);
      } else if (e.type === "agent_retrying") {
        job.note = `${e.reason ?? "bağlantı sorunu"} — ${Math.max(1, Math.round(e.delayMs / 1000))} sn sonra yeniden denenecek`;
      } else if (e.type === "api_retry") {
        job.note = `${e.reason} — istek yeniden deneniyor (${e.attempt}/${e.maxRetries})`;
      } else if (e.type === "context_compacting") {
        job.note = "konuşma uzadı, özetleniyor…";
      } else if (e.type === "context_compacted") {
        job.note = undefined;
      }
    });

    console.log(`\n🛡  Bağımsız güvenlik denetimi başladı: ${job.dir}`);
    try {
      const r = await runAgent(agent, STANDALONE_AUDIT_PROMPT, job.dir, cfg, bus, ac);
      const report = toReport(
        {
          task: `Kod tabanı denetimi: ${path.basename(job.dir) || job.dir}`,
          targetDir: job.dir,
          model: job.model,
          files: [...read].sort(),
          standalone: true,
        },
        r.structured,
        r.text,
      );
      this.o.store.save(report);
      job.reportId = report.id;
      job.risk = report.risk;
      job.findings = report.findings.length;
      job.status = "finished";
      const c = countBySeverity(report.findings);
      console.log(`🛡  Bağımsız denetim bitti (${job.dir}): ${report.findings.length} bulgu (kritik ${c.critical}, yüksek ${c.high}), risk ${report.risk ?? "?"}`);
    } catch (err) {
      job.status = ac.signal.aborted ? "cancelled" : "failed";
      if (!ac.signal.aborted) {
        job.error = err instanceof Error ? err.message : String(err);
        console.error(`⚠ Bağımsız denetim düştü (${job.dir}): ${job.error}`);
      } else {
        console.log(`⏹  Bağımsız denetim durduruldu: ${job.dir}`);
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      job.note = undefined;
      job.stopping = undefined;
      this.controllers.delete(job.id);
    }
  }
}
