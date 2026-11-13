import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunAt } from "./approval.js";
import { parseFiles, resolveAttachment, type FileInput } from "./attachments.js";
import { attachmentHeader, BROWSER_ENV, findBrowser, pdfFileName, printPdf } from "./reportPdf.js";
import { buildEml, renderReportEmail } from "./reportEmail.js";
import type { SecurityReport } from "./securityReport.js";
import { findPlan, planFileName, planMarkdown, planPayload, sendPlan } from "./planExport.js";
import { SEARCH_KINDS, type SearchKind } from "./search.js";
import { parseWorkItemRef } from "./tfs.js";
import { parsePrRef } from "./tfsPr.js";
import type { ModelInfo } from "./models.js";
import type { McpLight, McpToolInfo } from "./mcpStatus.js";

/** Paneldeki eklenti durum ışıklarının verisi */
export interface McpStatusView {
  servers: McpLight[];
  probing: boolean;
  error?: string;
}
import type { RuntimeRegistry, SessionRuntime } from "./runtime.js";
import type { LimitsConfig, RetryConfig } from "./types.js";

export interface UiServer {
  url: string;
  close(): void;
}

/** Klasör seçicide gizlenen sistem klasörleri (Windows) — "." ile başlayanlar da gizli */
const HIDDEN_DIRS = new Set(["System Volume Information", "$RECYCLE.BIN", "$Recycle.Bin", "Recovery", "Config.Msi"]);

/** Kullanıcı talimatının en fazla uzunluğu — her ajan isteğinin system prompt'una girer */
const USER_PROMPT_MAX = 4000;

/**
 * Klasör seçici (GET /browse): tarayıcı güvenlik gereği seçilen klasörün tam yolunu
 * vermez, bu yüzden klasörleri sunucu listeler. Yalnızca klasör ADLARI döner (dosya
 * yok). İstenen dizin yoksa en yakın var olan üst klasörden açılır.
 */
function browseDir(requested: string, fallback: string) {
  const isDir = (d: string) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  };
  let dir = path.resolve(requested.trim() || (isDir(fallback) ? fallback : os.homedir()));
  while (!isDir(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  // Sürücüler (Windows) ya da kök; tıklanınca oraya gidilir
  const roots =
    process.platform === "win32"
      ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`).filter(isDir)
      : ["/"];
  const parent = path.dirname(dir) !== dir ? path.dirname(dir) : null;
  const base = { dir, parent, sep: path.sep, roots, home: os.homedir() };
  try {
    const dirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && !HIDDEN_DIRS.has(e.name))
      // Kısayol/bağlantı klasöre gidiyorsa o da klasör sayılır
      .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name))))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, "tr", { numeric: true, sensitivity: "base" }));
    return { ...base, dirs };
  } catch {
    return { ...base, dirs: [] as string[], error: "Bu klasörün içi okunamadı (izin yok)" };
  }
}

/** Aç/Kapat sayfasındaki anahtar türleri: ajan düğümü, kural, beceri, MCP sunucusu */
export type ToggleKind = "agent" | "rule" | "skill" | "mcp";

/** POST /task yanıtı */
export interface TaskResult {
  ok: boolean;
  error?: string;
  session?: string;
  warning?: string;
  dirChanged?: string;
  resetResume?: boolean;
  /** TFS görevinde oturumun/koşunun görünen adı ("#123 · Başlık") */
  display?: string;
}

/** TFS modu uçları (src/index.ts kurar; src/tfs.ts + src/tfsTask.ts) */
export interface TfsApi {
  view(): unknown;
  save(input: Record<string, unknown>): Promise<{ ok: boolean; error?: string; view?: unknown }>;
  probe(input: Record<string, unknown>): Promise<{ ok: boolean; error?: string; probe?: unknown }>;
  preview(id: number): Promise<unknown>;
  mine(done: boolean): Promise<unknown>;
  search(q: string): Promise<unknown>;
  attachment(guid: string, name: string): Promise<{ data: Buffer; type: string }>;
  states(session: string): Promise<unknown>;
  write(session: string, text: string, state?: string, pr?: { open?: boolean; target?: string; draft?: boolean }): Promise<{ ok: boolean; error?: string }>;
  dismiss(session: string): { ok: boolean; error?: string };
  prPreview(id: number, dir?: string): Promise<unknown>;
  prMine(): Promise<unknown>;
  prCheckout(id: number, dir?: string): Promise<unknown>;
  prWrite(session: string, input: {
    push: boolean;
    message?: string;
    replies: Array<{ threadId: number; firstCommentId: number; text: string; resolve: boolean; send: boolean }>;
    comments: Array<{ file?: string; line?: number; text: string; send: boolean }>;
    general?: string;
  }): Promise<{ ok: boolean; error?: string }>;
  prDismiss(session: string): { ok: boolean; error?: string };
}

export interface UiServerOptions {
  /** Oturum çalışma zamanları — olay akışı, onay/zamanlama/iptal oturum başına */
  runtimes: RuntimeRegistry;
  /** Panelden görev (POST /task). session verilirse o oturumda devam (analist
   *  konuşması sürdürülür), yoksa yeni oturum açılır. Kabul edilirse oturum id'si döner. */
  onTask?: (
    task: string,
    session?: string,
    runAt?: number,
    /** Görevle yapıştırılan/sürüklenen dosyalar (src/attachments.ts) */
    files?: FileInput[],
    /** Yalnızca bu görev için seçilen hedef dizin (panelde yazma kutusundaki 📁): yeni oturum
     *  orada açılır, var olan oturumun dizini buna geçer; config.json'daki genel dizin değişmez */
    targetDir?: string,
    /** TFS modu: görev bu iş öğesinden kurulur (task = kullanıcının ek talimatı, boş olabilir) */
    workItem?: number,
    /** TFS modu: görev bu çekme isteğinden kurulur; kip: yorum (açık yorumları ele al) | incele */
    pr?: number,
    prMode?: "yorum" | "incele",
  ) => TaskResult | Promise<TaskResult>;
  /** Görev eklerinin klasörü (runs/) — GET /ekler/<oturum>/<dosya> */
  runsDir?: string;
  /** Oturum listesi + canlı durumları (GET /sessions ve /lobby SSE) */
  getSessions: () => unknown[];
  /** Oturum biliniyorsa runtime'ını verir (geçmişi diskten yükleyerek); yoksa undefined */
  openSession: (id: string) => SessionRuntime | undefined;
  /** Bir oturumu katalogdan siler (POST /session-delete); silindiyse true */
  deleteSession?: (id: string) => boolean;
  /** Config editörü verisi: ham config.json + kullanılabilir kural/beceri/ajan-md adları */
  getConfigData?: () => { raw: string; rules: string[]; skills: string[]; agents: string[] };
  /** Config'i doğrulayıp kaydeder; hata varsa mesaj döner, başarılıysa null */
  saveConfig?: (raw: string) => string | null;
  /** Yeni ajan düğümü için şablon persona .md oluşturur */
  createAgentMd?: (name: string) => { ok: boolean; file?: string; error?: string };
  /** Rol tanımı (persona .md) dosyası: ham metin + talimat metni + kısa açıklama */
  getAgentMd?: (file: string) => { ok: boolean; file?: string; raw?: string; body?: string; description?: string; error?: string };
  /** Rol tanımını kaydeder: ya talimat metni + açıklama (ön bölüm korunur) ya da dosyanın tamamı */
  saveAgentMd?: (file: string, edit: { body?: string; description?: string; raw?: string }) => { ok: boolean; error?: string };
  /** Şu an kullanılan hedef proje dizini (GET /target-dir) */
  getTargetDir?: () => string;
  /** Hedef dizini değiştirir: doğrular, çalışan sürece uygular, config.json'a yazar */
  /** session verilirse yalnızca o oturumun dizini (resetResume: Analist'in konuşması bırakıldı), yoksa genel */
  setTargetDir?: (dir: string, session?: string) => { ok: boolean; error?: string; dir?: string; resetResume?: boolean };
  /** Seçili model + config'teki modelsUrl'den çekilen liste (GET /models).
   *  Liste alınamazsa error dolu döner ama seçili model yine gösterilir */
  getModels?: () => Promise<{
    current: string;
    required?: boolean;
    effort?: string;
    /** Bağlam göstergesi ayarları: özetleme eşiği (%), elle girilen pencere, yanıt payı */
    context?: { compactPercent: number; fallbackWindow: number | null; reserve: number | null };
    models: ModelInfo[];
    error?: string;
  }>;
  /** Genel modeli değiştirir: çalışan sürece uygular, config.json'a yazar ("" = varsayılan) */
  /** session verilirse yalnızca o oturumun modeli, yoksa genel varsayılan (config.json) değişir */
  setModel?: (model: string, session?: string) => { ok: boolean; error?: string; model?: string };
  /** Akıl yürütme derinliği: session verilirse yalnızca o oturum, yoksa genel varsayılan (config.json) */
  setEffort?: (effort: string, session?: string) => { ok: boolean; error?: string; effort?: string };
  /** Bağlantı dayanıklılığı ayarları (POST /resilience): config.json'a yazar, hemen geçerli.
   *  Alan null = sil (varsayılan); verilmeyen alan değişmez */
  setResilience?: (input: {
    retry?: Record<string, unknown>;
    limits?: Record<string, unknown>;
  }) => { ok: boolean; error?: string; retry?: RetryConfig; limits?: LimitsConfig };
  /** Eklentilerin son bilinen durumu (GET /mcp-status) — paneldeki durum ışıkları */
  getMcpStatus?: () => McpStatusView;
  /** Eklentileri şimdi yoklar (model çağrısı yok), bitince güncel durumu döner (POST /mcp-probe) */
  probeMcp?: () => Promise<McpStatusView>;
  /** Eklentinin araçları açıklama + parametreleriyle (GET /mcp-tools?name=) — eklentiye doğrudan sorulur */
  getMcpTools?: (name: string) => Promise<{ ok: boolean; tools?: McpToolInfo[]; error?: string }>;
  /** Akışın ana yolu + düğümlerin açık/kapalı durumu (GET /workflow) — görev kartı çipleri */
  getWorkflow?: () => {
    entry: string;
    /** Analist planı onay beklemeden Saha Timi'ne geçer mi (görev kartı bunu yazar) */
    autoForwardPlan: boolean;
    /** Uzak ajan adresi ayarlı mı — onay kartında "Uzak ajana gönder" düğmesi */
    planWebhook: boolean;
    nodes: Array<{ key: string; type: string; disabled: boolean; agent?: string }>;
  };
  /** Düğümü devre dışı bırakır/açar: çalışan sürece uygular, config.json'a yazar */
  setNodeDisabled?: (key: string, disabled: boolean) => { ok: boolean; error?: string };
  /** Planı otomatik iletmeyi açar/kapatır: çalışan sürece uygular, config.json'a yazar */
  setAutoForward?: (enabled: boolean, session?: string) => { ok: boolean; error?: string; enabled?: boolean };
  setUserPrompt?: (text: string) => { ok: boolean; error?: string; text?: string };
  /** Oturum arama (GET /search): session verilirse yalnızca o oturumda */
  search?: (q: string, session?: string, kind?: SearchKind) => unknown;
  /** Planın gönderileceği uzak ajan (planWebhook); ayarlı değilse undefined */
  getPlanTarget?: () => { url: string; apiKey?: string } | undefined;
  /** Uzak ajan adresini/anahtarını kaydeder (boş adres = kaldır): çalışan sürece uygular, config.json'a yazar */
  setPlanWebhook?: (url: string, apiKey: string) => { ok: boolean; error?: string };
  /** Aynı anda koşabilecek görev sınırını değiştirir: çalışan sürece uygular, config.json'a yazar */
  setMaxParallel?: (value: number) => { ok: boolean; error?: string; value?: number };
  /** Güvenlik denetçisini açar; config'te düğümü yoksa Teftiş onayından sonraya ekler */
  addSecurityAudit?: () => { ok: boolean; error?: string; key?: string; node?: unknown; attachedTo?: string };
  /** Aç/Kapat sayfası verisi (GET /toggles-data): ajanlar, beceriler, MCP sunucuları */
  getToggles?: () => unknown;
  /** Bir ajanı/beceriyi/MCP sunucusunu açar ya da kapatır: canlı + config.json */
  setToggle?: (kind: ToggleKind, name: string, disabled: boolean) => { ok: boolean; error?: string };
  /** Güvenlik denetimi raporları (GET /security-reports): en yeni önce özetler */
  listSecurityReports?: () => unknown[];
  /** Tek rapor (GET /security-reports/<id>); yoksa undefined */
  getSecurityReport?: (id: string) => unknown;
  /** Bağımsız denetimler (GET /security-audits): işler + dizin önerileri; CLI görevli modda yok */
  listAudits?: () => unknown;
  /** Seçilen dizinde kod tabanının tamamını denetler (POST /security-audits/start) */
  startAudit?: (dir: string) => { ok: boolean; error?: string; job?: unknown };
  /** Süren bağımsız denetimi durdurur (POST /security-audits/cancel) */
  cancelAudit?: (id: string) => boolean;
  /** TFS modu: ayarlar, iş öğesi önizleme/arama, eklerin önizlemesi, sonucu yazma */
  tfs?: TfsApi;
}

/**
 * İzleme paneli sunucusu — Node'un yerleşik http modülüyle, ek bağımlılıksız.
 *
 *   GET  /          panel sayfası (ui/index.html)
 *   GET  /theme.css paylaşılan Material 3 tema (ui/theme.css)
 *   GET  /theme.js  tema seçimi: kayıtlı temayı uygular, renk örneklerini kurar (ui/theme.js)
 *   GET  /version   { version } — çalışan Kurmay'ın sürümü (package.json); panelde marka yanında
 *   GET  /fonts/<ad>.woff2  gömülü yazı tipleri (ui/fonts) — çevrimdışı çalışır
 *   GET  /surumler  sürüm notları (tanitim/surumler.html — tanıtım sitesindekinin aynısı, pakete de girer)
 *   GET  /events?session=ID  SSE: o oturumun geçmişi (diskteki kayıtlar dahil) + canlı akışı
 *   GET  /lobby     SSE: oturum listesi + durumları, her değişiklikte tam liste
 *   POST /approval  { session, approved, comment?, runAt? } — o oturumun bekleyen onayını çözer
 *   POST /schedule  { session, action: "run" | "cancel" } — bekleyen zamanlamayı erken çalıştırır/iptal eder
 *   POST /cancel    { session } — o oturumun koşusunu durdurur
 *   POST /task      { task, session?, runAt? } — görev başlatır (session yoksa yeni oturum);
 *                   oturumlar birbirinden bağımsız, aynı anda koşabilir
 *   GET  /target-dir  { dir, exists } — hedef proje dizini ve diskte var mı (yoksa panel uyarır)
 *   POST /target-dir  { dir: string } — hedef dizini değiştirir ve config.json'a yazar
 *   GET  /browse?dir=  { dir, parent, roots[], home, dirs[] } — klasör seçici: alt klasör adları
 *   GET  /dirpicker.js klasör seçici penceresi (panel + ayar sayfası ortak)
 *   GET  /models      { current, effort, models[], error? } — modelsUrl'den çekilen model listesi
 *   POST /model       { model: string, session? } — oturumun ya da genel modeli değiştirir
 *   POST /effort      { effort: string, session? } — oturumun ya da genel akıl yürütme derinliği
 *   GET  /workflow      { entry, autoForwardPlan, nodes[] } — ana yol sırasıyla düğümler ve açık/kapalı durumları
 *   POST /node-disabled { key: string, disabled: boolean } — düğümü kapatır/açar (canlı + config.json)
 *   POST /auto-forward  { enabled: boolean, session? } — Analist planı onaysız Saha Timi'ne geçsin mi (session: yalnızca o oturum; yoksa genel, canlı + config.json)
 *   POST /user-prompt   { text: string } — kullanıcı talimatı, her ajanın prompt'una eklenir (canlı + config.json; boş = sil)
 *   POST /max-parallel  { value: number } — aynı anda koşabilecek görev sınırı, 1 veya daha büyük (canlı + config.json)
 *   GET  /search?q=&session=&kind=  oturumlarda arama (görev, plan, mesaj, dosya, komut, Teftiş, ret, hata, güvenlik);
 *                   session verilirse yalnızca o oturum. Sonuç oturum oturum, olay sırasıyla (panel o satıra atlar)
 *   GET  /plan-export?session=&format=md|json  oturumun son onay planını dosya olarak indirir (başka ajana vermek için)
 *   POST /plan-send     { session } — o planı planWebhook adresine JSON olarak POST eder; sonuç plan_sent olayıyla sohbete düşer
 *   POST /plan-webhook  { url, apiKey } — uzak ajan adresi/anahtarı (canlı + config.json; boş adres = kaldır)
 *   POST /security-audit  güvenlik denetçisini açar; akışta yoksa ekler → { ok, key, node, attachedTo? }
 *   GET  /security-audits         { jobs[], dirs[], defaultDir, model } — bağımsız denetimler (bellekte) + dizin önerileri
 *   POST /security-audits/start   { dir } — dizindeki kod tabanının tamamını denetler → { ok, job }
 *   POST /security-audits/cancel  { id } — süren bağımsız denetimi durdurur
 *   GET  /agent-md?file=  { raw, body, description } — rol tanımı dosyası (.claude/agents/*.md)
 *   POST /agent-md-save   { file, body, description } | { file, raw } — doğrulayıp kaydeder (canlı)
 *   GET  /guvenlik      Güvenlik denetimi raporları sayfası (ui/guvenlik.html)
 *   GET  /security-reports       [{ id, createdAt, task, risk, counts }] — en yeni önce
 *   GET  /guvenlik/rapor/<id>    raporun basılı şablonu (ui/guvenlik-rapor.html, veri gömülü; ?yazdir → yazdırma penceresi)
 *   GET  /security-reports/<id>/pdf  raporun PDF'i — bilgisayardaki Edge/Chrome başsız basar; yoksa 501 + yedek adres
 *   GET  /guvenlik/eposta/<id>       raporun e-posta hâli (tablo düzenli HTML — önizleme / kopyala-yapıştır)
 *   GET  /guvenlik/eposta/<id>/eml   gönderilmemiş e-posta taslağı (.eml, Outlook düzenlenebilir açar); tarayıcı varsa PDF ekli
 *   GET  /security-reports/<id>  tam rapor (bulgular, olumlu tespitler…)
 *   GET  /tfs           TFS modu ayarları (anahtarın kendisi yok: hasToken, tokenHint) — Ayarlar kartı ve panel
 *   POST /tfs           { enabled?, url?, project?, token? (null = sil), writeBack?, insecureTls?, caFile? } — kaydeder (canlı)
 *   POST /tfs/dene      { url?, project?, token?, … } — bağlantıyı dener: kimlik, sunucu sürümü, projeler
 *   GET  /tfs/is-ogesi?id=      iş öğesi önizlemesi (bölümler Markdown, ekler, yorumlar, bağlı öğeler)
 *   GET  /tfs/benimkiler?tumu=  bana atanan iş öğeleri (tumu=1: tamamlananlar dahil)
 *   GET  /tfs/ara?q=            başlıkta arama (projede)
 *   GET  /tfs/ek/<guid>?ad=     iş öğesi eki (önizlemede görsel) — anahtarla, yalnızca ayarlardaki sunucudan
 *   GET  /tfs/durumlar?session= yazma kartı: iş öğesinin güncel durumu + türünün durumları
 *   POST /tfs/yaz       { session, text, state? } — sonucu iş öğesine yazar (tfs_written olayı)
 *   POST /tfs/yazma     { session } — bu sonucu yazma (kart kapanır)
 *   GET  /tfs/pr?id=&dizin=     çekme isteği kartı: PR, açık yorum dizileri, değişen dosyalar, yerel deponun durumu
 *   GET  /tfs/pr-benim          açık PR'larım (açtıklarım + inceleyeni olduklarım)
 *   POST /tfs/pr-dal    { id, dizin? } — yerel depoyu PR'ın dalına geçirir (çalışma ağacı temizse)
 *   POST /tfs/pr-yaz    { session, push, message?, replies[], comments[], general? } — PR'a yazar (tfs_pr_written)
 *   POST /tfs/pr-yazma  { session } — PR'a yazma (kart kapanır)
 *   GET  /toggles       Aç/Kapat sayfası (ui/toggles.html)
 *   GET  /toggles-data  { entry, agents[], skills[], mcpServers[] } — açık/kapalı durumları
 *   POST /toggle        { kind: "agent"|"rule"|"skill"|"mcp", name, disabled } — açar/kapatır (canlı + config.json)
 */
export function startUiServer(port: number, options: UiServerOptions): Promise<UiServer> {
  const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
  const uiPath = path.join(uiDir, "index.html");
  const configUiPath = path.join(uiDir, "config.html");
  const togglesUiPath = path.join(uiDir, "toggles.html");
  const securityUiPath = path.join(uiDir, "guvenlik.html");
  const securityPrintPath = path.join(uiDir, "guvenlik-rapor.html");
  const themeCssPath = path.join(uiDir, "theme.css");
  const themeJsPath = path.join(uiDir, "theme.js");
  const dirPickerPath = path.join(uiDir, "dirpicker.js");
  const releaseNotesPath = path.join(uiDir, "..", "tanitim", "surumler.html");
  // Sürüm package.json'dan bir kez okunur (geliştirmede depo kökü, pakette paket kökü)
  let version = "";
  try {
    version = String(JSON.parse(fs.readFileSync(path.join(uiDir, "..", "package.json"), "utf8")).version ?? "");
  } catch {
    // okunamazsa panel sürümü göstermez
  }
  const sseClients = new Set<http.ServerResponse>();
  const json = (res: http.ServerResponse, code: number, payload: unknown) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };
  /** SSE yanıtını açar: hemen ilk bayt + 25 sn kalp atışı; kapanınca temizlik */
  const openSse = (req: http.IncomingMessage, res: http.ServerResponse, onClose: () => void) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": bagli\n\n");
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
    sseClients.add(res);
    req.on("close", () => {
      clearInterval(heartbeat);
      onClose();
      sseClients.delete(res);
    });
  };
  /** Gövdeyi JSON nesnesi olarak okur; bozuksa null */
  const readJson = (req: http.IncomingMessage, cb: (body: Record<string, unknown> | null) => void) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const v = JSON.parse(body) as unknown;
        cb(v && typeof v === "object" ? (v as Record<string, unknown>) : null);
      } catch {
        cb(null);
      }
    });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(uiPath));
      return;
    }

    if (req.method === "GET" && req.url === "/theme.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(fs.readFileSync(themeCssPath));
      return;
    }

    if (req.method === "GET" && req.url === "/version") {
      return json(res, 200, { version });
    }

    // Tema seçimi (panel + Ayarlar + Aç/Kapat ortak): kayıtlı temayı sayfa çizilmeden uygular
    if (req.method === "GET" && req.url === "/theme.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(fs.readFileSync(themeJsPath));
      return;
    }

    // Gömülü yazı tipleri (ui/fonts): çevrimdışı ortamda dış kaynağa gidilmez
    if (req.method === "GET" && url.pathname.startsWith("/fonts/")) {
      const name = url.pathname.slice("/fonts/".length);
      const file = /^[\w-]+\.woff2$/.test(name) ? path.join(uiDir, "fonts", name) : "";
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "font/woff2", "cache-control": "public, max-age=86400" });
      res.end(fs.readFileSync(file));
      return;
    }

    // Sürüm notları: tek kaynak tanıtım sitesindeki sayfa. Yazı tipleri sitede yanındaki
    // klasörden, burada panelin /fonts/ ucundan (aynı dosyalar); sayfa panelde açıldığını ve
    // kurulu sürümü gömülen veriden öğrenir (bağlantılarını panele çevirir)
    if (req.method === "GET" && (url.pathname === "/surumler" || url.pathname === "/surumler.html")) {
      let html: string;
      try {
        html = fs.readFileSync(releaseNotesPath, "utf8");
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return res.end("sürüm notları bulunamadı");
      }
      const veri = JSON.stringify({ surum: version }).replace(/</g, "\\u003c");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html.replace(/url\(yazi-tipleri\//g, "url(/fonts/").replace("/*PANEL*/null", () => veri));
      return;
    }

    // Görev ekleri — panel görev balonunda görseli küçük resim, diğerlerini indirme bağlantısı olarak gösterir
    if (req.method === "GET" && url.pathname.startsWith("/ekler/")) {
      const [sessionId = "", name = ""] = url.pathname.slice("/ekler/".length).split("/");
      const found = options.runsDir ? resolveAttachment(options.runsDir, sessionId, name) : undefined;
      if (!found) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": found.type,
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
        ...(found.inline ? {} : { "content-disposition": `attachment; filename="${name}"` }),
      });
      res.end(fs.readFileSync(found.file));
      return;
    }

    if (req.method === "GET" && req.url === "/dirpicker.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(fs.readFileSync(dirPickerPath));
      return;
    }

    if (req.method === "GET" && url.pathname === "/browse") {
      return json(res, 200, browseDir(url.searchParams.get("dir") ?? "", options.getTargetDir?.() ?? ""));
    }

    // Oturumun olay akışı: önce geçmiş (servis yeniden başladıysa diskten), sonra canlı
    if (req.method === "GET" && url.pathname === "/events") {
      const rt = options.openSession(url.searchParams.get("session") ?? "");
      if (!rt) {
        res.writeHead(404);
        res.end();
        return;
      }
      let unsubscribe = () => {};
      openSse(req, res, () => unsubscribe());
      // Panel büyük oturumda yükleme ilerlemesini gösterebilsin diye önce olay sayısı
      res.write(`event: history\ndata: ${JSON.stringify({ count: rt.bus.history.length })}\n\n`);
      for (const e of rt.bus.history) res.write(`data: ${JSON.stringify(e)}\n\n`);
      // Geçmiş bitti: panel yeniden oynatmayı burada kapatır, oturumun anlık durumunu uygular
      res.write(`event: ready\ndata: ${JSON.stringify({ status: rt.status, busy: rt.busy })}\n\n`);
      unsubscribe = rt.bus.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      return;
    }

    // Lobi: oturum listesi + durumları; her değişiklikte tam liste (küçük, sade)
    if (req.method === "GET" && url.pathname === "/lobby") {
      const send = () => res.write(`data: ${JSON.stringify(options.getSessions())}\n\n`);
      let off = () => {};
      openSse(req, res, () => off());
      send();
      off = options.runtimes.onLobby(send);
      return;
    }

    if (req.method === "POST" && req.url === "/approval") {
      readJson(req, (parsed) => {
        if (!parsed) return json(res, 400, { ok: false, error: "geçersiz istek" });
        const rt = options.runtimes.peek(String(parsed.session ?? ""));
        const comment =
          typeof parsed.comment === "string" && parsed.comment.trim() ? parsed.comment.trim() : undefined;
        // runAt panelden ISO metin (datetime-local) ya da epoch ms gelebilir
        let runAt: number | undefined;
        if (typeof parsed.runAt === "number" && Number.isFinite(parsed.runAt)) runAt = parsed.runAt;
        else if (typeof parsed.runAt === "string") runAt = parseRunAt(parsed.runAt);
        if (!rt?.resolveApproval({ approved: Boolean(parsed.approved), comment, runAt })) {
          return json(res, 409, { ok: false, error: "bu oturumda bekleyen onay yok" });
        }
        json(res, 200, { ok: true });
      });
      return;
    }

    if (req.method === "POST" && req.url === "/schedule") {
      readJson(req, (parsed) => {
        if (!parsed) return json(res, 400, { ok: false, error: "geçersiz istek" });
        if (parsed.action !== "run" && parsed.action !== "cancel") {
          return json(res, 400, { ok: false, error: "işlem 'şimdi çalıştır' ya da 'iptal' olmalı" });
        }
        const rt = options.runtimes.peek(String(parsed.session ?? ""));
        if (!rt?.resolveSchedule(parsed.action === "run" ? "run_now" : "cancelled")) {
          return json(res, 409, { ok: false, error: "bu oturumda bekleyen zamanlama yok" });
        }
        json(res, 200, { ok: true });
      });
      return;
    }

    if (req.method === "GET" && req.url === "/config") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(configUiPath));
      return;
    }

    if (req.method === "GET" && req.url === "/config-data") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(options.getConfigData?.() ?? { raw: "{}", rules: [], skills: [], agents: [] }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/agent-md") {
      const r = options.getAgentMd?.(url.searchParams.get("file") ?? "") ?? { ok: false, error: "kapalı" };
      return json(res, r.ok ? 200 : 400, r);
    }

    if (req.method === "POST" && req.url === "/agent-md-save") {
      readJson(req, (parsed) => {
        const file = typeof parsed?.file === "string" ? parsed.file : "";
        if (!parsed || !file) return json(res, 400, { ok: false, error: "geçersiz istek" });
        const str = (v: unknown) => (typeof v === "string" ? v : undefined);
        const r = options.saveAgentMd
          ? options.saveAgentMd(file, { body: str(parsed.body), description: str(parsed.description), raw: str(parsed.raw) })
          : { ok: false, error: "kapalı" };
        json(res, r.ok ? 200 : 400, r);
      });
      return;
    }

    if (req.method === "POST" && req.url === "/agent-md") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let name = "";
        try {
          name = String((JSON.parse(body) as { name?: unknown }).name ?? "");
        } catch {
          /* boş ad → hata döner */
        }
        const r = options.createAgentMd ? options.createAgentMd(name) : { ok: false, error: "kapalı" };
        res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      });
      return;
    }

    if (req.method === "POST" && req.url === "/config") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const err = options.saveConfig ? options.saveConfig(body) : "kaydetme kapalı";
        if (err) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err }));
        } else {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
        }
      });
      return;
    }

    if (req.method === "GET" && req.url === "/target-dir") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      // exists her istekte bakılır: dizin sonradan oluşturulursa uyarı kendiliğinden kalkar
      const dir = options.getTargetDir?.() ?? "";
      let exists = false;
      try {
        exists = !!dir && fs.statSync(dir).isDirectory();
      } catch {
        /* yok */
      }
      res.end(JSON.stringify({ dir, exists }));
      return;
    }

    if (req.method === "POST" && req.url === "/target-dir") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let dir: string;
        let session: string | undefined;
        try {
          const parsed = JSON.parse(body) as { dir?: unknown; session?: unknown };
          dir = String(parsed.dir ?? "").trim();
          if (typeof parsed.session === "string" && parsed.session) session = parsed.session;
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "geçersiz istek" }));
          return;
        }
        if (!dir) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "dizin boş olamaz" }));
          return;
        }
        const r = options.setTargetDir ? options.setTargetDir(dir, session) : { ok: false, error: "kapalı" };
        res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      });
      return;
    }

    if (req.method === "GET" && req.url === "/models") {
      const json = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
      };
      if (!options.getModels) {
        json({ current: "", models: [], error: "kapalı" });
        return;
      }
      options.getModels().then(json, (e: unknown) =>
        json({ current: "", models: [], error: e instanceof Error ? e.message : String(e) }),
      );
      return;
    }

    if (req.method === "POST" && req.url === "/model") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let model: string;
        let session: string | undefined;
        try {
          const parsed = JSON.parse(body) as { model?: unknown; session?: unknown };
          model = String(parsed.model ?? "").trim();
          if (typeof parsed.session === "string" && parsed.session) session = parsed.session;
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "geçersiz istek" }));
          return;
        }
        const r = options.setModel ? options.setModel(model, session) : { ok: false, error: "kapalı" };
        res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      });
      return;
    }

    if (req.method === "POST" && req.url === "/effort") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let effort: string;
        let session: string | undefined;
        try {
          const parsed = JSON.parse(body) as { effort?: unknown; session?: unknown };
          effort = String(parsed.effort ?? "").trim();
          if (typeof parsed.session === "string" && parsed.session) session = parsed.session;
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "geçersiz istek" }));
          return;
        }
        const r = options.setEffort ? options.setEffort(effort, session) : { ok: false, error: "kapalı" };
        res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      });
      return;
    }

    if (req.method === "POST" && req.url === "/resilience") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let input: { retry?: Record<string, unknown>; limits?: Record<string, unknown> };
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          const obj = (v: unknown) =>
            v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
          input = { retry: obj(parsed.retry), limits: obj(parsed.limits) };
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "geçersiz istek" }));
          return;
        }
        const r = options.setResilience ? options.setResilience(input) : { ok: false, error: "kapalı" };
        res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      });
      return;
    }

    if (req.method === "GET" && req.url === "/workflow") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(options.getWorkflow?.() ?? { entry: "", nodes: [] }));
      return;
    }

    if (req.method === "POST" && req.url === "/node-disabled") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let key: string;
        let disabled: boolean;
        try {
          const parsed = JSON.parse(body) as { key?: unknown; disabled?: unknown };
          key = String(parsed.key ?? "");
          disabled = parsed.disabled === true;
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "geçersiz istek" }));
          return;
        }
        const r = options.setNodeDisabled ? options.setNodeDisabled(key, disabled) : { ok: false, error: "kapalı" };
        res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      });
      return;
    }

    if (req.method === "POST" && req.url === "/auto-forward") {
      readJson(req, (parsed) => {
        if (!parsed || typeof parsed.enabled !== "boolean") return json(res, 400, { ok: false, error: "geçersiz istek" });
        const session = typeof parsed.session === "string" && parsed.session ? parsed.session : undefined;
        const r = options.setAutoForward ? options.setAutoForward(parsed.enabled, session) : { ok: false, error: "kapalı" };
        json(res, r.ok ? 200 : 400, r);
      });
      return;
    }

    if (req.method === "POST" && req.url === "/max-parallel") {
      readJson(req, (parsed) => {
        const value = parsed?.value;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
          return json(res, 400, { ok: false, error: "aynı anda çalışacak görev sayısı 1 veya daha büyük bir tam sayı olmalı" });
        }
        const r = options.setMaxParallel ? options.setMaxParallel(value) : { ok: false, error: "kapalı" };
        json(res, r.ok ? 200 : 400, r);
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (q.length < 2) return json(res, 400, { ok: false, error: "en az 2 karakter yaz" });
      if (q.length > 200) return json(res, 400, { ok: false, error: "arama metni çok uzun (en fazla 200 karakter)" });
      const k = url.searchParams.get("kind") ?? "";
      const kind = (SEARCH_KINDS as readonly string[]).includes(k) ? (k as SearchKind) : undefined;
      const session = url.searchParams.get("session") || undefined;
      if (!options.search) return json(res, 409, { ok: false, error: "arama kapalı" });
      const t0 = Date.now();
      const r = options.search(q, session, kind) as Record<string, unknown>;
      return json(res, 200, { ok: true, ...r, ms: Date.now() - t0 });
    }

    // Onay planını dışarı ver: indirme (başka ajana elle) ya da uzak ajana REST isteği
    if (req.method === "GET" && url.pathname === "/plan-export") {
      const id = url.searchParams.get("session") ?? "";
      const format = url.searchParams.get("format") === "json" ? "json" : "md";
      const plan = id ? findPlan(options.openSession(id)?.bus.history ?? []) : undefined;
      if (!plan) return json(res, 404, { ok: false, error: "bu oturumda onaya gelmiş bir plan yok" });
      const body = format === "json"
        ? JSON.stringify(planPayload(plan, { session: id, version }), null, 2)
        : planMarkdown(plan);
      res.writeHead(200, {
        "content-type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        "content-disposition": attachmentHeader(planFileName(plan, format)),
        "x-content-type-options": "nosniff",
      });
      res.end(body);
      return;
    }

    if (req.method === "POST" && req.url === "/plan-send") {
      readJson(req, async (parsed) => {
        const id = String(parsed?.session ?? "");
        const rt = id ? options.openSession(id) : undefined;
        const plan = rt ? findPlan(rt.bus.history) : undefined;
        if (!rt || !plan) return json(res, 404, { ok: false, error: "bu oturumda onaya gelmiş bir plan yok" });
        const target = options.getPlanTarget?.();
        if (!target) return json(res, 409, { ok: false, error: "uzak ajan adresi ayarlı değil (Ayarlar → Planı uzak ajana gönder)" });
        let host = target.url;
        try {
          host = new URL(target.url).host;
        } catch {
          /* adres doğrulanmıştı; olmazsa ham haliyle yazılır */
        }
        const r = await sendPlan(target, planPayload(plan, { session: id, version }));
        rt.bus.emit({
          type: "plan_sent", agent: plan.agent, ok: r.ok, host,
          ...(r.status ? { status: r.status } : {}), ...(r.error ? { error: r.error } : {}),
        });
        json(res, r.ok ? 200 : 502, { ...r, host });
      });
      return;
    }

    if (req.method === "POST" && req.url === "/plan-webhook") {
      readJson(req, (parsed) => {
        if (!parsed || typeof parsed.url !== "string" || (parsed.apiKey !== undefined && typeof parsed.apiKey !== "string")) {
          return json(res, 400, { ok: false, error: "geçersiz istek" });
        }
        const r = options.setPlanWebhook ? options.setPlanWebhook(parsed.url, parsed.apiKey ?? "") : { ok: false, error: "kapalı" };
        json(res, r.ok ? 200 : 400, r);
      });
      return;
    }

    if (req.method === "POST" && req.url === "/user-prompt") {
      readJson(req, (parsed) => {
        if (!parsed || typeof parsed.text !== "string") return json(res, 400, { ok: false, error: "geçersiz istek" });
        if (parsed.text.length > USER_PROMPT_MAX) {
          return json(res, 400, { ok: false, error: `talimat çok uzun (en fazla ${USER_PROMPT_MAX} karakter)` });
        }
        const r = options.setUserPrompt ? options.setUserPrompt(parsed.text) : { ok: false, error: "kapalı" };
        json(res, r.ok ? 200 : 400, r);
      });
      return;
    }

    if (req.method === "GET" && req.url === "/security-audits") {
      if (!options.listAudits) return json(res, 409, { ok: false, error: "bağımsız denetim yalnızca sunucu modunda (görev argümanı olmadan) başlatılabilir" });
      return json(res, 200, options.listAudits());
    }

    if (req.method === "POST" && req.url === "/security-audits/start") {
      readJson(req, (parsed) => {
        if (!options.startAudit) {
          return json(res, 409, { ok: false, error: "bağımsız denetim yalnızca sunucu modunda (görev argümanı olmadan) başlatılabilir" });
        }
        const dir = typeof parsed?.dir === "string" ? parsed.dir.trim() : "";
        if (!dir) return json(res, 400, { ok: false, error: "proje dizini seçilmedi" });
        const r = options.startAudit(dir);
        json(res, r.ok ? 202 : 409, r);
      });
      return;
    }

    if (req.method === "POST" && req.url === "/security-audits/cancel") {
      readJson(req, (parsed) => {
        const ok = typeof parsed?.id === "string" && !!options.cancelAudit?.(parsed.id);
        json(res, ok ? 200 : 409, ok ? { ok } : { ok, error: "durdurulacak denetim yok" });
      });
      return;
    }

    if (req.method === "POST" && req.url === "/security-audit") {
      req.resume();
      req.on("end", () => {
        const r = options.addSecurityAudit ? options.addSecurityAudit() : { ok: false, error: "kapalı" };
        json(res, r.ok ? 200 : 400, r);
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/guvenlik") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(securityUiPath));
      return;
    }

    // Raporun basılı şablonu: veri sayfaya gömülür, betik yükleme sırasında çizer (başsız
    // tarayıcı beklemeden basabilsin). "<" kaçışlanır — rapor metni betiği kapatamasın
    if (req.method === "GET" && url.pathname.startsWith("/guvenlik/rapor/")) {
      const id = decodeURIComponent(url.pathname.slice("/guvenlik/rapor/".length));
      const rapor = options.getSecurityReport?.(id);
      const veri = JSON.stringify(rapor ? { rapor, surum: version } : null).replace(/</g, "\\u003c");
      res.writeHead(rapor ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(securityPrintPath, "utf8").replace("/*RAPOR*/null", () => veri));
      return;
    }

    // Raporun e-posta hâli. Alıcı Kurmay'a erişebiliyorsa "Raporu aç" düğmesi konur: panel
    // localhost'tan açıldıysa adres başkasında çalışmaz, düğme konmaz (PDF eki raporu taşır)
    const mailLink = (id: string) => {
      const host = String(req.headers.host ?? "");
      return !host || /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(host)
        ? undefined
        : `http://${host}/guvenlik#${encodeURIComponent(id)}`;
    };
    const mailMatch = url.pathname.match(/^\/guvenlik\/eposta\/([\w-]+)(\/eml)?$/);
    if (req.method === "GET" && mailMatch) {
      const [, id, eml] = mailMatch;
      const rapor = options.getSecurityReport?.(id) as SecurityReport | undefined;
      if (!rapor) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return res.end("rapor bulunamadı");
      }
      if (!eml) {
        const mail = renderReportEmail(rapor, { link: mailLink(id), version });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-kurmay-konu": encodeURIComponent(mail.subject) });
        return res.end(mail.html);
      }
      // Taslak: PDF'i basabilirsek ekle; basamazsak ekisiz taslak (raporun özeti yine gövdede)
      const send = (pdf?: Buffer) => {
        const mail = renderReportEmail(rapor, { link: mailLink(id), version, pdfAttached: !!pdf });
        const out = buildEml(mail, pdf ? { name: pdfFileName(rapor), data: pdf } : undefined);
        res.writeHead(200, {
          "content-type": "message/rfc822",
          "content-length": out.length,
          "content-disposition": attachmentHeader(pdfFileName(rapor).replace(/\.pdf$/, ".eml")),
          "x-kurmay-pdf": pdf ? "eklendi" : "yok",
        });
        res.end(out);
      };
      const browser = findBrowser();
      if (!browser) return send();
      printPdf(browser, `http://127.0.0.1:${port}/guvenlik/rapor/${encodeURIComponent(id)}`).then(send, () => send());
      return;
    }

    // Raporun PDF'i: bilgisayardaki Chromium tabanlı tarayıcı şablonu başsız basar
    if (req.method === "GET" && /^\/security-reports\/[\w-]+\/pdf$/.test(url.pathname)) {
      const id = url.pathname.split("/")[2];
      const rapor = options.getSecurityReport?.(id) as { targetDir?: string; createdAt?: string } | undefined;
      if (!rapor) return json(res, 404, { ok: false, error: "rapor bulunamadı" });
      const fallback = `/guvenlik/rapor/${encodeURIComponent(id)}?yazdir=1`;
      const browser = findBrowser();
      if (!browser) {
        return json(res, 501, {
          ok: false,
          error: `PDF basacak tarayıcı (Edge, Chrome) bulunamadı — yolunu ${BROWSER_ENV} ortam değişkeniyle verebilirsin`,
          fallback,
        });
      }
      printPdf(browser, `http://127.0.0.1:${port}/guvenlik/rapor/${encodeURIComponent(id)}`).then(
        (pdf) => {
          res.writeHead(200, {
            "content-type": "application/pdf",
            "content-length": pdf.length,
            "content-disposition": attachmentHeader(pdfFileName(rapor)),
          });
          res.end(pdf);
        },
        (e: unknown) => json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e), fallback }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/security-reports") {
      return json(res, 200, options.listSecurityReports?.() ?? []);
    }

    if (req.method === "GET" && url.pathname.startsWith("/security-reports/")) {
      const r = options.getSecurityReport?.(decodeURIComponent(url.pathname.slice("/security-reports/".length)));
      return r ? json(res, 200, r) : json(res, 404, { ok: false, error: "rapor bulunamadı" });
    }

    if (req.method === "GET" && req.url === "/toggles") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(togglesUiPath));
      return;
    }

    if (req.method === "GET" && req.url === "/mcp-status") {
      return json(res, 200, options.getMcpStatus?.() ?? { servers: [], probing: false });
    }

    if (req.method === "GET" && url.pathname === "/mcp-tools") {
      if (!options.getMcpTools) return json(res, 200, { ok: false, error: "kapalı" });
      options.getMcpTools(url.searchParams.get("name") ?? "").then(
        (r) => json(res, r.ok ? 200 : 400, r),
        (e: unknown) => json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
      return;
    }

    if (req.method === "POST" && req.url === "/mcp-probe") {
      if (!options.probeMcp) return json(res, 200, { servers: [], probing: false });
      options.probeMcp().then(
        (r) => json(res, 200, r),
        (e: unknown) => json(res, 500, { servers: [], probing: false, error: e instanceof Error ? e.message : String(e) }),
      );
      return;
    }

    if (req.method === "GET" && req.url === "/toggles-data") {
      return json(res, 200, options.getToggles?.() ?? { entry: "", agents: [], skills: [], mcpServers: [] });
    }

    if (req.method === "POST" && req.url === "/toggle") {
      readJson(req, (parsed) => {
        const kind = parsed?.kind;
        if (kind !== "agent" && kind !== "rule" && kind !== "skill" && kind !== "mcp") {
          return json(res, 400, { ok: false, error: "geçersiz istek" });
        }
        const name = String(parsed?.name ?? "");
        if (!name) return json(res, 400, { ok: false, error: "ad boş olamaz" });
        const r = options.setToggle ? options.setToggle(kind, name, parsed?.disabled === true) : { ok: false, error: "kapalı" };
        json(res, r.ok ? 200 : 400, r);
      });
      return;
    }

    if (req.method === "GET" && req.url === "/sessions") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(options.getSessions()));
      return;
    }

    if (req.method === "POST" && req.url === "/session-delete") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let id = "";
        try {
          id = String((JSON.parse(body) as { id?: unknown }).id ?? "");
        } catch {
          /* boş id → false */
        }
        const ok = id && options.deleteSession ? options.deleteSession(id) : false;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok }));
      });
      return;
    }

    if (req.method === "POST" && req.url === "/cancel") {
      readJson(req, (parsed) => {
        const rt = options.runtimes.peek(String(parsed?.session ?? ""));
        if (!rt?.cancel()) return json(res, 409, { ok: false, error: "bu oturumda çalışan görev yok" });
        json(res, 200, { ok: true });
      });
      return;
    }

    if (req.method === "POST" && req.url === "/task") {
      readJson(req, (parsed) => {
        if (!options.onTask) {
          return json(res, 409, {
            ok: false,
            error: "bu koşu görevini CLI'dan aldı; panelden görev vermek için sunucu modunda başlat (görev argümanı olmadan)",
          });
        }
        if (!parsed) return json(res, 400, { ok: false, error: "geçersiz istek" });
        const task = typeof parsed.task === "string" ? parsed.task.trim() : "";
        // TFS: iş öğesi numarası (ya da "#123", iş öğesi adresi) — görev ondan kurulur, metin ek talimattır
        let workItem: number | undefined;
        if (parsed.workItem !== undefined && parsed.workItem !== null && parsed.workItem !== "") {
          workItem = typeof parsed.workItem === "number" ? parsed.workItem : parseWorkItemRef(String(parsed.workItem));
          if (!workItem || !Number.isInteger(workItem) || workItem < 1) return json(res, 400, { ok: false, error: "iş öğesi numarası anlaşılamadı" });
        }
        // TFS: çekme isteği numarası ("!45", PR adresi) + kip
        let pr: number | undefined;
        if (parsed.pr !== undefined && parsed.pr !== null && parsed.pr !== "") {
          pr = typeof parsed.pr === "number" ? parsed.pr : parsePrRef(String(parsed.pr)) ?? (/^\d+$/.test(String(parsed.pr).trim()) ? Number(parsed.pr) : undefined);
          if (!pr || !Number.isInteger(pr) || pr < 1) return json(res, 400, { ok: false, error: "çekme isteği numarası anlaşılamadı" });
        }
        const prMode = parsed.prMode === "incele" ? "incele" : "yorum";
        if (workItem !== undefined && pr !== undefined) return json(res, 400, { ok: false, error: "aynı görevde hem iş öğesi hem çekme isteği seçilemez" });
        if (!task && workItem === undefined && pr === undefined) return json(res, 400, { ok: false, error: "görev boş olamaz" });
        const session = typeof parsed.session === "string" && parsed.session ? parsed.session : undefined;
        // runAt: ileri bir başlangıç zamanı (epoch ms ya da "+30m"/"2026-07-10 14:00" metni)
        let runAt: number | undefined;
        if (typeof parsed.runAt === "number" && Number.isFinite(parsed.runAt)) runAt = parsed.runAt;
        else if (typeof parsed.runAt === "string" && parsed.runAt.trim()) {
          runAt = parseRunAt(parsed.runAt);
          if (runAt === undefined) {
            return json(res, 400, { ok: false, error: `başlangıç zamanı anlaşılamadı: ${parsed.runAt}` });
          }
        }
        const { files, error: fileError } = parseFiles(parsed.files);
        if (fileError) return json(res, 400, { ok: false, error: fileError });
        const targetDir = typeof parsed.targetDir === "string" && parsed.targetDir.trim() ? parsed.targetDir.trim() : undefined;
        Promise.resolve(options.onTask(task, session, runAt, files, targetDir, workItem, pr, prMode)).then(
          (result) => json(res, result.ok ? 202 : 409, result),
          (e: unknown) => json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
      });
      return;
    }

    // ── TFS modu ──
    if (url.pathname === "/tfs" || url.pathname.startsWith("/tfs/")) {
      const tfs = options.tfs;
      if (!tfs) return json(res, 409, { ok: false, error: "TFS modu kapalı" });
      /** Hata: TFS'in kendi hatası (yetki, bulunamadı…) 4xx, beklenmeyen 500 */
      const fail = (e: unknown) => {
        const status = (e as { status?: number }).status;
        const code = e instanceof Error && e.name === "TfsError" ? (status === 404 ? 404 : status === 401 || status === 403 ? 403 : 502) : 500;
        json(res, code, { ok: false, error: e instanceof Error ? e.message : String(e) });
      };
      const p = url.pathname;
      if (req.method === "GET" && p === "/tfs") return json(res, 200, tfs.view());
      if (req.method === "POST" && p === "/tfs") {
        readJson(req, (b) => {
          if (!b) return json(res, 400, { ok: false, error: "geçersiz istek" });
          tfs.save(b).then((r) => json(res, r.ok ? 200 : 400, r), fail);
        });
        return;
      }
      if (req.method === "POST" && p === "/tfs/dene") {
        readJson(req, (b) => tfs.probe(b ?? {}).then((r) => json(res, r.ok ? 200 : 400, r), fail));
        return;
      }
      if (req.method === "GET" && p === "/tfs/is-ogesi") {
        const id = parseWorkItemRef(url.searchParams.get("id") ?? "");
        if (!id) return json(res, 400, { ok: false, error: "iş öğesi numarası anlaşılamadı" });
        tfs.preview(id).then((item) => json(res, 200, { ok: true, item }), fail);
        return;
      }
      if (req.method === "GET" && p === "/tfs/benimkiler") {
        tfs.mine(url.searchParams.get("tumu") === "1").then((items) => json(res, 200, { ok: true, items }), fail);
        return;
      }
      if (req.method === "GET" && p === "/tfs/ara") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (q.length < 2) return json(res, 400, { ok: false, error: "en az 2 karakter yaz" });
        tfs.search(q).then((items) => json(res, 200, { ok: true, items }), fail);
        return;
      }
      const ek = /^\/tfs\/ek\/([0-9a-fA-F-]{36})$/.exec(p);
      if (req.method === "GET" && ek) {
        const name = (url.searchParams.get("ad") ?? "ek").replace(/[\\/\r\n"]/g, "_").slice(0, 200);
        tfs.attachment(ek[1], name).then(({ data, type }) => {
          const image = type.startsWith("image/") && type !== "image/svg+xml";
          res.writeHead(200, {
            "content-type": image ? type : "application/octet-stream",
            "cache-control": "private, max-age=3600",
            "x-content-type-options": "nosniff",
            ...(image ? {} : { "content-disposition": attachmentHeader(name) }),
          });
          res.end(data);
        }, fail);
        return;
      }
      if (req.method === "GET" && p === "/tfs/durumlar") {
        tfs.states(url.searchParams.get("session") ?? "").then((r) => json(res, 200, { ok: true, ...(r as object) }), fail);
        return;
      }
      if (req.method === "POST" && p === "/tfs/yaz") {
        readJson(req, (b) => {
          const session = typeof b?.session === "string" ? b.session : "";
          const text = typeof b?.text === "string" ? b.text : "";
          const state = typeof b?.state === "string" && b.state.trim() ? b.state.trim() : undefined;
          const prb = b?.pr && typeof b.pr === "object" ? (b.pr as Record<string, unknown>) : undefined;
          const prOpts = prb?.open === true ? { open: true, ...(typeof prb.target === "string" ? { target: prb.target } : {}), draft: prb.draft === true } : undefined;
          if (!session) return json(res, 400, { ok: false, error: "oturum belirtilmedi" });
          if (text.length > 20_000) return json(res, 400, { ok: false, error: "not çok uzun (en fazla 20 000 karakter)" });
          tfs.write(session, text, state, prOpts).then((r) => json(res, r.ok ? 200 : 400, r), fail);
        });
        return;
      }
      if (req.method === "GET" && p === "/tfs/pr") {
        const raw = url.searchParams.get("id") ?? "";
        const id = parsePrRef(raw) ?? (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined);
        if (!id) return json(res, 400, { ok: false, error: "çekme isteği numarası anlaşılamadı" });
        tfs.prPreview(id, url.searchParams.get("dizin") || undefined).then((pr) => json(res, 200, { ok: true, pr }), fail);
        return;
      }
      if (req.method === "GET" && p === "/tfs/pr-benim") {
        tfs.prMine().then((items) => json(res, 200, { ok: true, items }), fail);
        return;
      }
      if (req.method === "POST" && p === "/tfs/pr-dal") {
        readJson(req, (b) => {
          const id = typeof b?.id === "number" ? b.id : Number(b?.id);
          if (!Number.isInteger(id) || id < 1) return json(res, 400, { ok: false, error: "çekme isteği numarası anlaşılamadı" });
          tfs.prCheckout(id, typeof b?.dizin === "string" ? b.dizin : undefined).then((r) => json(res, 200, { ok: true, ...(r as object) }), fail);
        });
        return;
      }
      if (req.method === "POST" && p === "/tfs/pr-yaz") {
        readJson(req, (b) => {
          const session = typeof b?.session === "string" ? b.session : "";
          if (!session) return json(res, 400, { ok: false, error: "oturum belirtilmedi" });
          const arr = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
          const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
          const input = {
            push: b?.push === true,
            message: str(b?.message, 4000),
            replies: arr(b?.replies)
              .filter((r) => typeof r.threadId === "number")
              .map((r) => ({ threadId: r.threadId as number, firstCommentId: typeof r.firstCommentId === "number" ? r.firstCommentId : 1, text: str(r.text, 20_000), resolve: r.resolve === true, send: r.send !== false })),
            comments: arr(b?.comments).map((c) => ({
              ...(typeof c.file === "string" && c.file ? { file: c.file } : {}),
              ...(typeof c.line === "number" && c.line > 0 ? { line: c.line } : {}),
              text: str(c.text, 20_000),
              send: c.send !== false,
            })),
            general: str(b?.general, 20_000),
          };
          tfs.prWrite(session, input).then((r) => json(res, r.ok ? 200 : 400, r), fail);
        });
        return;
      }
      if (req.method === "POST" && p === "/tfs/pr-yazma") {
        readJson(req, (b) => {
          const r = tfs.prDismiss(typeof b?.session === "string" ? b.session : "");
          json(res, r.ok ? 200 : 400, r);
        });
        return;
      }
      if (req.method === "POST" && p === "/tfs/yazma") {
        readJson(req, (b) => {
          const r = tfs.dismiss(typeof b?.session === "string" ? b.session : "");
          json(res, r.ok ? 200 : 400, r);
        });
        return;
      }
      return json(res, 404, { ok: false, error: "bilinmeyen TFS ucu" });
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      resolve({
        url: `http://localhost:${port}`,
        close: () => {
          for (const client of sseClients) client.end();
          server.close();
        },
      });
    });
  });
}
