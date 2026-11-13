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
      /** Görevle verilen dosyalar: diskteki ad (runs/ekler/<oturum>/, GET /ekler/…) + kullanıcının verdiği ad */
      attachments?: Array<{ name: string; original: string }>;
      /** TFS modu: görev bir iş öğesinden geldi (src/tfsTask.ts). text = ajanlara giden iş öğesi metni
       *  (panelde açılır bölüm, aramada görev); note = kullanıcının ek talimatı; inherited = görev
       *  verilmedi, oturumun bağlı olduğu iş öğesinin devamı (yazma o öğeye) */
      workItem?: {
        id: number;
        type: string;
        title: string;
        state: string;
        url: string;
        project: string;
        assignedTo?: string;
        text?: string;
        note?: string;
        inherited?: boolean;
        /** İndirilemeyen ekler ("video.mp4 — 48 MB, sınır 20 MB") */
        skipped?: string[];
      };
      /** TFS modu: görev bir çekme isteğinden (src/tfsPrTask.ts). mode: yorum = açık yorumları ele al,
       *  incele = PR'ı incele (kod değiştirme). text/note/inherited iş öğesindeki gibi */
      pr?: {
        id: number;
        title: string;
        url: string;
        project: string;
        repositoryId: string;
        repository: string;
        source: string;
        target: string;
        mode: "yorum" | "incele";
        repoRel?: string;
        repoDir?: string;
        threads?: Array<{ id: number; firstCommentId: number; file?: string; line?: number; quote: string }>;
        text?: string;
        note?: string;
        inherited?: boolean;
      };
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
      /** transient | permanent | lost_session | context_full (src/resilience.ts) */
      kind?: string;
      delayMs: number;
      /** true ise deneme resume ile yapılacak (ajan baştan başlamaz) */
      resumed: boolean;
      /** true ise görev tekrar gönderilmez, kısa devam mesajı gider */
      continued?: boolean;
      /** Sıradaki denemenin nasıl yapılacağı, Türkçe ("yeni konuşmayla başlanacak",
       *  "özetleme yeniden denenecek"…) — varsa panel resumed/continued yerine bunu yazar */
      note?: string;
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
      /** esik: sıradaki görevden önce eşik aşıldı; is: ajan çalışırken eşik aşıldı (tur kesildi);
       *  dolu: sunucu "bağlam doldu" dedi */
      reason: "esik" | "is" | "dolu";
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
      /** Model yanıtı yanıt sınırına (max_tokens) takılıp yarıda kesildi. Claude Code
       *  modele "kaldığın yerden devam et" diyerek kendisi sürdürür ve bunu SDK'ye
       *  bildirmez (ölçüldü) — ajan bitince konuşma kaydından sayılır; yalnızca
       *  sürdürme de tükenirse anında hata mesajı gelir (exhausted) */
      type: "output_limit";
      agent: string;
      /** Takılınan sınır (jeton) — Claude Code'un mesajından, yoksa ayardan */
      limit: number;
      /** Bu koşuda kaç yanıt sınırda kesildi (verilmezse 1) */
      hits?: number;
      /** Claude Code devam ettirmeyi denedi ama vazgeçti (hata mesajı verdi) */
      exhausted?: boolean;
    }
  | {
      /** Ajan yazma kapsamı dışındaki bir dosyaya yazmak istedi, araç engellendi
       *  (ajan durmaz, gerekçe modele döner). repo: kapsam fanout mıntıkası; değilse hedef dizin */
      type: "write_blocked";
      agent: string;
      tool: string;
      file: string;
      scope: string;
      repo?: boolean;
    }
  | {
      /** Sürdürülecek konuşmanın kaydı bulunamadı — ajan yeni konuşmayla başlıyor.
       *  foundDir: kayıt başka bir proje klasöründe bulunduysa oradaki çalışma dizini */
      type: "session_lost";
      agent: string;
      sessionId: string;
      cwd: string;
      foundDir?: string;
      /** Claude Code'un konuşma kayıtlarının arandığı klasör (~/.claude/projects) */
      projectsDir?: string;
      /** Kayıt aranırken çıkan hata (varsa "bulunamadı" kesin değil) */
      searchError?: string;
      /** Yeni konuşmaya oturumun önceki görevlerinin özeti verildi */
      recap?: boolean;
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
  /** Onay kartındaki plan panelden uzak ajana gönderildi (planWebhook) — akışı etkilemez.
   *  host = hedef adresin sunucu kısmı, status = karşı tarafın HTTP kodu */
  | { type: "plan_sent"; agent: string; ok: boolean; host: string; status?: number; error?: string }
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
  /** TFS modu: iş bitti, sonucu iş öğesine yazmak için taslak hazır — panel kartla sorar
   *  (Ayarlar'da "sorarak"). text = düzenlenebilir not (gönderirken HTML'e çevrilir) */
  | {
      type: "tfs_writeback";
      id: number;
      title: string;
      workItemType: string;
      state: string;
      url: string;
      text: string;
      /** Koşuda değişen dosyalar — kartta "çekme isteği aç" seçeneği bunlar varsa çıkar */
      files?: string[];
    }
  /** İş öğesine yazıldı (ya da yazılamadı / bu sefer yazılmadı). auto: Ayarlar'da "kendiliğinden" */
  | {
      type: "tfs_written";
      id: number;
      ok: boolean;
      url?: string;
      /** Değiştirildiyse yeni durum */
      state?: string;
      error?: string;
      auto?: boolean;
      /** Kullanıcı "şimdilik yazma" dedi */
      skipped?: boolean;
      /** Yazmadan önce açılan çekme istekleri (depo başına) */
      prs?: Array<{ repo: string; id?: number; url?: string; existed?: boolean; branch?: string; error?: string }>;
    }
  /** TFS modu: PR görevi bitti — PR'a yazılacakların taslağı (yorumlara cevap, "düzeltildi", yeni
   *  yorumlar, genel yorum, gönderilecek commit). Panel kartla sorar (Ayarlar'da "sorarak") */
  | {
      type: "tfs_pr_writeback";
      id: number;
      title: string;
      url: string;
      mode: "yorum" | "incele";
      source: string;
      repository: string;
      replies: Array<{ threadId: number; firstCommentId: number; file?: string; line?: number; quote: string; text: string; resolve: boolean }>;
      comments: Array<{ file?: string; line?: number; text: string }>;
      general: string;
      commit?: { files: string[]; message: string };
    }
  /** PR'a yazıldı: gönderilen commit, cevaplanan/çözülen dizi, açılan yorum sayıları; hatalar */
  | {
      type: "tfs_pr_written";
      id: number;
      ok: boolean;
      url?: string;
      pushed?: { branch: string; commit: string };
      replied?: number;
      resolved?: number;
      created?: number;
      general?: boolean;
      errors?: string[];
      auto?: boolean;
      skipped?: boolean;
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
