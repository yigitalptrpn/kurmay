import type { AgentMetrics, ReviewVerdict, StructuredMiss } from "./types.js";

export type OrchestratorEvent =
  | {
      type: "workflow_started";
      task: string;
      provider: string;
      /** Bu koşunun modeli (oturuma özel ya da genel varsayılan; boş = sağlayıcı varsayılanı) */
      model?: string;
      /** Koşunun genel akıl yürütme derinliği (oturum ya da genel ayar; ajan düğümü ezebilir) */
      effort?: string;
      targetDir: string;
      entry: string;
      maxCycles: number;
      agents: string[];
      /** true ise entry ajan önceki oturumu sürdürüyor — panel akışı temizlenmez */
      resumed?: boolean;
      /** Devre dışı düğümler — panel hatta soluk/üstü çizili gösterir */
      disabled?: string[];
      /** Fanout düğümü → çoğalttığı ajan. Kopyalar fanout_started'da belli olur */
      fanouts?: Record<string, string>;
    }
  /** Devre dışı düğüm koşturulmadan geçildi; to = devam edilen düğüm (null = akış bitti) */
  | { type: "node_skipped"; node: string; to: string | null }
  | { type: "agent_started"; agent: string }
  | {
      /** Ajan açılınca eklentilerin (MCP) bağlantı durumu — ajan koşusu başına bir kez */
      type: "mcp_status";
      agent: string;
      servers: Array<{
        name: string;
        /** connected | failed | needs-auth | pending | disabled */
        status: string;
        error?: string;
        /** Bağlanınca sunucunun sunduğu araç sayısı */
        tools?: number;
      }>;
    }
  | { type: "agent_text"; agent: string; text: string }
  | {
      /** Sağlayıcı bağlantısı koptu — beklenip yeniden denenecek */
      type: "agent_retrying";
      agent: string;
      attempt: number;
      /** 0 = sınırsız */
      maxAttempts: number;
      error: string;
      /** Türkçe sebep ("sunucu meşgul (503)", "akış takıldı …") — eski kayıtlarda yok */
      reason?: string;
      /** transient | permanent | lost_session (src/resilience.ts) */
      kind?: string;
      delayMs: number;
      /** true ise deneme resume ile yapılacak (ajan baştan başlamaz) */
      resumed: boolean;
      /** true ise görev tekrar gönderilmez, kısa devam mesajı gider */
      continued?: boolean;
    }
  | {
      /** Ajanın konuşma boyutu (son model yanıtından) — paneldeki bağlam göstergesi */
      type: "context_usage";
      agent: string;
      tokens: number;
      /** Modelin bağlam penceresi (bilinmiyorsa yok) */
      window?: number;
      /** Kullanılabilir sınır: pencere − yanıta ayrılan pay */
      limit?: number;
    }
  | {
      /** Konuşma özetleniyor (Claude Code /compact) */
      type: "context_compacting";
      agent: string;
      tokens: number;
      limit?: number;
      /** esik: sıradaki görevden önce eşik aşıldı; dolu: sunucu "bağlam doldu" dedi */
      reason: "esik" | "dolu";
    }
  | {
      type: "context_compacted";
      agent: string;
      ok: boolean;
      pre?: number;
      post?: number;
      error?: string;
      /** Özetleme olmadıysa ne yapıldı: aynı konuşmayla devam ya da yeni konuşma */
      fallback?: "devam" | "yeni";
    }
  | {
      /** Sürdürülecek konuşmanın kaydı bulunamadı — ajan yeni konuşmayla başlıyor.
       *  foundDir: kayıt başka bir proje klasöründe bulunduysa oradaki çalışma dizini */
      type: "session_lost";
      agent: string;
      sessionId: string;
      cwd: string;
      foundDir?: string;
    }
  | {
      /** Claude Code isteği kendi içinde yeniden deniyor (süreç kapanmadan) */
      type: "api_retry";
      agent: string;
      attempt: number;
      maxRetries: number;
      delayMs: number;
      /** Türkçe sebep */
      reason: string;
    }
  | {
      type: "tool_used";
      agent: string;
      tool: string;
      detail: string;
      /** Dosya araçlarında yol, Bash'te komut — panel kod dostu gösterir (dosya çipi / mini terminal) */
      file?: string;
      command?: string;
      /** Düzenleme araçlarında yaklaşık satır sayısı (eski/yeni metinden) — panelde +N −M */
      added?: number;
      removed?: number;
    }
  | {
      type: "agent_finished";
      agent: string;
      output: string;
      structured?: unknown;
      /** Süre/tur/token ölçümü — panelde ajan satırının altında gösterilir */
      metrics?: AgentMetrics;
    }
  // endsFlow: rota akışı bitiriyor (ör. analist route=done) — onaylanırsa
  // sonraki adım yok, reddedilirse aynı ajan gerekçeyle yeniden koşar
  | {
      type: "approval_required";
      agent: string;
      output: string;
      structured?: unknown;
      endsFlow?: boolean;
      /** structured yoksa neden — kart bunu açıkça yazar */
      miss?: StructuredMiss;
      /** Planı otomatik iletme açıkken yine de onay soruluyorsa neden:
       *  empty = plan boş, unreadable = plan yapılandırılmış olarak okunamadı */
      autoForward?: "empty" | "unreadable";
    }
  /** Planı otomatik iletme açık: plan onay beklemeden sonraki adıma geçti
   *  (onay kartı açılmadı). to = devam edilen düğüm, files = plandaki dosya sayısı */
  | { type: "plan_forwarded"; agent: string; to: string | null; files: number }
  | {
      type: "approval_resolved";
      agent: string;
      approved: boolean;
      comment?: string;
      source: "terminal" | "web";
    }
  | {
      type: "verdict";
      agent: string;
      approved: boolean;
      issues: ReviewVerdict["issues"];
      summary: string;
    }
  | { type: "cycle"; n: number; max: number; to: string }
  // Repo başına dağıtım: ajanın kopyaları (key = "<ajan>@<repo>") başlar; kopya
  // başına agent_started/agent_finished olayları bu anahtarlarla gelir
  | {
      type: "fanout_started";
      node: string;
      agent: string;
      workers: Array<{ key: string; repo: string }>;
      /** 0 = sınırsız */
      maxConcurrency: number;
      /** Red/build turunda yalnızca geri bildirimde adı geçen repolar yeniden koşar */
      partial: boolean;
    }
  | { type: "fanout_finished"; node: string; repos: string[]; failed: Array<{ repo: string; error: string }> }
  | { type: "build_started"; order: string[] }
  | { type: "build_module_started"; module: string; command: string }
  | { type: "build_output"; module: string; text: string }
  | { type: "build_module_finished"; module: string }
  | { type: "build_failed"; module: string; code: number }
  | { type: "build_finished"; order: string[] }
  // Güvenlik denetçisinin raporu kaydedildi — panel /guvenlik#id bağlantısı gösterir
  | {
      type: "security_report";
      id: string;
      agent: string;
      risk?: string;
      counts: Record<"critical" | "high" | "medium" | "low" | "info", number>;
      structured: boolean;
    }
  | { type: "run_scheduled"; agent: string; runAt: number }
  | { type: "run_resumed"; agent: string; source: "timer" | "terminal" | "web" }
  | { type: "run_schedule_cancelled"; agent: string; source: "timer" | "terminal" | "web" }
  | { type: "workflow_finished" }
  | { type: "workflow_cancelled" }
  | { type: "workflow_failed"; error: string };

export type TimedEvent = OrchestratorEvent & { ts: string };

/**
 * Orkestratörün olay yayını. Terminal çıktısı, web paneli (SSE) ve JSONL koşu
 * kaydı hepsi bu yayının birer dinleyicisidir — iş akışı mantığı hiçbirini bilmez.
 * history, sonradan bağlanan panel istemcilerine geçmişi tekrar oynatmak içindir.
 */
export class EventBus {
  readonly history: TimedEvent[] = [];
  private listeners = new Set<(e: TimedEvent) => void>();

  emit(event: OrchestratorEvent): void {
    const timed: TimedEvent = { ...event, ts: new Date().toISOString() };
    this.history.push(timed);
    for (const listener of this.listeners) listener(timed);
  }

  subscribe(listener: (e: TimedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Yeni bir koşuya başlarken geçmişi temizler (SSE'ye yeni bağlananlar
   *  yalnızca güncel koşuyu görsün) */
  reset(): void {
    this.history.length = 0;
  }
}
