import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunAt } from "./approval.js";
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

export interface UiServerOptions {
  /** Oturum çalışma zamanları — olay akışı, onay/zamanlama/iptal oturum başına */
  runtimes: RuntimeRegistry;
  /** Panelden görev (POST /task). session verilirse o oturumda devam (analist
   *  konuşması sürdürülür), yoksa yeni oturum açılır. Kabul edilirse oturum id'si döner. */
  onTask?: (
    task: string,
    session?: string,
    runAt?: number,
  ) => { ok: boolean; error?: string; session?: string; warning?: string };
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
    nodes: Array<{ key: string; type: string; disabled: boolean; agent?: string }>;
  };
  /** Düğümü devre dışı bırakır/açar: çalışan sürece uygular, config.json'a yazar */
  setNodeDisabled?: (key: string, disabled: boolean) => { ok: boolean; error?: string };
  /** Planı otomatik iletmeyi açar/kapatır: çalışan sürece uygular, config.json'a yazar */
  setAutoForward?: (enabled: boolean) => { ok: boolean; error?: string; enabled?: boolean };
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
}

/**
 * İzleme paneli sunucusu — Node'un yerleşik http modülüyle, ek bağımlılıksız.
 *
 *   GET  /          panel sayfası (ui/index.html)
 *   GET  /theme.css paylaşılan Material 3 tema (ui/theme.css)
 *   GET  /theme.js  tema seçimi: kayıtlı temayı uygular, renk örneklerini kurar (ui/theme.js)
 *   GET  /fonts/<ad>.woff2  gömülü yazı tipleri (ui/fonts) — çevrimdışı çalışır
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
 *   POST /auto-forward  { enabled: boolean } — Analist planı onaysız Saha Timi'ne geçsin mi (canlı + config.json)
 *   POST /security-audit  güvenlik denetçisini açar; akışta yoksa ekler → { ok, key, node, attachedTo? }
 *   GET  /agent-md?file=  { raw, body, description } — rol tanımı dosyası (.claude/agents/*.md)
 *   POST /agent-md-save   { file, body, description } | { file, raw } — doğrulayıp kaydeder (canlı)
 *   GET  /guvenlik      Güvenlik denetimi raporları sayfası (ui/guvenlik.html)
 *   GET  /security-reports       [{ id, createdAt, task, risk, counts }] — en yeni önce
 *   GET  /security-reports/<id>  tam rapor (bulgular, olumlu tespitler…)
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
  const themeCssPath = path.join(uiDir, "theme.css");
  const themeJsPath = path.join(uiDir, "theme.js");
  const dirPickerPath = path.join(uiDir, "dirpicker.js");
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
        let dir = "";
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
        let model = "";
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
        let effort = "";
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
        let key = "";
        let disabled = false;
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
        const r = options.setAutoForward ? options.setAutoForward(parsed.enabled) : { ok: false, error: "kapalı" };
        json(res, r.ok ? 200 : 400, r);
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
        if (!task) return json(res, 400, { ok: false, error: "görev boş olamaz" });
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
        const result = options.onTask(task, session, runAt);
        json(res, result.ok ? 202 : 409, result);
      });
      return;
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
