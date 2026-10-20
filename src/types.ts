import { z } from "zod";

// Teftiş kararının şeması — iş akışı yönlendirmesi bu nesneye göre yapılır.
// Structured output sayesinde API bu şemaya uymayan çıktı üretemez.
export const ReviewVerdictSchema = z.object({
  approved: z.boolean(),
  issues: z.array(
    z.object({
      file: z.string(),
      description: z.string(),
      severity: z.enum(["low", "medium", "high"]),
    }),
  ),
  summary: z.string(),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

/**
 * Karar şemasının Agent SDK outputFormat için JSON Schema hali.
 * DİKKAT: z.toJSONSchema'nın eklediği "$schema" başlığı outputFormat'ı
 * SESSİZCE bozar (success döner ama structured_output boş kalır) — bu yüzden
 * burada çıkarılıyor. Doğrulandı: 2026-07-07 A/B testi.
 */
export function reviewVerdictJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ReviewVerdictSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** Kullanıcı koşuyu iptal ettiğinde fırlatılır — akış temiz şekilde durdurulur */
export class RunCancelledError extends Error {
  constructor() {
    super("Koşu kullanıcı tarafından iptal edildi");
    this.name = "RunCancelledError";
  }
}

/**
 * Ajana bağlı komut-hook'u. SDK'nin hook mekanizmasına bağlanır: belirtilen
 * olayda (PreToolUse/PostToolUse vb.) komut çalıştırılır, hook girdisi stdin'e
 * JSON verilir; komut `exit 2` ile aracı ENGELLER (stderr = gerekçe), `exit 0`
 * ile izin verir (JSON stdout ileri kullanım için doğrudan aktarılır).
 */
export interface HookConfig {
  /** Hook olayı: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" ... */
  event: string;
  /** Araç adı eşleştirici (regex) — PreToolUse/PostToolUse için (ör. "Bash", "Write|Edit") */
  matcher?: string;
  /** Çalıştırılacak kabuk komutu (hook girdisi stdin'e JSON gelir) */
  command: string;
  /** Saniye cinsinden zaman aşımı (varsayılan 60) */
  timeout?: number;
}

export interface AgentNodeConfig {
  /** Düğüm türü — ajan düğümü (varsayılan). Komut düğümleri "command" kullanır. */
  type?: "agent";
  /** true ise düğüm DEVRE DIŞI: akış bu düğüme gelince onu koşturmadan "geçer"
   *  kenarından devam eder (bkz. passThroughTarget). Panelden/editörden canlı
   *  açılıp kapatılabilir; sıradaki görevde geçerli olur. */
  disabled?: boolean;
  /** Ajanın system prompt'unu içeren md dosyası (config dosyasının dizinine göre) */
  file: string;
  /** Bu ajanın kullanabileceği Claude Code araçları */
  tools: string[];
  /** .claude/rules/<ad>.md dosyaları — içerikleri system prompt'a HER ZAMAN eklenir */
  rules?: string[];
  /** .claude/skills/<ad>/SKILL.md becerileri — ad+açıklama listelenir, ajan ilgili
   *  görürse dosyayı Read ile kendisi okur (frontmatter'da inline: true ise tamamı gömülür) */
  skills?: string[];
  /** İsteğe bağlı model override'ı (config'deki genel "model" alanını ezer) */
  model?: string;
  /** Akıl yürütme derinliği (SDK'nin effort seçeneği). Ucuz/dar işler için "low",
   *  güvenlik gibi yüksek bedelli incelemeler için "high"/"xhigh"; "off" düşünmeyi kapatır.
   *  Genel/oturum ayarını ezer. */
  effort?: EffortSetting;
  /** Bu ajana bağlı komut-hook'ları (araç kapıları, otomatik lint/format vb.) */
  hooks?: HookConfig[];
  /** true ise bu ajanın çıktısı sonrasında kullanıcı onayı beklenir */
  requiresUserApproval?: boolean;
  /** true ise bu ajanın çıktısı güvenlik denetimi raporu olarak runs/guvenlik/ altına
   *  kaydedilir ve /guvenlik sayfasında gösterilir (src/securityReport.ts) */
  securityReport?: boolean;
  /** Koşulsuz geçiş: bir sonraki ajanın adı (null/tanımsız = akış biter) */
  next?: string | null;
  /** Tanımlıysa çıktıdan structured verdict çıkarılır ve karara göre dallanılır */
  verdict?: {
    onApprove: string | null;
    onReject: string;
  };
  /**
   * Structured çıktıdaki bir alanın değerine göre koşullu dallanma (next/verdict
   * yerine). Ajan rotayı structured output'ta ÖNERİR; geçişi orchestrator yapar.
   * Örn. analistin "route" alanı: "implement" → saha-timi, "done" → akış biter.
   * cases'te olmayan/eksik değer default'a düşer (default yoksa akış biter).
   */
  routes?: {
    field: string;
    cases: Record<string, string | null>;
    default?: string | null;
  };
}

/**
 * Komut düğümü — LLM değil, deterministik bir build adımı. Yıldız topoloji için:
 * saha ajanının değiştirdiği dosyalardan hangi repoların dokunulduğu OTOMATİK
 * çıkarılır (dosyanın targetDir altındaki en üst klasörü = repo). "parent"
 * değiştiyse önce o build edilir, sonra değişen servisler ortak "command" ile.
 * Modül listesi tutulmaz. Exit code'a göre dallanır: hepsi başarılıysa onSuccess,
 * ilk hata onFailure'a (build log'u geri bildirim olur).
 */
export interface CommandNodeConfig {
  type: "command";
  /** true ise düğüm DEVRE DIŞI: akış bu düğüme gelince onu koşturmadan "geçer"
   *  kenarından devam eder (bkz. passThroughTarget). Panelden/editörden canlı
   *  açılıp kapatılabilir; sıradaki görevde geçerli olur. */
  disabled?: boolean;
  /** Değişen servis repolarında çalıştırılacak varsayılan build komutu */
  command: string;
  /** Ortak parent (örn. common-events). Değişmişse diğerlerinden ÖNCE build edilir. */
  parent?: {
    /** targetDir'e göreli klasör adı (repo kökü) */
    path: string;
    /** Parent'a özel komut; verilmezse "command" kullanılır */
    command?: string;
  };
  /** parent değiştiğinde, kodu değişmese bile TÜM servis repolarını da build et */
  rebuildAllOnParentChange?: boolean;
  onSuccess: string | null;
  onFailure: string;
}

/**
 * Repo başına dağıtım düğümü — LLM değil, bir fan-out/fan-in kapısı. Analist'in
 * `file_plan`'ı repolara bölünür (dosyanın targetDir altındaki en üst klasörü =
 * repo, build.ts ile aynı kural) ve "agent" düğümünün her repo için AYRI bir
 * kopyası koşar; kaç kopya olacağına KOD karar verir (plan kaç repoya dokunuyorsa).
 * Sonuçlar tek bir çıktıda birleşir ve akış "next"e geçer.
 *
 * Her kopya yalnızca kendi repo dilimini görür ve Write/Edit'i o repo dışına
 * hook ile ENGELLENİR — aynı dizinde eş zamanlı çalıştıkları için. (Bash yine
 * de yazabilir; persona + kapsam talimatı ona karşı.)
 *
 * Neden SDK subagent değil: orada kaç alt-ajanın koşacağına model karar verir.
 */
export interface FanoutNodeConfig {
  type: "fanout";
  /** true ise DAĞITIM kapalı: ajan bölünmemiş planla TEK kopya koşar, sonra "next".
   *  (Diğer düğümlerden farklı: atlanmaz — işi yapan ajan zaten bu düğümün içinde.
   *  Ajanın kendisini atlamak için işçi düğümü kapat.) */
  disabled?: boolean;
  /** Repo başına çoğaltılacak ajan düğümü (ör. "saha"). Kendi kenarı olamaz. */
  agent: string;
  /** Aynı anda en fazla kaç kopya koşar. Yerel model sunucusu istekleri sırayla
   *  işliyorsa paralellik HIZ KAZANDIRMAZ, kuyruk ve zaman aşımı riski getirir —
   *  sunucunun eş zamanlı kapasitesine göre ayarla. 0/yok = sınırsız. */
  maxConcurrency?: number;
  /** Ortak/parent repo klasörü (ör. common-events): plana dahilse diğerlerinden
   *  ÖNCE tek başına koşar — servisler güncel sözleşmeye göre kod yazsın. */
  parent?: string;
  /** Tüm kopyalar bitince gidilecek düğüm (null = akış biter) */
  next: string | null;
}

export type WorkflowNode = AgentNodeConfig | CommandNodeConfig | FanoutNodeConfig;

export function isCommandNode(node: WorkflowNode): node is CommandNodeConfig {
  return (node as CommandNodeConfig).type === "command";
}

export function isFanoutNode(node: WorkflowNode): node is FanoutNodeConfig {
  return (node as FanoutNodeConfig).type === "fanout";
}

/** LLM olmayan kapı düğümleri (komut/fanout) — persona/araç listesi yok */
export function isGateNode(node: WorkflowNode): node is CommandNodeConfig | FanoutNodeConfig {
  return isCommandNode(node) || isFanoutNode(node);
}

/**
 * Akışın ANA yolu: entry'den başlayıp ileri (başarı/koşullu) kenarlar boyunca
 * BFS sırası. Geri dönüş kenarları (red, build hatası) ve fanout işçileri
 * (fanout'un içinde koşar) dahil değil. Panelin görev kartı düğüm çiplerini
 * bu sırayla gösterir.
 */
export function mainPath(workflow: WorkflowConfig): string[] {
  const order: string[] = [];
  const queue = [workflow.entry];
  while (queue.length) {
    const key = queue.shift()!;
    const node = workflow.agents[key];
    if (!node || order.includes(key)) continue;
    order.push(key);
    const forward: Array<string | null | undefined> = isCommandNode(node)
      ? [node.onSuccess]
      : isFanoutNode(node)
        ? [node.next]
        : [node.next, node.verdict?.onApprove, ...Object.values(node.routes?.cases ?? {}), node.routes?.default];
    for (const t of forward) if (t && !order.includes(t)) queue.push(t);
  }
  return order;
}

/**
 * Devre dışı düğümün "geçer" kenarı — akış onu koşturmadan buradan devam eder.
 * Hep BAŞARI yönü seçilir (düğüm hiç itiraz etmemiş gibi): komut → onSuccess,
 * fanout → next, verdict → onApprove, routes → default, next → next.
 * null = akış biter.
 */
export function passThroughTarget(node: WorkflowNode): string | null {
  if (isCommandNode(node)) return node.onSuccess;
  if (isFanoutNode(node)) return node.next;
  if (node.verdict) return node.verdict.onApprove;
  if (node.routes) return node.routes.default ?? null;
  return node.next ?? null;
}

export interface WorkflowConfig {
  /** Akışın başlayacağı ajan adı */
  entry: string;
  /** Reject döngüsünün üst sınırı (sonsuz döngü koruması) */
  maxCycles: number;
  /** true ise onay isteyen düğümün PLANI (dolu file_plan) onay beklemeden sonraki
   *  adıma (Saha Timi) iletilir — Analist planı bitince düğmeye basmak gerekmez.
   *  Plan okunamazsa ya da boşsa, veya rota akışı bitiriyorsa onay yine sorulur.
   *  Ayarlar sayfasından canlı değişir; sıradaki görevde geçerli. Varsayılan kapalı. */
  autoForwardPlan?: boolean;
  agents: Record<string, WorkflowNode>;
}

/** MCP sunucu tanımı — Claude Code'un .mcp.json formatıyla birebir aynı.
 *  stdio: { command, args?, env? }  |  uzak: { type: "http"|"sse", url, headers? } */
export type McpServerJson = (
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> }
) & {
  /** true ise sunucu KAPALI: başlatılmaz, ajanların araç listesinden ve prompt'undan
   *  çıkar (bkz. activeMcpServers). Aç/Kapat sayfasından canlı değiştirilir. */
  disabled?: boolean;
};

/**
 * Maliyet ve süre sınırları — hepsi opsiyonel, verilenler Claude Code alt
 * sürecine ortam değişkeni olarak geçer (buildAgentEnv). Özellikle yavaş yerel
 * modeller için: output token token üretildiğinden büyük çıktı doğrudan süreye
 * yazılır. Verilmeyen alan SDK varsayılanında kalır.
 */
export interface LimitsConfig {
  /** Şemaya uymayan çıktı için yeniden deneme sayısı (SDK varsayılanı 5).
   *  Her deneme TÜM structured output'un baştan üretilmesi demek — yavaş
   *  modellerde asıl gecikme sıçraması burada. Denemeler bitse de akış ölmez:
   *  runAgent ajanı bir kez şemasız yeniden çalıştırır. */
  structuredOutputRetries?: number;
  /** Tek API çağrısı zaman aşımı, ms (SDK varsayılanı 600000 = 10 dk).
   *  Yavaş yerel modelde büyük çıktı bunu AŞABİLİR — API error'ın sebebi
   *  buysa değeri düşürmek değil YÜKSELTMEK gerekir. */
  apiTimeoutMs?: number;
  /** Ajan çıktısının üst sınırı (token) */
  maxOutputTokens?: number;
  /** MCP araç sonuçlarının üst sınırı (token) — arama sonuçları context şişirir */
  maxMcpOutputTokens?: number;
  /** Düşünme (thinking) token bütçesi */
  maxThinkingTokens?: number;
  /** Claude Code'un tek istek için KENDİ İÇİNDE yaptığı yeniden deneme sayısı
   *  (CLAUDE_CODE_MAX_RETRIES; varsayılan 10, en fazla 15 — üstünü CLI 15'e
   *  indirir). 503/429/5xx/zaman aşımı/bağlantı kopması bu denemelerle süreç
   *  kapanmadan atlatılır; tükenirse hata bize gelir ve dış yeniden deneme
   *  (RetryConfig) devreye girer. */
  apiMaxRetries?: number;
  /** Model listesinde bağlam sınırı (max_model_len) olmayan modeller için bağlam
   *  penceresi, token. Claude Code'a CLAUDE_CODE_MAX_CONTEXT_TOKENS olarak da gider
   *  (bilinen model için listedeki değer gider). */
  contextTokens?: number;
  /** Otomatik özetleme eşiği, kullanılabilir bağlamın yüzdesi (varsayılan 75; 0 =
   *  kapalı). Sürdürülen konuşma bunu geçmişse sıradaki görevden önce özetlenir. */
  compactPercent?: number;
}

/**
 * Sağlayıcı bağlantısı koptuğunda yeniden deneme davranışı. On-premise LLM
 * sunucularında bağlantı sık kopabildiği için varsayılan SINIRSIZ denemedir:
 * akış ölmez, bağlantı geri gelene kadar bekler. Tek çıkış kapısı kullanıcının
 * Durdur'u (iptal). Oturum kimliği yakalanmışsa deneme resume ile yapılır —
 * ajan baştan başlamaz, kaldığı yerden devam eder.
 */
export interface RetryConfig {
  /** false verilirse yeniden deneme kapanır ve hata akışı düşürür (varsayılan: açık) */
  enabled?: boolean;
  /** Deneme üst sınırı; 0 = sınırsız (varsayılan 0) */
  maxAttempts?: number;
  /** İlk bekleme süresi, ms (varsayılan 5000). Her denemede ikiye katlanır */
  initialDelayMs?: number;
  /** Bekleme süresinin tavanı, ms (varsayılan 60000) */
  maxDelayMs?: number;
  /** Kalıcı görünen hatada (yetki, model bulunamadı, istek reddedildi — 400/401/
   *  403/404/413/422) ÜST ÜSTE deneme sınırı; 0 = sınırsız (varsayılan 5). Araya
   *  geçici bir hata (503 vb.) girerse ya da ajan ilerlerse sayaç sıfırlanır —
   *  yük altında tek tük garip yanıt veren ağ geçidi akışı düşürmez. */
  permanentMaxAttempts?: number;
  /** Beklemeleri rastgele dağıt (varsayılan açık): aynı anda kopan çok sayıda
   *  istemci sunucuya aynı saniyede geri yüklenmesin */
  jitter?: boolean;
  /** Akış takılma süresi, ms (varsayılan 300000). Model yanıtı akmaya BAŞLADIKTAN
   *  sonra bu süre boyunca hiç veri gelmezse: 300000 ve üstünde Claude Code'un kendi
   *  bekçisi isteği keser ve yanıtı akışsız tamamlar (CLAUDE_STREAM_IDLE_TIMEOUT_MS);
   *  altında bizim bekçimiz denemeyi keser, oturum sürdürülerek yeniden denenir.
   *  0 = bizim bekçi kapalı (Claude Code'unki 5 dk'da yine çalışır). Yanıtın ilk
   *  baytını bekleme süresine (kuyruk) ve araç çalışmasına UYGULANMAZ — onları
   *  "apiTimeoutMs" sınırlar. */
  stallTimeoutMs?: number;
}

/** Akıl yürütme derinliği seçenekleri. "off" dışındakiler SDK'nin effort seçeneğine
 *  gider (istekte output_config.effort + thinking: adaptive); "off" düşünmeyi kapatır
 *  (thinking: disabled → istekte thinking alanı hiç gönderilmez). Liste sabittir:
 *  Claude Code bu beşinin dışındaki değerleri (minimal, none, sayı…) sessizce "high"
 *  yapar — sahte API ile doğrulandı. Modelin bu alanı dikkate alıp almadığı model
 *  sunucusuna bağlıdır. */
export const EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortSetting = (typeof EFFORT_LEVELS)[number];

/** Sağlayıcı bağlantı bilgileri — hem Anthropic hem Ollama aynı alanları kullanır */
export interface ProviderConfig {
  /** "anthropic": Claude API / Claude Code oturumu. "ollama": yerel Ollama sunucusu */
  provider: "anthropic" | "ollama";
  /** API adresi. Anthropic'te boş bırakılır; Ollama için örn. http://localhost:11434 */
  baseUrl?: string;
  /** API token'ı. Anthropic'te boşsa Claude Code oturumu kullanılır; Ollama doğrulamaz */
  apiKey?: string;
  /** Ajanların varsayılan modeli. Anthropic'te boşsa Claude Code varsayılanı */
  model?: string;
  /** Panelde model seçimi için listenin çekileceği adres (GET). "apiKey" başlıkta
   *  gönderilir (Authorization: Bearer + x-api-key). Boşsa panelde seçici kapalı */
  modelsUrl?: string;
  /** Ajanların varsayılan akıl yürütme derinliği. Oturum kendi ayarını taşır (panelden
   *  değişir), ajan düğümündeki "effort" ikisini de ezer. Boşsa SDK varsayılanı (yüksek) */
  effort?: EffortSetting;
  /** Geliştirmenin yapılacağı hedef proje dizini (CLI --cwd bayrağı bunu ezer) */
  targetDir?: string;
  /** MCP sunucuları. Bir ajanın bu sunucuların araçlarını kullanabilmesi için
   *  tools listesine "mcp__<sunucu>" (tümü) veya "mcp__<sunucu>__<araç>" eklenmeli */
  mcpServers?: Record<string, McpServerJson>;
  /** Kapalı beceriler (.claude/skills/<ad>): hiçbir ajanın prompt'una girmez, ajan
   *  düğümünde listelenmiş olsa bile. Aç/Kapat sayfasından canlı değiştirilir. */
  disabledSkills?: string[];
  /** Kapalı kurallar (.claude/rules/<ad>.md): hiçbir ajanın prompt'una girmez, ajan
   *  düğümünde listelenmiş olsa bile. Aç/Kapat sayfasından canlı değiştirilir. */
  disabledRules?: string[];
  /** Maliyet/süre sınırları (opsiyonel) — yavaş yerel modeller için */
  limits?: LimitsConfig;
  /** Bağlantı koptuğunda yeniden deneme (opsiyonel) — verilmezse sınırsız denenir */
  retry?: RetryConfig;
}

/** Tek config dosyasının tamamı: bağlantı bilgileri + iş akışı grafı */
export interface AppConfig extends ProviderConfig {
  workflow: WorkflowConfig;
  /** İzleme paneli portu (varsayılan 4141; CLI --port bayrağı bunu ezer) */
  uiPort?: number;
  /** Sunucu modunda aynı anda koşabilecek görev (oturum) sayısı (varsayılan 3).
   *  Zamanlanmış bekleyen görev de sayılır. Yerel model sunucusu istekleri
   *  sırayla işliyorsa yüksek değer hız kazandırmaz, kuyruk/zaman aşımı getirir. */
  maxParallelRuns?: number;
}

export interface AgentDefinition {
  key: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** Ajanın çıktı JSON şeması (md frontmatter "output" alanından; verdict
   *  düğümlerinde yerleşik karar şeması kullanılır). Tanımlıysa ajan Agent
   *  SDK'nin outputFormat'ıyla çalışır ve şemaya uyan JSON üretir. */
  outputSchema?: Record<string, unknown>;
  config: AgentNodeConfig;
}

/**
 * Bir ajan koşusunun GERÇEK ölçümü (SDK'nin result mesajından; tahmin değil).
 * Yavaş yerel modelde neyin pahalı olduğu ancak buradan görülür.
 *
 * DİKKAT — iki alan yanıltıcı okunabilir:
 * - `turns`: şema retry'ını İZOLE ETMEZ. Araç çağıran normal bir ajan zaten çok
 *   turludur; retry'lar da bu sayıya karışır. Ham sinyal olarak kullan.
 * - `perModel[].inputTokens`: koşu boyunca TOPLAM (turların toplamı), anlık
 *   context doluluğu DEĞİL. contextWindow'a bölüp "%doluluk" çıkarma — çok
 *   turlu koşuda %100'ü rahatça aşar ve yanlış olur.
 */
export interface AgentMetrics {
  /** Toplam süre (ms) */
  durationMs: number;
  /** Yalnızca API'de geçen süre (ms); aradaki fark araç/yerel iş demektir */
  apiDurationMs: number;
  /** Model turu sayısı (yukarıdaki uyarıya bak) */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Yerel modelde 0 gelir — anlamlı olan Anthropic koşularında */
  costUsd: number;
  /** Model bazında kırılım. Birden fazla model görünüyorsa arka planda ikinci
   *  bir model (ör. ANTHROPIC_SMALL_FAST_MODEL) çalışıyor demektir. */
  perModel: Array<{ model: string; inputTokens: number; outputTokens: number }>;
}

/** Bir ajan koşusunun sonucu: serbest metin + varsa şemaya uyan JSON */
/**
 * Yapılandırılmış çıktı neden gelmedi — panel onay kartı genel "şema bozulmuş"
 * yerine hangi yoldan düşüldüğünü yazar.
 * - repair_text: model aracı çağırmadan metinle bitti, onarım turunda da metinle döndü
 * - repair_failed: onarım turu şemaya uygun çıktı üretemeden hatayla bitti
 * - no_session: oturum kimliği alınamadı, onarım turu denenemedi
 * - schemaless: şema denemeleri tükendi, ajan şemasız yeniden koşturuldu
 */
export interface StructuredMiss {
  reason: "repair_text" | "repair_failed" | "no_session" | "schemaless";
  /** Bu ajan koşusunda bağlantı kopması sonrası yapılan yeniden deneme sayısı */
  retries: number;
}

export interface AgentRunResult {
  text: string;
  structured?: unknown;
  /** Şema beklenip structured gelmediyse sebebi */
  miss?: StructuredMiss;
  /** SDK oturum kimliği — resume (oturumu sürdürme) için saklanır */
  sessionId?: string;
  /** Süre/tur/token ölçümü; SDK vermezse tanımsız kalır */
  metrics?: AgentMetrics;
  /** Konuşmanın son boyutu (token): son model yanıtının girdi+çıktısı ya da özetleme
   *  sonrası boyut. Oturum sürdürülürken bağlam doluluğu buradan bilinir */
  contextTokens?: number;
}
