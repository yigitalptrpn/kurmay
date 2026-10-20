import fs from "node:fs";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkAgentMd, composeAgentMd, frontDescription, resolveAgentMd, splitAgentMd } from "./agentMd.js";
import { loadAgents, skillInfo } from "./agents.js";
import { fmtDate, parseRunAt } from "./approval.js";
import { disabledMcpServers, isEffort, loadAppConfig, modelMissing } from "./config.js";
import { listMcpTools, mcpStatus, probeMcp } from "./mcpStatus.js";
import { compactPercent, contextInfo } from "./context.js";
import { fetchModels, refreshModelContext } from "./models.js";
import { RESILIENCE_LIMIT_KEYS, RESILIENCE_RETRY_KEYS, setLiveResilience } from "./resilience.js";
import { runWorkflow } from "./orchestrator.js";
import { RuntimeRegistry, type SessionRuntime } from "./runtime.js";
import { startUiServer, type ToggleKind, type UiServer } from "./server.js";
import { SecurityReportStore, watchSecurityReports } from "./securityReport.js";
import { SessionStore, type SessionEntry } from "./sessions.js";
import { isFanoutNode, mainPath, type AgentDefinition, type AppConfig } from "./types.js";

function parseArgs(argv: string[]): {
  task: string;
  configPath: string;
  cwdFlag?: string;
  portFlag?: number;
  noUi: boolean;
  /** --at: görevin başlama zamanı ("+30m", "+2h", "2026-07-10 14:00") */
  atFlag?: string;
} {
  let configPath = "config.json";
  let cwdFlag: string | undefined;
  let portFlag: number | undefined;
  let noUi = false;
  let atFlag: string | undefined;
  const taskParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") configPath = argv[++i];
    else if (argv[i] === "--cwd") cwdFlag = argv[++i];
    else if (argv[i] === "--port") portFlag = Number(argv[++i]);
    else if (argv[i] === "--no-ui") noUi = true;
    else if (argv[i] === "--at") atFlag = argv[++i];
    else taskParts.push(argv[i]);
  }

  return { task: taskParts.join(" ").trim(), configPath, cwdFlag, portFlag, noUi, atFlag };
}

/** Aç/Kapat sayfasında kapatılan kural, beceri ve MCP sunucuları — loadAgents prompt'a almaz */
function offOf(cfg: AppConfig): { skills: string[]; rules: string[]; mcpServers: string[] } {
  return { skills: cfg.disabledSkills ?? [], rules: cfg.disabledRules ?? [], mcpServers: disabledMcpServers(cfg) };
}

/**
 * Koşu başına config kopyası: panelden canlı değişen alanlar (model, düğümlerin
 * `disabled`'ı) o an çalışan koşuyu ORTASINDA etkilemesin, sıradaki görevde
 * geçerli olsun. Workflow da kopyalanır çünkü `disabled` onun içinde.
 */
function snapshotConfig(cfg: AppConfig): AppConfig {
  return { ...cfg, workflow: structuredClone(cfg.workflow) };
}

/**
 * Bir oturumda tek bir görevi baştan sona koşturur; olaylar oturumun kanalına,
 * kayıt runs/'a gider. Oturumun ilk görevi değilse analist konuşması sürdürülür
 * (resume) ve panel önceki görevleri ekranda tutar. runtime.startRun ilk await'ten
 * ÖNCE çağrılır — oturum anında "meşgul" olur, çift başlatma olamaz.
 */
async function executeRun(o: {
  task: string;
  cfg: AppConfig;
  agents: Map<string, AgentDefinition>;
  cwd: string;
  runtime: SessionRuntime;
  runsDir: string;
  sessions: SessionStore;
  entry: SessionEntry;
  /** Güvenlik denetçisinin (securityReport düğümü) raporlarının saklandığı yer */
  securityReports: SecurityReportStore;
  onDone: () => void;
  /** Verilirse akış bu zamana kadar bekler (zamanlanmış görev) */
  startAt?: number;
}): Promise<void> {
  const { task, cfg, agents, cwd, runtime, entry } = o;
  const bus = runtime.bus;
  const abortController = runtime.startRun(task, cwd);
  // Oturumda önceki görevler varsa panel akışı temizlemez, araya ayraç koyar
  const resumed = bus.history.length > 0 || !!entry.sdkSessionId;
  const logName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${entry.id.slice(0, 8)}.jsonl`;
  const runLog = path.join(o.runsDir, logName);
  o.sessions.addRunLog(entry.id, logName, task);
  const unsubscribe = bus.subscribe((e) => fs.appendFileSync(runLog, JSON.stringify(e) + "\n"));
  // Güvenlik denetimi raporu: denetçi düğüm (securityReport) bitince runs/guvenlik/'e kaydedilir
  const unsubscribeReport = watchSecurityReports(bus, o.securityReports, {
    isReportAgent: (agent) => !!(cfg.workflow.agents[agent] as { securityReport?: boolean } | undefined)?.securityReport,
    base: { session: entry.id, sessionName: entry.name, task, targetDir: cwd, model: cfg.model },
    label: entry.name,
  });
  // entrySessionId: analistin SDK oturumu — varsa sürdürülür, koşu boyunca güncellenir
  const sessionStore: { entrySessionId?: string; entryContext?: number } = {
    entrySessionId: entry.sdkSessionId,
    entryContext: entry.contextTokens,
  };

  console.log(`\n🎯 [${entry.name}] Görev: ${task}`);
  try {
    bus.emit({
      type: "workflow_started",
      task,
      provider: cfg.provider,
      model: cfg.model,
      effort: cfg.effort,
      targetDir: cwd,
      entry: cfg.workflow.entry,
      maxCycles: cfg.workflow.maxCycles,
      agents: [...agents.keys()],
      resumed,
      fanouts: Object.fromEntries(
        Object.entries(cfg.workflow.agents)
          .filter(([, n]) => isFanoutNode(n))
          .map(([key, n]) => [key, (n as { agent: string }).agent]),
      ),
      disabled: Object.entries(cfg.workflow.agents)
        .filter(([, n]) => n.disabled)
        .map(([key]) => key),
    });
    await runWorkflow(cfg.workflow, agents, task, cwd, cfg, bus, abortController, runtime.web, sessionStore, o.startAt);
  } catch (err) {
    bus.emit({ type: "workflow_failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    runtime.endRun();
    unsubscribe();
    unsubscribeReport();
    o.sessions.finishRun(entry.id, sessionStore.entrySessionId, runtime.status, sessionStore.entryContext);
    o.onDone();
    console.log(`🗒  [${entry.name}] Koşu kaydı: ${runLog}`);
  }
}

async function main() {
  const { task, configPath, cwdFlag, portFlag, noUi, atFlag } = parseArgs(process.argv.slice(2));
  const startAt = atFlag ? parseRunAt(atFlag) : undefined;
  if (atFlag && startAt === undefined) {
    throw new Error(`--at anlaşılamadı: "${atFlag}" (ör. +30m, +2h, +1d, "2026-07-10 14:00")`);
  }

  const cfg = loadAppConfig(configPath);
  const resolvedConfigPath = path.resolve(configPath);
  // Bağlantı dayanıklılığı ayarları canlıdır: Ayarlar'dan değişince çalışan ajanlar da görür
  setLiveResilience(cfg);
  const configRoot = path.dirname(resolvedConfigPath);
  // md dosya yolları config dosyasının bulunduğu dizine göre çözülür.
  // "let": beceri/eklenti açılıp kapatılınca prompt'lar yeniden derlenir (setToggle);
  // çalışan koşu başlarken aldığı haritayla devam eder
  let agents = loadAgents(cfg.workflow, configRoot, offOf(cfg));

  // Hedef dizin önceliği: --cwd bayrağı > config'deki targetDir > bulunulan dizin.
  // "let": panelden değiştirilebilir (bkz. setTargetDir) — bir sonraki görev yeni
  // değeri kullanır, config.json'a da yazılır (sürekli dosyayı elle açmamak için).
  let cwd = path.resolve(cwdFlag ?? cfg.targetDir ?? process.cwd());
  const dirOk = (d: string) => fs.existsSync(d) && fs.statSync(d).isDirectory();
  if (!dirOk(cwd)) {
    // Tek görev modunda çalışacak yer yok — dur. Sunucu modunda ise servis açılsın:
    // panel uyarı gösterir, kullanıcı dizini üst çubuktan değiştirene kadar görev başlamaz
    if (task || noUi) throw new Error(`Hedef proje dizini bulunamadı: ${cwd}`);
    console.warn(
      `⚠ Hedef proje dizini bulunamadı: ${cwd}\n` +
        "  Panel yine de açılıyor — üst çubuktaki dizine tıklayıp geçerli bir dizin seç (o zamana kadar görev başlatılamaz).",
    );
  }

  if (modelMissing(cfg)) {
    // Dizin uyarısıyla aynı desen: tek görev modunda dur, sunucu modunda aç ve uyar
    const msg = 'provider "ollama" için model seçilmedi (örn. "qwen3-coder:30b")';
    if (task || noUi) throw new Error(`config: ${msg}`);
    console.warn(`⚠ ${msg}\n  Panel yine de açılıyor — üst çubuktaki model listesinden seç (o zamana kadar görev başlatılamaz).`);
  }

  if (!task && noUi) {
    console.error(
      'Kullanım: npm start -- "görev" [--config config.json] [--cwd dizin] [--port 4141] [--no-ui] [--at +30m]\n' +
        "Görev verilmezse sunucu modu açılır ve görev panelden beklenir (--no-ui ile birlikte kullanılamaz).",
    );
    process.exit(1);
  }

  const runsDir = path.join(configRoot, "runs");
  const securityReports = new SecurityReportStore(path.join(runsDir, "guvenlik"));
  fs.mkdirSync(runsDir, { recursive: true });

  // Oturum kataloğu (runs/sessions.json) + oturum başına çalışma zamanları. Sunucu
  // modunda onaylar yalnızca panelden (exclusive): birden çok oturum aynı anda
  // soru sorabilir, terminal cevabının hangi oturuma gittiği belirsiz olurdu.
  const sessions = new SessionStore(runsDir);
  // Hedef dizini kayıtlı olmayan eski oturumlar ilk koşuda o anki genel dizine
  // sabitleniyordu; genel dizin o arada değiştiyse Analist'in konuşması yanlış
  // klasörde aranıp "konuşma bulunamadı" oluyordu. Konuşmanın gerçek dizini
  // Claude Code'un kaydında yazıyor — açılışta oradan alınır.
  for (const e of sessions.all()) {
    if (e.targetDir || !e.sdkSessionId) continue;
    try {
      const dir = (await getSessionInfo(e.sdkSessionId))?.cwd;
      if (dir) {
        sessions.setTargetDir(e.id, dir, true);
        console.log(`📁 "${e.name}" oturumunun dizini konuşma kaydından alındı: ${dir}`);
      }
    } catch {
      /* okunamadı — eski davranış: ilk koşuda genel dizin */
    }
  }
  const runtimes = new RuntimeRegistry(runsDir, !task);
  const maxParallel = cfg.maxParallelRuns ?? 3;

  /** Panelin sol çubuğu için oturum listesi + canlı durumlar */
  // Analist'in modeli: düğümdeki ayar > oturumun modeli > genel model
  const entryModel = (e: SessionEntry) =>
    (cfg.workflow.agents[cfg.workflow.entry] as { model?: string } | undefined)?.model ?? (e.model || cfg.model);
  const sessionList = () =>
    sessions.all().map((e) => {
      const rt = runtimes.peek(e.id);
      const ctx = e.contextTokens ? contextInfo(entryModel(e), cfg) : undefined;
      return {
        id: e.id,
        name: e.name,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        status: rt?.status ?? e.lastStatus ?? "idle",
        busy: rt?.busy ?? false,
        task: rt?.task ?? e.lastTask,
        cwd: rt?.cwd,
        runs: e.runLogs?.length ?? 0,
        model: e.model,
        effort: e.effort,
        // Oturumun hedef dizini (yoksa genel dizin geçerli) ve diskte var mı — panel uyarısı için
        targetDir: e.targetDir,
        dirExists: dirOk(e.targetDir ?? cwd),
        // Analist konuşmasının doluluğu — panelde yaklaşınca uyarı
        ...(e.contextTokens ? { context: { tokens: e.contextTokens, window: ctx?.window, limit: ctx?.limit } } : {}),
      };
    });

  /** Bir oturumda görev başlatır (oturum yoksa açar); arka planda koşar */
  const launch = (task: string, entry: SessionEntry | undefined, runAt?: number) => {
    // Yeni oturum o anki genel model/derinlik/dizinle açılır; sonra panelden yalnızca kendisi için değişebilir
    const e = entry ?? sessions.create(task, cfg.model, cfg.effort, cwd);
    // Eski kayıt (dizinsiz): o anki genel dizine sabitlenir — konuşması da o dizinde
    if (!e.targetDir) sessions.setTargetDir(e.id, cwd, true);
    const runDir = e.targetDir ?? cwd;
    const runCfg = snapshotConfig(cfg);
    if (e.model) runCfg.model = e.model;
    if (e.effort) runCfg.effort = e.effort;
    const runtime = runtimes.get(e.id, e.runLogs);
    const run = executeRun({
      task,
      // Kopya: panelden model/düğüm değişirse çalışan koşunun kalan adımları etkilenmesin
      cfg: runCfg,
      agents,
      cwd: runDir,
      runtime,
      runsDir,
      sessions,
      entry: e,
      securityReports,
      onDone: () => runtimes.notify(),
      startAt: runAt,
    });
    runtimes.notify();
    return { entry: e, run };
  };

  /** .claude/<alt> dizininin girdileri (yoksa boş) */
  const lsClaude = (sub: string) => {
    try {
      return fs.readdirSync(path.join(configRoot, ".claude", sub), { withFileTypes: true });
    } catch {
      return [];
    }
  };

  /** Düğümü devre dışı bırakır/açar: config.json'a yazar, sıradaki görev görür */
  const setNodeDisabled = (key: string, disabled: boolean): { ok: boolean; error?: string } => {
    if (!cfg.workflow.agents[key]) return { ok: false, error: `düğüm bulunamadı: ${key}` };
    const prev = fs.readFileSync(resolvedConfigPath, "utf8");
    try {
      const parsed = JSON.parse(prev) as AppConfig;
      const node = parsed.workflow?.agents?.[key];
      if (!node) return { ok: false, error: `düğüm ayar dosyasında yok: ${key}` };
      if (disabled) node.disabled = true;
      else delete node.disabled;
      fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
      loadAppConfig(resolvedConfigPath); // yapı doğrulaması
      // Sıradaki görev görür; çalışan koşu kendi workflow kopyasıyla devam eder
      if (disabled) cfg.workflow.agents[key].disabled = true;
      else delete cfg.workflow.agents[key].disabled;
      return { ok: true };
    } catch (e) {
      fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  /** Planı otomatik iletme (Ayarlar): config.json'a yazar, sıradaki görev görür */
  const setAutoForward = (enabled: boolean): { ok: boolean; error?: string; enabled?: boolean } => {
    const prev = fs.readFileSync(resolvedConfigPath, "utf8");
    try {
      const parsed = JSON.parse(prev) as AppConfig;
      if (!parsed.workflow) return { ok: false, error: "ayar dosyasında akış (workflow) bölümü yok" };
      if (enabled) parsed.workflow.autoForwardPlan = true;
      else delete parsed.workflow.autoForwardPlan;
      fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
      loadAppConfig(resolvedConfigPath); // yapı doğrulaması
      // Çalışan koşu kendi workflow kopyasıyla devam eder
      if (enabled) cfg.workflow.autoForwardPlan = true;
      else delete cfg.workflow.autoForwardPlan;
      return { ok: true, enabled };
    } catch (e) {
      fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  /**
   * Güvenlik denetçisini akışa ekler ve açar (Ayarlar'daki "Güvenlik denetimi" anahtarı).
   * Denetçi sonradan geldi: daha önce oluşturulmuş config.json'larda (kurmay init /
   * git pull mevcut dosyanın üstüne yazmaz) securityReport düğümü yok ve anahtar
   * açılamıyordu. Düğüm Teftiş onayından sonraya bağlanır (onay kenarı denetçiye,
   * denetçinin next'i eski onay hedefine); rol tanımı/hook dosyası yoksa paketten kopyalanır.
   */
  const addSecurityAudit = (): { ok: boolean; error?: string; key?: string; node?: unknown; attachedTo?: string } => {
    const nodes = cfg.workflow.agents;
    const disk = () => JSON.parse(fs.readFileSync(resolvedConfigPath, "utf8")) as AppConfig;
    const existing = Object.keys(nodes).find((k) => (nodes[k] as { securityReport?: boolean }).securityReport);
    if (existing) {
      const r = setNodeDisabled(existing, false);
      return r.ok ? { ok: true, key: existing, node: disk().workflow.agents[existing] } : r;
    }
    // Bağlanacak yer: onay/red kararı veren inceleme adımı (öncelik "teftis")
    const verdicts = Object.keys(nodes).filter((k) => (nodes[k] as { verdict?: unknown }).verdict);
    const inspector = verdicts.includes("teftis") ? "teftis" : verdicts[0];
    if (!inspector) {
      return { ok: false, error: "akışta onay/red kararı veren bir inceleme adımı yok — denetçi Teftiş onayından sonra çalışır" };
    }
    // Rol tanımı ve salt okunur hook'u: çalışma klasöründe yoksa paketteki şablondan
    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const ensure = (rel: string): boolean => {
      const abs = path.join(configRoot, rel);
      if (fs.existsSync(abs)) return true;
      const src = path.join(pkgRoot, rel);
      if (!fs.existsSync(src)) return false;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(src, abs);
      return true;
    };
    const persona = ".claude/agents/guvenlik.md";
    if (!ensure(persona)) return { ok: false, error: `denetçinin rol tanımı bulunamadı: ${persona}` };
    const guard = ensure(".claude/hooks/guard-readonly.js");

    let key = "guvenlik";
    for (let i = 2; nodes[key]; i++) key = `guvenlik-${i}`;
    const prev = fs.readFileSync(resolvedConfigPath, "utf8");
    try {
      const parsed = JSON.parse(prev) as AppConfig;
      const insp = parsed.workflow?.agents?.[inspector] as { tools?: string[]; rules?: string[]; verdict?: { onApprove: string | null } } | undefined;
      if (!insp?.verdict) return { ok: false, error: `düğüm ayar dosyasında yok: ${inspector}` };
      // Teftiş'in eklentileri ve kuralları; dosya yazan araçlar yok (denetçi salt okunur)
      const node = {
        file: persona,
        tools: ["Read", "Glob", "Grep", ...(insp.tools ?? []).filter((t) => t.startsWith("mcp__"))],
        ...(insp.rules?.length ? { rules: [...insp.rules] } : {}),
        ...(guard
          ? {
              hooks: [
                {
                  event: "PreToolUse",
                  matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash",
                  command: 'node "${configDir}/.claude/hooks/guard-readonly.js"',
                },
              ],
            }
          : {}),
        securityReport: true,
        next: insp.verdict.onApprove ?? null,
      };
      parsed.workflow.agents[key] = node as AppConfig["workflow"]["agents"][string];
      insp.verdict.onApprove = key;
      fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
      const c = loadAppConfig(resolvedConfigPath); // yapı doğrulaması (+ ${configDir} çevrilir)
      loadAgents(c.workflow, configRoot, offOf(c)); // kenar + md + kural doğrulaması
      // Sıradaki görev görür; çalışan koşu kendi workflow kopyasıyla devam eder
      nodes[key] = c.workflow.agents[key];
      (nodes[inspector] as { verdict: { onApprove: string | null } }).verdict.onApprove = key;
      agents = loadAgents(cfg.workflow, configRoot, offOf(cfg));
      return { ok: true, key, node, attachedTo: inspector };
    } catch (e) {
      fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  /** Aç/Kapat sayfası verisi: ajan düğümleri, beceriler, MCP sunucuları ve kimin kullandığı */
  const getToggles = () => {
    const nodes = cfg.workflow.agents;
    const agentNodes = Object.entries(nodes).filter(([, n]) => (n.type ?? "agent") === "agent");
    const workerOf = new Map(
      Object.entries(nodes).flatMap(([k, n]) => (isFanoutNode(n) ? [[n.agent, k] as const] : [])),
    );
    const off = offOf(cfg);
    // Diskteki beceri klasörleri + düğümlerde adı geçip diskte olmayanlar
    const skillNames = new Set(lsClaude("skills").filter((e) => e.isDirectory()).map((e) => e.name));
    for (const [, n] of agentNodes) for (const s of (n as { skills?: string[] }).skills ?? []) skillNames.add(s);
    // Kurallar: diskteki .claude/rules/*.md + düğümlerde adı geçip diskte olmayanlar
    const ruleNames = new Set(
      lsClaude("rules")
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name.replace(/\.md$/, "")),
    );
    for (const [, n] of agentNodes) for (const r of (n as { rules?: string[] }).rules ?? []) ruleNames.add(r);
    return {
      entry: cfg.workflow.entry,
      agents: Object.entries(nodes).map(([key, n]) => ({
        key,
        type: n.type ?? "agent",
        disabled: !!n.disabled,
        description: agents.get(key)?.description ?? "",
        ...(isFanoutNode(n) ? { worker: n.agent } : {}),
        ...(workerOf.has(key) ? { fanout: workerOf.get(key) } : {}),
      })),
      rules: [...ruleNames].sort().map((name) => {
        // Kural dosyasında başlık/açıklama yok — ilk dolu satırı özet olarak göster
        let first: string | undefined;
        try {
          const text = fs.readFileSync(path.join(configRoot, ".claude", "rules", `${name}.md`), "utf8");
          first = text
            .split(/\r?\n/)
            .map((l) => l.replace(/^\s*(?:[-*+]|\d+\.|#+)\s*/, "").trim())
            .find((l) => l && l !== "---");
        } catch {
          /* dosya yok */
        }
        return {
          name,
          description: first ? (first.length > 160 ? first.slice(0, 157) + "…" : first) : "",
          missing: first === undefined,
          disabled: off.rules.includes(name),
          usedBy: agentNodes.filter(([, n]) => (n as { rules?: string[] }).rules?.includes(name)).map(([k]) => k),
        };
      }),
      skills: [...skillNames].sort().map((name) => {
        const info = skillInfo(name, configRoot);
        return {
          name,
          description: info?.description ?? "",
          missing: !info,
          disabled: off.skills.includes(name),
          usedBy: agentNodes.filter(([, n]) => (n as { skills?: string[] }).skills?.includes(name)).map(([k]) => k),
        };
      }),
      mcpServers: Object.entries(cfg.mcpServers ?? {}).map(([name, s]) => ({
        name,
        disabled: !!s.disabled,
        usedBy: agentNodes
          .filter(([, n]) => (n as { tools?: string[] }).tools?.some((t) => t === `mcp__${name}` || t.startsWith(`mcp__${name}__`)))
          .map(([k]) => k),
      })),
    };
  };

  /**
   * Aç/Kapat: ajan düğümü (disabled), kural (disabledRules), beceri (disabledSkills) ya da MCP sunucusu
   * (mcpServers.<ad>.disabled). config.json'a yazılır; beceri/eklentide ajan
   * prompt'ları yeniden derlenir. Sıradaki görev görür, çalışan koşu etkilenmez.
   */
  const setToggle = (kind: ToggleKind, name: string, disabled: boolean): { ok: boolean; error?: string } => {
    if (kind === "agent") return setNodeDisabled(name, disabled);
    if (kind === "mcp" && !cfg.mcpServers?.[name]) {
      return { ok: false, error: `eklenti bulunamadı: ${name} (ayar dosyasına yeni eklendiyse servisi yeniden başlat)` };
    }
    const prev = fs.readFileSync(resolvedConfigPath, "utf8");
    try {
      const parsed = JSON.parse(prev) as AppConfig;
      // Bellekteki config'in yeni hali — yerinde değiştirilmez: çalışan koşunun
      // kopyası ({...cfg}) eski dizi/nesneyi tutmaya devam etsin
      let nextSkills = cfg.disabledSkills;
      let nextRules = cfg.disabledRules;
      let nextMcp = cfg.mcpServers;
      if (kind === "skill" || kind === "rule") {
        // Kural ve beceri aynı desen: üst düzey ad listesi, boşalınca alan silinir
        const field = kind === "skill" ? "disabledSkills" : "disabledRules";
        const set = new Set(parsed[field] ?? []);
        if (disabled) set.add(name);
        else set.delete(name);
        if (set.size > 0) parsed[field] = [...set];
        else delete parsed[field];
        if (kind === "skill") nextSkills = parsed[field];
        else nextRules = parsed[field];
      } else {
        const server = parsed.mcpServers?.[name];
        if (!server) return { ok: false, error: `eklenti ayar dosyasında yok: ${name}` };
        if (disabled) server.disabled = true;
        else delete server.disabled;
        const { disabled: _, ...rest } = cfg.mcpServers![name];
        nextMcp = { ...cfg.mcpServers, [name]: disabled ? { ...rest, disabled: true } : rest } as AppConfig["mcpServers"];
      }
      fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
      loadAppConfig(resolvedConfigPath); // yapı doğrulaması
      const nextAgents = loadAgents(
        cfg.workflow,
        configRoot,
        offOf({ ...cfg, disabledSkills: nextSkills, disabledRules: nextRules, mcpServers: nextMcp }),
      );
      cfg.disabledSkills = nextSkills;
      cfg.disabledRules = nextRules;
      cfg.mcpServers = nextMcp;
      agents = nextAgents; // sıradaki görev yeni prompt'larla başlar
      // Açılan eklentinin ışığı hemen dolsun (kapatılan zaten "kapalı" görünür)
      if (kind === "mcp" && !disabled) void probeMcp(cfg, mcpProbeDir());
      return { ok: true };
    } catch (e) {
      fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // Eklenti durum ışıkları: son bilinen durum + model çağrısız yoklama
  const mcpProbeDir = () => (dirOk(cwd) ? cwd : process.cwd());
  const mcpView = () => ({
    servers: mcpStatus.snapshot(cfg),
    probing: !!mcpStatus.probing,
    ...(mcpStatus.probeError ? { error: mcpStatus.probeError } : {}),
  });

  let server: UiServer | undefined;
  if (!noUi) {
    server = await startUiServer(portFlag ?? cfg.uiPort ?? 4141, {
      runtimes,
      getSessions: sessionList,
      openSession: (id) => {
        const e = sessions.get(id);
        return e ? runtimes.get(e.id, e.runLogs) : undefined;
      },
      // Çalışan oturum silinmez (koşusu yetim kalırdı)
      deleteSession: (id) => {
        if (runtimes.peek(id)?.busy) return false;
        runtimes.delete(id);
        const ok = sessions.remove(id);
        runtimes.notify();
        return ok;
      },
      getConfigData: () => {
        const raw = fs.readFileSync(resolvedConfigPath, "utf8");
        const ls = lsClaude;
        const rules = ls("rules")
          .filter((e) => e.isFile() && e.name.endsWith(".md"))
          .map((e) => e.name.replace(/\.md$/, ""));
        const skills = ls("skills").filter((e) => e.isDirectory()).map((e) => e.name);
        const agentMds = ls("agents")
          .filter((e) => e.isFile() && e.name.endsWith(".md"))
          .map((e) => e.name.replace(/\.md$/, ""));
        return { raw, rules, skills, agents: agentMds };
      },
      createAgentMd: (name) => {
        // path traversal'a karşı ad temizlenir; yalnızca .claude/agents altına yazılır
        const safe = String(name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
        if (!safe) return { ok: false, error: "geçersiz persona adı" };
        const rel = `.claude/agents/${safe}.md`;
        const abs = path.join(configRoot, rel);
        if (fs.existsSync(abs)) return { ok: false, error: `zaten var: ${rel}` };
        const tpl =
          `---\nname: ${safe}\ndescription: ${safe} ajanı\n---\n\n` +
          `Sen ${safe} rolündeki bir ajansın. Görevini yerine getir; çıktın net ve uygulanabilir olsun.\n`;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, tpl);
        return { ok: true, file: rel };
      },
      getAgentMd: (file) => {
        const abs = resolveAgentMd(configRoot, file);
        if (!abs) return { ok: false, error: "yalnızca rol tanımı klasöründeki dosyalar açılabilir" };
        if (!fs.existsSync(abs)) return { ok: false, error: `dosya bulunamadı: ${file}` };
        const raw = fs.readFileSync(abs, "utf8");
        const parts = splitAgentMd(raw);
        return { ok: true, file, raw, body: parts.body, description: frontDescription(parts.front) };
      },
      // Persona kaydı: dosyaya yazılır, tüm ajanlar yeniden yüklenip doğrulanır
      // (bozuk ön bölüm, eksik kural/beceri…) — hata olursa eski içerik geri konur.
      // Başarılıysa sıradaki görev yeni talimatla başlar; çalışan koşu etkilenmez.
      saveAgentMd: (file, edit) => {
        const abs = resolveAgentMd(configRoot, file);
        if (!abs) return { ok: false, error: "yalnızca rol tanımı klasöründeki dosyalar kaydedilebilir" };
        if (!fs.existsSync(abs)) return { ok: false, error: `dosya bulunamadı: ${file}` };
        const prev = fs.readFileSync(abs, "utf8");
        let next: string;
        if (edit.raw !== undefined) {
          next = prev.includes("\r\n") ? edit.raw.replace(/\r?\n/g, "\r\n") : edit.raw.replace(/\r\n/g, "\n");
        } else {
          if (!edit.body?.trim()) return { ok: false, error: "talimat metni boş olamaz" };
          next = composeAgentMd(splitAgentMd(prev), edit.body, edit.description ?? "", path.basename(abs, ".md"));
        }
        if (next === prev) return { ok: true };
        const invalid = checkAgentMd(next);
        if (invalid) return { ok: false, error: invalid };
        try {
          fs.writeFileSync(abs, next);
          agents = loadAgents(cfg.workflow, configRoot, offOf(cfg));
          return { ok: true };
        } catch (e) {
          fs.writeFileSync(abs, prev); // geçersizse geri al
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      saveConfig: (text): string | null => {
        const prev = fs.readFileSync(resolvedConfigPath, "utf8");
        try {
          JSON.parse(text); // geçerli JSON mu
          fs.writeFileSync(resolvedConfigPath, text);
          const c = loadAppConfig(resolvedConfigPath); // yapı + mcp + komut doğrulaması
          loadAgents(c.workflow, configRoot, offOf(c)); // kenar + md + kural/beceri doğrulaması
          return null;
        } catch (e) {
          fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
          return e instanceof Error ? e.message : String(e);
        }
      },
      getTargetDir: () => cwd,
      setTargetDir: (dir, sessionId) => {
        const resolvedDir = path.resolve(dir);
        if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
          return { ok: false, error: `dizin bulunamadı: ${resolvedDir}` };
        }
        // Oturuma özel: config.json'a dokunmaz, yalnızca o oturumun sıradaki görevi etkilenir
        if (sessionId) {
          const r = sessions.setTargetDir(sessionId, resolvedDir);
          if (!r.ok) return { ok: false, error: "oturum bulunamadı" };
          runtimes.notify();
          return { ok: true, dir: resolvedDir, resetResume: r.resetResume };
        }
        const prev = fs.readFileSync(resolvedConfigPath, "utf8");
        try {
          const parsed = JSON.parse(prev) as Record<string, unknown>;
          parsed.targetDir = resolvedDir; // yoksa eklenir, varsa güncellenir
          fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
          loadAppConfig(resolvedConfigPath); // yapı doğrulaması
          cwd = resolvedDir; // sıradaki görev bu dizini kullanır
          return { ok: true, dir: resolvedDir };
        } catch (e) {
          fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      getModels: async () => {
        const current = cfg.model ?? "";
        const required = cfg.provider === "ollama"; // panel "model seçilmedi" uyarısı için
        const effort = cfg.effort ?? "";
        // Bağlam göstergesinin renk eşiği + modeli listede olmayanlar için elle girilen pencere
        const context = { compactPercent: compactPercent(cfg), fallbackWindow: cfg.limits?.contextTokens ?? null, reserve: cfg.limits?.maxOutputTokens ?? null };
        if (!cfg.modelsUrl) {
          return { current, required, effort, context, models: [], error: "model listesi adresi tanımlı değil — ⚙ Ayarlar sayfasındaki Bağlantı bölümünden ekle" };
        }
        try {
          const models = await fetchModels(cfg.modelsUrl, cfg.apiKey);
          runtimes.notify(); // lobideki bağlam sınırları da tazelensin
          return { current, required, effort, context, models };
        } catch (e) {
          return { current, required, effort, context, models: [], error: e instanceof Error ? e.message : String(e) };
        }
      },
      setEffort: (effort, sessionId) => {
        if (effort !== "" && !isEffort(effort)) return { ok: false, error: "geçersiz akıl yürütme derinliği" };
        // Oturuma özel: config.json'a dokunmaz, yalnızca o oturumun sıradaki görevi etkilenir
        if (sessionId) {
          if (!sessions.get(sessionId)) return { ok: false, error: "oturum bulunamadı" };
          sessions.setEffort(sessionId, effort);
          runtimes.notify();
          return { ok: true, effort };
        }
        const prev = fs.readFileSync(resolvedConfigPath, "utf8");
        try {
          const parsed = JSON.parse(prev) as Record<string, unknown>;
          parsed.effort = effort; // "" = varsayılan (loadAppConfig tanımsız sayar)
          fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
          loadAppConfig(resolvedConfigPath);
          // Sıradaki görev bunu kullanır; çalışan koşu kendi kopyasıyla devam eder
          if (effort) cfg.effort = effort;
          else delete cfg.effort;
          return { ok: true, effort };
        } catch (e) {
          fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      // Bağlantı dayanıklılığı (Ayarlar sayfası): config.json'a yazılır ve HEMEN geçerli
      // olur — yeniden başlatma gerekmez, bekleyen/çalışan ajanların sıradaki denemesi
      // de yeni değeri kullanır. null = alanı sil (varsayılana dön).
      setResilience: (input) => {
        const prev = fs.readFileSync(resolvedConfigPath, "utf8");
        try {
          const parsed = JSON.parse(prev) as Record<string, unknown>;
          const merge = (current: unknown, patch: Record<string, unknown> | undefined, keys: readonly string[]) => {
            const out: Record<string, unknown> = { ...((current as Record<string, unknown> | undefined) ?? {}) };
            for (const k of keys) {
              if (!patch || !(k in patch)) continue;
              if (patch[k] === null) delete out[k];
              else out[k] = patch[k];
            }
            return out;
          };
          const retry = merge(parsed.retry, input.retry, RESILIENCE_RETRY_KEYS);
          const limits = merge(parsed.limits, input.limits, RESILIENCE_LIMIT_KEYS);
          if (Object.keys(retry).length) parsed.retry = retry;
          else delete parsed.retry;
          if (Object.keys(limits).length) parsed.limits = limits;
          else delete parsed.limits;
          fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
          const c = loadAppConfig(resolvedConfigPath); // tür/aralık doğrulaması
          // Yeni nesneler: çalışan koşunun kopyası eskisini tutar, canlı değer bunu gösterir
          cfg.retry = c.retry;
          cfg.limits = c.limits;
          setLiveResilience(cfg);
          return { ok: true, retry: c.retry ?? {}, limits: c.limits ?? {} };
        } catch (e) {
          fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      setModel: (model, sessionId) => {
        // Oturuma özel: config.json'a dokunmaz, yalnızca o oturumun sıradaki görevi etkilenir
        if (sessionId) {
          if (!sessions.get(sessionId)) return { ok: false, error: "oturum bulunamadı" };
          if (!model && modelMissing(cfg)) {
            return { ok: false, error: "Genel varsayılan model de seçili değil — bir model seç" };
          }
          sessions.setModel(sessionId, model);
          runtimes.notify();
          return { ok: true, model };
        }
        const prev = fs.readFileSync(resolvedConfigPath, "utf8");
        try {
          const parsed = JSON.parse(prev) as Record<string, unknown>;
          parsed.model = model; // "" = sağlayıcı varsayılanı (loadAppConfig tanımsız sayar)
          fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
          loadAppConfig(resolvedConfigPath); // yapı doğrulaması (boş model kabul — görev başlarken kontrol edilir)
          // Sıradaki görev bu modeli kullanır; çalışan koşu kendi kopyasıyla devam eder
          if (model) cfg.model = model;
          else delete cfg.model;
          return { ok: true, model };
        } catch (e) {
          fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      getWorkflow: () => ({
        entry: cfg.workflow.entry,
        autoForwardPlan: !!cfg.workflow.autoForwardPlan,
        nodes: mainPath(cfg.workflow).map((key) => {
          const n = cfg.workflow.agents[key];
          return {
            key,
            type: n.type ?? "agent",
            disabled: !!n.disabled,
            ...(isFanoutNode(n) ? { agent: n.agent } : {}),
          };
        }),
      }),
      setNodeDisabled,
      setAutoForward,
      addSecurityAudit,
      getToggles,
      listSecurityReports: () => securityReports.list(),
      getSecurityReport: (id) => securityReports.get(id),
      setToggle,
      getMcpStatus: mcpView,
      getMcpTools: async (name) => {
        const server = cfg.mcpServers?.[name];
        if (!server) return { ok: false, error: "eklenti bulunamadı" };
        if (server.disabled) return { ok: false, error: "eklenti kapalı" };
        try {
          return { ok: true, tools: await listMcpTools(name, server, mcpProbeDir()) };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      probeMcp: async () => {
        await probeMcp(cfg, mcpProbeDir());
        return mcpView();
      },
      onTask: task
        ? undefined // CLI görevli modda panelden görev alınmaz
        : (t, sessionId, runAt) => {
            const existing = sessionId ? sessions.get(sessionId) : undefined;
            if (modelMissing({ ...cfg, model: existing?.model || cfg.model })) {
              return { ok: false, error: "Model seçilmedi — üst çubuktaki model listesinden bir model seç" };
            }
            const entry = sessionId ? sessions.get(sessionId) : undefined;
            if (sessionId && !entry) return { ok: false, error: "oturum bulunamadı" };
            const dir = entry?.targetDir ?? cwd; // oturumun dizini; yeni oturumda genel dizin
            if (!dirOk(dir)) {
              return { ok: false, error: `Hedef dizin bulunamadı: ${dir} — sağdaki hedef dizine tıklayıp geçerli bir dizin seç` };
            }
            if (entry && runtimes.get(entry.id, entry.runLogs).busy) {
              return { ok: false, error: "Bu oturumda zaten bir görev çalışıyor — bitmesini bekle ya da yeni oturum aç" };
            }
            const busy = runtimes.busy();
            if (busy.length >= maxParallel) {
              return {
                ok: false,
                error: `Aynı anda en fazla ${maxParallel} görev çalışabilir (ayar dosyasında değiştirilebilir) — biri bitince tekrar dene`,
              };
            }
            // Aynı dizine iki akış aynı anda yazarsa birbirini ezer — engellemiyoruz
            // (salt okunur bilgi soruları zararsız) ama açıkça uyarıyoruz
            const clash = busy.find((r) => r.cwd === dir);
            const { entry: e, run } = launch(t, entry, runAt);
            run.catch((err) => console.error(`💥 [${e.name}] Koşu hatası:`, err instanceof Error ? err.message : err));
            return {
              ok: true,
              session: e.id,
              ...(clash
                ? { warning: `Aynı hedef dizinde (${dir}) çalışan başka bir oturum var — dosyaları birbirini ezebilir` }
                : {}),
            };
          },
    });
    console.log(`🖥  İzleme paneli: ${server.url}`);
    // Bağlam pencereleri (max_model_len) model listesinden — lobi ilk açılışta da göstersin
    void refreshModelContext(cfg.modelsUrl, cfg.apiKey).then(() => runtimes.notify());
    // Açılışta eklentileri bir kez yokla — panelde ışık ilk koşuyu beklemeden dolsun
    if (Object.values(cfg.mcpServers ?? {}).some((s) => !s.disabled)) {
      void probeMcp(cfg, mcpProbeDir()).then(() => {
        const list = mcpStatus.snapshot(cfg).filter((s) => s.status !== "disabled");
        console.log(`🔌 Eklentiler: ${list.map((s) => `${s.name} ${s.status === "connected" ? "✓" : `✗ (${s.error ?? s.status})`}`).join(" · ")}`);
      });
    }
  }

  console.log(`🔌 Sağlayıcı: ${cfg.provider}${cfg.baseUrl ? ` (${cfg.baseUrl})` : ""}${cfg.model ? ` | model: ${cfg.model}` : ""}`);
  console.log(`📁 Hedef proje dizini: ${cwd}`);
  console.log(`🗺  Akış: ${[...agents.keys()].join(" → ")} (entry: ${cfg.workflow.entry})`);

  if (task) {
    // Tek görev modu: yeni oturumda çalıştır ve çık (terminal onayı da açık)
    try {
      if (startAt) console.log(`⏰ Görev ${fmtDate(startAt)} için zamanlandı`);
      await launch(task, undefined, startAt).run;
    } finally {
      server?.close();
    }
    return;
  }

  // Sunucu modu: görevler panelden gelir, her biri kendi oturumunda bağımsız koşar
  console.log(`⏳ Görev bekleniyor — panelden girebilirsin (aynı anda en fazla ${maxParallel}).`);
}

main().catch((err) => {
  console.error("\n💥 Hata:", err instanceof Error ? err.message : err);
  process.exit(1);
});
