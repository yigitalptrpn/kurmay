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
import { SecurityAuditRunner } from "./securityAudit.js";
import { searchSessions } from "./search.js";
import { SessionStore, sessionRecap, type SessionEntry } from "./sessions.js";
import { attachmentSection, saveFiles, type Attachment, type FileInput } from "./attachments.js";
import type { OrchestratorEvent, TimedEvent } from "./events.js";
import {
  fetchAttachment,
  forgetServer,
  getStates,
  getSummaries,
  linkArtifact,
  myWorkItems,
  probe as probeTfs,
  searchWorkItems,
  serverVersion,
  TfsError,
  writeWorkItem,
} from "./tfs.js";
import { textToTfsHtml } from "./tfsHtml.js";
import { readTfsToken, tfsConnection, tfsReady, tfsView, writeTfsToken } from "./tfsSettings.js";
import {
  prepareWorkItemTask,
  previewWorkItem,
  runChangedFiles,
  runSucceeded,
  workItemLabel,
  writeBackDraft,
} from "./tfsTask.js";
import {
  authEnv,
  checkoutPrBranch,
  commitAndPush,
  currentBranch,
  defaultBranch,
  findRepo,
  groupByRepo,
  openRepo,
  projectFromRemote,
  repoNameFromRemote,
  slug,
  uniqueBranch,
} from "./tfsGit.js";
import {
  createPullRequest,
  createThread,
  getIterationChanges,
  getPullRequest,
  getRepository,
  myPullRequests,
  repoInfoFromRemote,
  replyToThread,
  setThreadStatus,
  type TfsPullRequest,
} from "./tfsPr.js";
import { preparePrFollowUp, preparePrTask, previewPr, prWriteDraft } from "./tfsPrTask.js";
import {
  isFanoutNode,
  mainPath,
  TFS_WRITE_BACK,
  type AgentDefinition,
  type AppConfig,
  type TfsConfig,
  type WorkflowConfig,
} from "./types.js";

/** Koşunun TFS iş öğesi (workflow_started.workItem) */
type RunWorkItem = NonNullable<Extract<OrchestratorEvent, { type: "workflow_started" }>["workItem"]>;
/** Koşunun TFS çekme isteği (workflow_started.pr) */
type RunPr = NonNullable<Extract<OrchestratorEvent, { type: "workflow_started" }>["pr"]>;
/** PR'a yazma isteği (panel kartı ya da kendiliğinden) */
interface PrWriteInput {
  push: boolean;
  message?: string;
  files?: string[];
  replies: Array<{ threadId: number; firstCommentId: number; text: string; resolve: boolean; send: boolean }>;
  comments: Array<{ file?: string; line?: number; text: string; send: boolean }>;
  general?: string;
}

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
  /** Görevle verilen dosyalar (kaydedilmiş) — ajanlara görev metninin sonunda yollarıyla gider */
  attachments?: Attachment[];
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
  /** Panelde/lobide görünen görev (TFS: "#123 · Başlık"); yoksa task */
  display?: string;
  /** TFS iş öğesi (workflow_started'da taşınır) */
  workItem?: RunWorkItem;
  /** TFS çekme isteği (workflow_started'da taşınır) */
  pr?: RunPr;
  /** Ekler bölümünün ilk cümlesi (TFS ekleri için) */
  attachmentIntro?: string;
  /** Akış bittikten sonra, koşu kaydı kapanmadan (TFS'e yazma) — bu koşunun olaylarıyla */
  afterRun?: (events: TimedEvent[]) => Promise<void>;
}): Promise<void> {
  const { task, cfg, agents, cwd, runtime, entry } = o;
  const display = o.display ?? task;
  const bus = runtime.bus;
  const abortController = runtime.startRun(display, cwd);
  // Oturumda önceki görevler varsa panel akışı temizlemez, araya ayraç koyar
  const resumed = bus.history.length > 0 || !!entry.sdkSessionId;
  const logName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${entry.id.slice(0, 8)}.jsonl`;
  const runLog = path.join(o.runsDir, logName);
  o.sessions.addRunLog(entry.id, logName, display);
  const unsubscribe = bus.subscribe((e) => fs.appendFileSync(runLog, JSON.stringify(e) + "\n"));
  // Güvenlik denetimi raporu: denetçi düğüm (securityReport) bitince runs/guvenlik/'e kaydedilir
  const unsubscribeReport = watchSecurityReports(bus, o.securityReports, {
    isReportAgent: (agent) =>
      !!(cfg.workflow.agents[agent] as { securityReport?: boolean } | undefined)?.securityReport,
    base: { session: entry.id, sessionName: entry.name, task, targetDir: cwd, model: cfg.model },
    label: entry.name,
  });
  // entrySessionId: analistin SDK oturumu — varsa sürdürülür, koşu boyunca güncellenir
  // Bu koşudan önceki olaylar (oturumun eski görevleri) — konuşma kaybolursa özet buradan
  const priorEvents = bus.history.length;
  const sessionStore: NonNullable<Parameters<typeof runWorkflow>[8]> = {
    entrySessionId: entry.sdkSessionId,
    entryContext: entry.contextTokens,
    recap: () => sessionRecap(bus.history.slice(0, priorEvents), cfg.workflow.entry),
    onSession: (id) => o.sessions.setSdkSession(entry.id, id),
    // Panelden koşu sürerken değiştirilebilir — orkestratör plan bitince son halini okur
    autoForward: () => o.sessions.get(entry.id)?.autoForward,
  };

  console.log(`\n🎯 [${entry.name}] Görev: ${display}`);
  // Bu koşunun olayları buradan başlar (TFS'e yazılacak notun kaynağı)
  const firstEvent = bus.history.length;
  try {
    bus.emit({
      type: "workflow_started",
      task: display,
      ...(o.workItem ? { workItem: o.workItem } : {}),
      ...(o.pr ? { pr: o.pr } : {}),
      provider: cfg.provider,
      model: cfg.model,
      effort: cfg.effort,
      targetDir: cwd,
      entry: cfg.workflow.entry,
      maxCycles: cfg.workflow.maxCycles,
      agents: [...agents.keys()],
      resumed,
      ...(o.attachments?.length
        ? { attachments: o.attachments.map(({ name, original }) => ({ name, original })) }
        : {}),
      fanouts: Object.fromEntries(
        Object.entries(cfg.workflow.agents)
          .filter(([, n]) => isFanoutNode(n))
          .map(([key, n]) => [key, (n as { agent: string }).agent]),
      ),
      disabled: Object.entries(cfg.workflow.agents)
        .filter(([, n]) => n.disabled)
        .map(([key]) => key),
    });
    await runWorkflow(
      cfg.workflow,
      agents,
      task + attachmentSection(o.attachments ?? [], o.attachmentIntro),
      cwd,
      cfg,
      bus,
      abortController,
      runtime.web,
      sessionStore,
      o.startAt,
    );
    // Kayıt (JSONL) hâlâ açıkken: yazma olayları da koşunun kaydına girer
    if (o.afterRun) {
      try {
        await o.afterRun(bus.history.slice(firstEvent));
      } catch (e) {
        console.error(`⚠ [${entry.name}] Koşu sonrası adım başarısız:`, e instanceof Error ? e.message : e);
      }
    }
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
    console.warn(
      `⚠ ${msg}\n  Panel yine de açılıyor — üst çubuktaki model listesinden seç (o zamana kadar görev başlatılamaz).`,
    );
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
  // Bağımsız güvenlik denetimleri (/guvenlik sayfasından) — aynı anda çalışan görev sınırına dahil
  const audits = new SecurityAuditRunner({ store: securityReports, runsDir });
  // Aynı anda koşabilecek görev sınırı — Ayarlar'dan canlı değişir, her görevde yeniden okunur
  const maxParallel = () => cfg.maxParallelRuns ?? 3;

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
        // Planı onaysız iletme (oturumda yoksa genel ayar)
        autoForward: e.autoForward ?? !!cfg.workflow.autoForwardPlan,
        // Oturumun hedef dizini (yoksa genel dizin geçerli) ve diskte var mı — panel uyarısı için
        targetDir: e.targetDir,
        dirExists: dirOk(e.targetDir ?? cwd),
        // Analist konuşmasının doluluğu — panelde yaklaşınca uyarı
        ...(e.contextTokens ? { context: { tokens: e.contextTokens, window: ctx?.window, limit: ctx?.limit } } : {}),
        // TFS: oturumun bağlı olduğu iş öğesi (sol listede rozet)
        ...(e.workItem ? { workItem: { id: e.workItem.id, type: e.workItem.type, state: e.workItem.state } } : {}),
        ...(e.pr ? { pr: { id: e.pr.id, mode: e.pr.mode, repository: e.pr.repository } } : {}),
      };
    });

  /**
   * TFS modu: iş bitince sonucu iş öğesine yazar (Ayarlar "kendiliğinden") ya da panele
   * düzenlenebilir taslakla kart açtırır ("sorarak", varsayılan). Yalnızca iyi biten koşuda.
   */
  const tfsAfterRun = async (
    rt: SessionRuntime,
    wi: RunWorkItem,
    events: TimedEvent[],
    entryKey: string,
    runDir: string,
  ) => {
    const mode = cfg.tfs?.writeBack ?? "ask";
    if (!runSucceeded(events) || mode === "off" || !cfg.tfs?.enabled) return;
    const text = writeBackDraft(events, entryKey, runDir, wi.id);
    if (mode !== "auto") {
      const files = runChangedFiles(events, entryKey, runDir);
      rt.bus.emit({
        type: "tfs_writeback",
        id: wi.id,
        title: wi.title,
        workItemType: wi.type,
        state: wi.state,
        url: wi.url,
        text,
        ...(files.length ? { files } : {}),
      });
      return;
    }
    const conn = tfsConnection(cfg.tfs, configRoot);
    if (!conn) {
      rt.bus.emit({
        type: "tfs_written",
        id: wi.id,
        ok: false,
        auto: true,
        error: "TFS bağlantısı ayarlı değil (Ayarlar → TFS modu)",
      });
      return;
    }
    try {
      await writeWorkItem(conn, wi.id, { html: textToTfsHtml(text) });
      rt.bus.emit({ type: "tfs_written", id: wi.id, ok: true, auto: true, url: wi.url });
      console.log(`📌 TFS #${wi.id}: sonuç iş öğesine yazıldı`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      rt.bus.emit({ type: "tfs_written", id: wi.id, ok: false, auto: true, error });
      console.warn(`⚠ TFS #${wi.id}: sonuç yazılamadı — ${error}`);
    }
  };

  /** API çağrıları için PR nesnesi (koşu kaydındaki bilgiden) */
  const prRef = (pr: RunPr): TfsPullRequest =>
    ({
      id: pr.id,
      title: pr.title,
      repository: { id: pr.repositoryId, name: pr.repository, project: pr.project },
    }) as TfsPullRequest;

  /**
   * PR'a yazar: (1) istenirse değişiklikleri commit'leyip PR'ın dalına gönderir — gönderilemezse
   * DURUR (kod gitmeden "düzeltildi" yazılmasın); (2) yorum dizilerine cevap + "düzeltildi";
   * (3) yeni yorumlar (satıra bağlı; olmazsa yeri yazılarak genel yorum); (4) genel yorum.
   */
  const executePrWrite = async (
    pr: RunPr,
    input: PrWriteInput,
    runDir: string,
  ): Promise<Extract<OrchestratorEvent, { type: "tfs_pr_written" }>> => {
    const c = tfsConn();
    const api = prRef(pr);
    const errors: string[] = [];
    let pushed: { branch: string; commit: string } | undefined;
    let replied = 0;
    let resolved = 0;
    let created = 0;
    let general = false;
    const fail = (m: string): Extract<OrchestratorEvent, { type: "tfs_pr_written" }> => ({
      type: "tfs_pr_written",
      id: pr.id,
      ok: false,
      url: pr.url,
      errors: [m],
    });
    if (input.push) {
      if (!input.files?.length) return fail("gönderilecek dosya yok");
      const repo = pr.repoDir ? await openRepo(pr.repoDir, runDir) : undefined;
      if (!repo) return fail("çekme isteğinin bilgisayardaki kopyası bulunamadı — değişiklikler gönderilemedi");
      const branch = await currentBranch(repo.dir).catch(() => "");
      if (branch !== pr.source)
        return fail(
          `bilgisayardaki kopya artık "${branch}" dalında, çekme isteğinin dalı "${pr.source}" — değişiklikler gönderilmedi`,
        );
      try {
        const r = await commitAndPush(
          repo,
          input.files,
          input.message?.trim() || `!${pr.id} inceleme yorumları`,
          await authEnv(c, repo.remoteUrl),
        );
        pushed = { branch: r.branch, commit: r.commit };
        console.log(
          `📤 Çekme isteği !${pr.id}: ${r.files.length} dosya ${r.branch} dalına gönderildi (kayıt ${r.commit.slice(0, 8)})`,
        );
      } catch (e) {
        return fail(`değişiklikler gönderilemedi: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const kisa = pushed ? `\n\n_Kayıt: ${pushed.commit.slice(0, 8)} — ${pushed.branch} dalı_` : "";
    for (const r of input.replies.filter((x) => x.send && (x.text.trim() || x.resolve))) {
      try {
        if (r.text.trim()) {
          await replyToThread(
            c,
            api,
            { id: r.threadId, firstCommentId: r.firstCommentId },
            r.text.trim() + (r.resolve ? kisa : ""),
          );
          replied++;
        }
        if (r.resolve) {
          await setThreadStatus(c, api, r.threadId, "fixed");
          resolved++;
        }
      } catch (e) {
        errors.push(`yorum ${r.threadId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Satır yorumları için son yineleme: dosya isteğin farkında mı, bağlam kimliği (changeTrackingId) ne
    const yazilacak = input.comments.filter((x) => x.send && x.text.trim());
    const it = yazilacak.some((x) => x.file) ? await getIterationChanges(c, api).catch(() => undefined) : undefined;
    const izler = new Map((it?.changes ?? []).map((ch) => [ch.path.toLowerCase(), ch.changeTrackingId]));
    const yerli = (cm: { file?: string; line?: number }) =>
      `\n\n**Yer:** \`${(cm.file ?? "").replace(/^\//, "")}${cm.line ? `:${cm.line}` : ""}\``;
    for (const cm of yazilacak) {
      try {
        const yol = cm.file ? "/" + cm.file.replace(/\\/g, "/").replace(/^\/+/, "") : undefined;
        if (yol && it && !izler.has(yol.toLowerCase())) {
          // Dosya bu isteğin farkında yok — satıra bağlanamaz; yeri yazılarak genel yorum
          await createThread(c, api, cm.text.trim() + yerli(cm));
        } else {
          await createThread(
            c,
            api,
            cm.text.trim(),
            yol
              ? {
                  file: yol,
                  ...(cm.line ? { line: cm.line } : {}),
                  changeTrackingId: izler.get(yol.toLowerCase()),
                  iteration: it?.iteration,
                }
              : undefined,
          );
        }
        created++;
      } catch (e) {
        // Satıra bağlanamadı (dosya/satır PR farkında değil): yeri yazılarak genel yorum
        if (!cm.file) {
          errors.push(`yorum: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        try {
          await createThread(c, api, cm.text.trim() + yerli(cm));
          created++;
        } catch (e2) {
          errors.push(`yorum (${cm.file}): ${e2 instanceof Error ? e2.message : String(e2)}`);
        }
      }
    }
    if (input.general?.trim()) {
      try {
        // Özet bilgi içindir: "kapatıldı" açılır — "yorumlar çözülmeli" kuralı birleştirmeyi kilitlemesin
        await createThread(c, api, input.general.trim() + (input.push ? kisa : ""), undefined, undefined, 4);
        general = true;
      } catch (e) {
        errors.push(`genel yorum: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return {
      type: "tfs_pr_written" as const,
      id: pr.id,
      ok: errors.length === 0,
      url: pr.url,
      ...(pushed ? { pushed } : {}),
      replied,
      resolved,
      created,
      general,
      ...(errors.length ? { errors } : {}),
    };
  };

  /** PR görevi bitince: taslak kartı ("sorarak") ya da hepsini kendiliğinden yazma */
  const tfsPrAfterRun = async (
    rt: SessionRuntime,
    pr: RunPr,
    events: TimedEvent[],
    entryKey: string,
    runDir: string,
  ) => {
    const mode = cfg.tfs?.writeBack ?? "ask";
    if (!runSucceeded(events) || mode === "off" || !cfg.tfs?.enabled) return;
    const draft = prWriteDraft(events, pr, entryKey, runDir);
    if (mode !== "auto") {
      rt.bus.emit({
        type: "tfs_pr_writeback",
        id: pr.id,
        title: pr.title,
        url: pr.url,
        source: pr.source,
        repository: pr.repository,
        ...draft,
      });
      return;
    }
    try {
      const r = await executePrWrite(
        pr,
        {
          push: !!draft.commit,
          message: draft.commit?.message,
          files: draft.commit?.files,
          replies: draft.replies.map((x) => ({ ...x, send: true })),
          comments: draft.comments.map((x) => ({ ...x, send: true })),
          general: draft.general,
        },
        runDir,
      );
      rt.bus.emit({ ...r, auto: true });
    } catch (e) {
      rt.bus.emit({
        type: "tfs_pr_written",
        id: pr.id,
        ok: false,
        auto: true,
        errors: [e instanceof Error ? e.message : String(e)],
      });
    }
  };

  /** Bir oturumda görev başlatır (oturum yoksa açar); arka planda koşar.
   *  tfs: görev bir TFS iş öğesinden ya da çekme isteğinden (ya da oturumun bağlı olduğunun devamı) */
  const launch = (
    task: string,
    entry: SessionEntry | undefined,
    runAt?: number,
    files: FileInput[] = [],
    dir?: string,
    tfs?: { display: string; name?: string; workItem?: RunWorkItem; pr?: RunPr; attachmentIntro?: string },
  ) => {
    // Yeni oturum o anki genel model/derinlik/dizinle (ya da görevle seçilen dizinle) açılır;
    // sonra panelden yalnızca kendisi için değişebilir
    const e =
      entry ??
      sessions.create(
        tfs?.name ?? tfs?.display ?? task,
        cfg.model,
        cfg.effort,
        dir ?? cwd,
        !!cfg.workflow.autoForwardPlan,
      );
    if (tfs?.workItem && !tfs.workItem.inherited) {
      const { id, type, title, state, url, project } = tfs.workItem;
      sessions.setWorkItem(e.id, { id, type, title, state, url, project });
    }
    if (tfs?.pr && !tfs.pr.inherited) {
      const { id, title, url, repository, mode } = tfs.pr;
      sessions.setPr(e.id, { id, title, url, repository, mode });
    }
    // Eski kayıt (dizinsiz): o anki genel dizine sabitlenir — konuşması da o dizinde
    if (!e.targetDir) sessions.setTargetDir(e.id, cwd, true);
    const runDir = e.targetDir ?? cwd;
    const runCfg = snapshotConfig(cfg);
    if (e.model) runCfg.model = e.model;
    if (e.effort) runCfg.effort = e.effort;
    // Oturuma özel planı onaysız iletme genel ayarı ezer (koşunun kendi workflow kopyasında)
    if (e.autoForward !== undefined) {
      if (e.autoForward) runCfg.workflow.autoForwardPlan = true;
      else delete runCfg.workflow.autoForwardPlan;
    }
    const runtime = runtimes.get(e.id, e.runLogs);
    const run = executeRun({
      task,
      attachments: saveFiles(runsDir, e.id, files),
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
      ...(tfs
        ? {
            display: tfs.display,
            ...(tfs.workItem ? { workItem: tfs.workItem } : {}),
            ...(tfs.pr ? { pr: tfs.pr } : {}),
            attachmentIntro: tfs.attachmentIntro,
            afterRun: (events: TimedEvent[]) =>
              tfs.pr
                ? tfsPrAfterRun(runtime, tfs.pr, events, runCfg.workflow.entry, runDir)
                : tfsAfterRun(runtime, tfs.workItem!, events, runCfg.workflow.entry, runDir),
          }
        : {}),
    });
    runtimes.notify();
    return { entry: e, run };
  };

  // ── TFS modu (Ayarlar + panel uçları) ──
  /** Kullanıma hazır bağlantı; değilse açıklamalı hata */
  const tfsConn = () => {
    const c = cfg.tfs?.enabled ? tfsConnection(cfg.tfs, configRoot) : undefined;
    if (!c || !c.project)
      throw new TfsError(
        "TFS modu kapalı ya da ayarları eksik — Ayarlar → TFS modu kartından sunucu, proje ve erişim anahtarını gir",
      );
    return c;
  };
  /** Oturumda yazılmayı bekleyen sonuç (son tfs_writeback; ardından yazıldı/atlandı olayı yoksa) */
  const pendingWriteback = (rt: SessionRuntime) => {
    const h = rt.bus.history;
    for (let i = h.length - 1; i >= 0; i--) {
      const e = h[i];
      if (e.type === "tfs_written" && (e.ok || e.skipped)) return undefined;
      if (e.type === "workflow_started") return undefined;
      if (e.type === "tfs_writeback") return e;
    }
    return undefined;
  };
  /** Oturumda PR'a yazılmayı bekleyen taslak (son tfs_pr_writeback; ardından yazıldı/atlandı yoksa) */
  const pendingPrWriteback = (rt: SessionRuntime) => {
    const h = rt.bus.history;
    for (let i = h.length - 1; i >= 0; i--) {
      const e = h[i];
      if (e.type === "tfs_pr_written" && (e.ok || e.skipped)) return undefined;
      if (e.type === "workflow_started") return undefined;
      if (e.type === "tfs_pr_writeback") {
        // Koşunun PR bilgisi (yerel depo yolu dahil) aynı koşunun başındaki olayda
        for (let j = i; j >= 0; j--) {
          const s = h[j];
          if (s.type === "workflow_started") return s.pr ? { draft: e, pr: s.pr, targetDir: s.targetDir } : undefined;
        }
        return undefined;
      }
    }
    return undefined;
  };
  /** Son koşunun olayları (son workflow_started'dan bu yana) */
  const lastRunEvents = (rt: SessionRuntime) => {
    const h = rt.bus.history;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].type === "workflow_started") return h.slice(i);
    return [];
  };
  /** Koşu bittikten sonra çıkan olay: oturumun son koşu kaydına da yazılır (yeniden başlatınca kart geri gelmesin) */
  const emitAfterRun = (entry: SessionEntry, rt: SessionRuntime, ev: OrchestratorEvent) => {
    const last = entry.runLogs?.[entry.runLogs.length - 1];
    const off = last
      ? rt.bus.subscribe((e) => fs.appendFileSync(path.join(runsDir, last), JSON.stringify(e) + "\n"))
      : () => {};
    try {
      rt.bus.emit(ev);
    } finally {
      off();
    }
  };
  const tfsApi = {
    view: () => tfsView(cfg.tfs, configRoot),
    /** Ayarları kaydeder: config.json "tfs" (anahtar hariç) + anahtar .gizli/'ye; canlı */
    save: async (input: Record<string, unknown>) => {
      const prev = fs.readFileSync(resolvedConfigPath, "utf8");
      try {
        const parsed = JSON.parse(prev) as AppConfig;
        const t: TfsConfig = { ...(parsed.tfs ?? {}) };
        const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : undefined);
        const url = str("url");
        if (url !== undefined) {
          if (url) t.url = url.replace(/\/+$/, "");
          else delete t.url;
        }
        const project = str("project");
        if (project !== undefined) {
          if (project) t.project = project;
          else delete t.project;
        }
        const caFile = str("caFile");
        if (caFile !== undefined) {
          if (caFile) t.caFile = caFile;
          else delete t.caFile;
        }
        if (typeof input.insecureTls === "boolean") {
          if (input.insecureTls) t.insecureTls = true;
          else delete t.insecureTls;
        }
        if (input.writeBack !== undefined) {
          if (!(TFS_WRITE_BACK as readonly unknown[]).includes(input.writeBack))
            return { ok: false, error: "geçersiz yazma ayarı" };
          t.writeBack = input.writeBack as TfsConfig["writeBack"];
        }
        // Anahtar: dolu metin = kaydet, null = sil, boş/yok = olduğu gibi kalsın
        const token = typeof input.token === "string" ? input.token.trim() : input.token === null ? null : undefined;
        if (typeof input.enabled === "boolean") {
          if (input.enabled) t.enabled = true;
          else delete t.enabled;
        }
        const willHaveToken =
          token === null ? !!readTfsToken(configRoot).env : !!token || !!readTfsToken(configRoot).token;
        if (t.enabled && (!t.url || !t.project || !willHaveToken)) {
          return { ok: false, error: "TFS modunu açmak için sunucu adresi, proje ve erişim anahtarı gerekli" };
        }
        if (Object.keys(t).length) parsed.tfs = t;
        else delete parsed.tfs;
        fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
        const c = loadAppConfig(resolvedConfigPath); // doğrulama (adres biçimi, yazma ayarı)
        if (token) writeTfsToken(configRoot, token);
        else if (token === null) writeTfsToken(configRoot, null);
        cfg.tfs = c.tfs; // yeni nesne — çalışan koşunun kopyası etkilenmez
        forgetServer(); // adres/anahtar değişmiş olabilir: sürüm ve durum önbelleği tazelensin
        runtimes.notify();
        // config: dosyaya yazılan "tfs" (anahtarsız) — Ayarlar sayfası kendi kopyasını eşitler
        return { ok: true, view: tfsView(cfg.tfs, configRoot), config: parsed.tfs ?? null };
      } catch (e) {
        fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    /** Bağlantıyı dener (formdaki henüz kaydedilmemiş değerlerle; boş anahtar = kayıtlı anahtar) */
    probe: async (input: Record<string, unknown>) => {
      const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
      const c = tfsConnection(cfg.tfs, configRoot, {
        url: s("url"),
        project: s("project"),
        token: s("token"),
        caFile: s("caFile"),
        ...(typeof input.insecureTls === "boolean" ? { insecureTls: input.insecureTls } : {}),
      });
      if (!c) return { ok: false, error: "sunucu adresi ve erişim anahtarı gerekli" };
      try {
        return { ok: true, probe: await probeTfs(c) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    preview: (id: number) => previewWorkItem(tfsConn(), id),
    mine: (done: boolean) => myWorkItems(tfsConn(), { done }),
    search: (q: string) => searchWorkItems(tfsConn(), q),
    attachment: (guid: string, name: string) => fetchAttachment(tfsConn(), guid, name, 20 * 1024 * 1024),
    /** Yazma kartı için: iş öğesinin güncel durumu ve türünün durumları */
    states: async (sessionId: string) => {
      const e = sessions.get(sessionId);
      const pend = e ? pendingWriteback(runtimes.get(e.id, e.runLogs)) : undefined;
      if (!pend) throw new TfsError("bu oturumda yazılmayı bekleyen sonuç yok");
      const c = tfsConn();
      const [states, now] = await Promise.all([
        getStates({ ...c, project: sessions.get(sessionId)?.workItem?.project || c.project }, pend.workItemType),
        getSummaries(c, [pend.id]).then((m) => m.get(pend.id)),
      ]);
      return { id: pend.id, type: pend.workItemType, current: now?.state ?? pend.state, states };
    },
    /**
     * Sonucu iş öğesine yazar (kartta düzenlenen metin + isteğe bağlı durum). pr.open: önce
     * değişen dosyalar depo başına yeni dala commit'lenip gönderilir ve iş öğesine bağlı çekme
     * isteği açılır; bağlantıları nota eklenir.
     */
    write: async (
      sessionId: string,
      text: string,
      state?: string,
      pr?: { open?: boolean; target?: string; draft?: boolean },
    ) => {
      const e = sessions.get(sessionId);
      if (!e) return { ok: false, error: "oturum bulunamadı" };
      const rt = runtimes.get(e.id, e.runLogs);
      const pend = pendingWriteback(rt);
      if (!pend) return { ok: false, error: "bu oturumda yazılmayı bekleyen sonuç yok" };
      if (!text.trim() && !state && !pr?.open) return { ok: false, error: "yazılacak not boş" };
      let c;
      try {
        c = tfsConn();
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const prs: Array<{
        repo: string;
        id?: number;
        url?: string;
        existed?: boolean;
        branch?: string;
        error?: string;
      }> = [];
      if (pr?.open) {
        const events = lastRunEvents(rt);
        const started = events[0]?.type === "workflow_started" ? events[0] : undefined;
        const runDir = started?.targetDir ?? e.targetDir ?? cwd;
        const { repos } = await groupByRepo(runChangedFiles(events, cfg.workflow.entry, runDir), runDir);
        if (!repos.size)
          return { ok: false, error: "değişen dosyalar bir git deposunda değil — çekme isteği açılamaz" };
        for (const [root, rels] of repos) {
          const repo = await openRepo(root, runDir);
          const label = repo?.rel ?? root;
          if (!repo?.remote) {
            prs.push({ repo: label, error: "uzak depo tanımlı değil" });
            continue;
          }
          let branch: string | undefined;
          try {
            // Depo ve proje: önce sunucuya sorulur (klon adresi/vsts/info); olmazsa adresten çıkarılır
            const uzak = await repoInfoFromRemote(c, repo.remoteUrl);
            const name = uzak?.name ?? repoNameFromRemote(repo.remoteUrl) ?? path.basename(root);
            const project =
              uzak?.project ??
              projectFromRemote(repo.remoteUrl) ??
              (e.workItem?.id === pend.id ? e.workItem.project : undefined) ??
              c.project;
            const info = await getRepository(c, project, uzak?.id ?? name);
            branch = await uniqueBranch(repo, `kurmay/${pend.id}-${slug(pend.title)}`);
            const target = pr.target?.trim() || info.defaultBranch || (await defaultBranch(repo)) || "main";
            const pushed = await commitAndPush(
              repo,
              rels,
              `#${pend.id} ${pend.title}\n\nKurmay — TFS #${pend.id}`,
              await authEnv(c, repo.remoteUrl),
              { newBranch: branch },
            );
            const made = await createPullRequest(c, {
              project,
              repositoryId: info.id,
              repositoryName: info.name,
              source: pushed.branch,
              target,
              title: `#${pend.id} ${pend.title}`,
              description: text,
              workItems: [pend.id],
              draft: !!pr.draft,
            });
            // Eski sunucular (5.0 öncesi) açılışta verilen iş öğesi bağını yok sayabiliyor — bağ ayrıca eklenir
            if ((await serverVersion(c)) < 5 && made.artifactId) {
              await linkArtifact(c, pend.id, made.artifactId, "Pull Request").catch((err) =>
                console.warn(
                  `⚠ TFS #${pend.id}: çekme isteği bağı eklenemedi — ${err instanceof Error ? err.message : err}`,
                ),
              );
            }
            prs.push({
              repo: label,
              id: made.id,
              url: made.webUrl,
              ...(made.existed ? { existed: true } : {}),
              branch: pushed.branch,
            });
            console.log(`🔀 TFS #${pend.id}: çekme isteği !${made.id} (${label}, ${pushed.branch} → ${target})`);
          } catch (err) {
            prs.push({
              repo: label,
              ...(branch ? { branch } : {}),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (prs.every((p) => p.error)) {
          return {
            ok: false,
            error: `çekme isteği açılamadı — ${prs.map((p) => `${p.repo}: ${p.error}`).join("; ")}`,
            prs,
          };
        }
      }
      const prLines = prs.filter((p) => p.id).map((p) => `[!${p.id}](${p.url}) (${p.repo}, dal ${p.branch})`);
      const note = text.trim() + (prLines.length ? `\n\n**Çekme isteği:** ${prLines.join(", ")}` : "");
      try {
        const r = await writeWorkItem(c, pend.id, {
          ...(note.trim() ? { html: textToTfsHtml(note) } : {}),
          ...(state ? { state } : {}),
        });
        emitAfterRun(e, rt, {
          type: "tfs_written",
          id: pend.id,
          ok: true,
          url: pend.url,
          ...(state ? { state: r.state ?? state } : {}),
          ...(prs.length ? { prs } : {}),
        });
        if (state && e.workItem?.id === pend.id) sessions.setWorkItem(e.id, { ...e.workItem, state: r.state ?? state });
        return { ok: true, ...(prs.length ? { prs } : {}) };
      } catch (err) {
        return {
          ok: false,
          error: `${prs.length ? "çekme isteği açıldı ama " : ""}iş öğesine yazılamadı: ${err instanceof Error ? err.message : String(err)}`,
          ...(prs.length ? { prs } : {}),
        };
      }
    },
    // ── Çekme istekleri ──
    /** PR kartı: PR, açık yorumlar, değişen dosyalar, yerel deponun durumu (dir: görevin dizini) */
    prPreview: (id: number, dir?: string) => previewPr(tfsConn(), id, dir && dirOk(dir) ? dir : cwd),
    prMine: () => myPullRequests(tfsConn()),
    /** "Dala geç": yerel depoyu PR'ın kaynak dalına geçirir (çalışma ağacı temizse) */
    prCheckout: async (id: number, dir?: string) => {
      const c = tfsConn();
      const pr = await getPullRequest(c, id);
      const target = dir && dirOk(dir) ? dir : cwd;
      const repo = await findRepo(target, pr.repository.name);
      if (!repo) throw new TfsError(`"${pr.repository.name}" deposu hedef dizinde bulunamadı (${target})`);
      const commit = await checkoutPrBranch(repo, pr.source, await authEnv(c, repo.remoteUrl));
      console.log(`🔀 ${repo.rel}: çekme isteği !${id} dalına geçildi (${pr.source}, kayıt ${commit})`);
      return { branch: pr.source, commit, repo: repo.rel };
    },
    /** PR'a yaz (kartta düzenlenmiş haliyle) */
    prWrite: async (sessionId: string, input: PrWriteInput) => {
      const e = sessions.get(sessionId);
      if (!e) return { ok: false, error: "oturum bulunamadı" };
      const rt = runtimes.get(e.id, e.runLogs);
      const pend = pendingPrWriteback(rt);
      if (!pend) return { ok: false, error: "bu oturumda çekme isteğine yazılmayı bekleyen sonuç yok" };
      const r = await executePrWrite(
        pend.pr,
        { ...input, files: input.push ? pend.draft.commit?.files : undefined },
        pend.targetDir,
      );
      // Kısmen yazıldıysa (ör. bir dizi hata verdi) kart kapanır, hatalar akışta görünür; hiçbir şey
      // yazılamadıysa kart açık kalır, tekrar denenebilir
      const any = !!(r.pushed || r.replied || r.resolved || r.created || r.general);
      if (r.ok || any) emitAfterRun(e, rt, { ...r, ok: true });
      return r.ok ? { ok: true } : { ok: any, error: (r.errors ?? []).join("; ") };
    },
    prDismiss: (sessionId: string) => {
      const e = sessions.get(sessionId);
      if (!e) return { ok: false, error: "oturum bulunamadı" };
      const rt = runtimes.get(e.id, e.runLogs);
      const pend = pendingPrWriteback(rt);
      if (!pend) return { ok: false, error: "bu oturumda çekme isteğine yazılmayı bekleyen sonuç yok" };
      emitAfterRun(e, rt, { type: "tfs_pr_written", id: pend.pr.id, ok: false, skipped: true });
      return { ok: true };
    },
    /** "Şimdilik yazma": kart kapanır, geçmişte de kapalı kalır */
    dismiss: (sessionId: string) => {
      const e = sessions.get(sessionId);
      if (!e) return { ok: false, error: "oturum bulunamadı" };
      const rt = runtimes.get(e.id, e.runLogs);
      const pend = pendingWriteback(rt);
      if (!pend) return { ok: false, error: "bu oturumda yazılmayı bekleyen sonuç yok" };
      emitAfterRun(e, rt, { type: "tfs_written", id: pend.id, ok: false, skipped: true });
      return { ok: true };
    },
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

  /** Oturumda bekleyen onay kartı iletilebilir bir plan mı (dolu file_plan, akışı bitirmiyor) —
   *  öyleyse "onaysız ilet" seçilince onay ayar adına verilir */
  const forwardPendingPlan = (sessionId: string): boolean => {
    const rt = runtimes.peek(sessionId);
    if (!rt || rt.status !== "approval") return false;
    const h = rt.bus.history;
    let last: (typeof h)[number] | undefined;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].type === "approval_required") {
        last = h[i];
        break;
      }
    }
    if (!last || last.type !== "approval_required" || last.endsFlow) return false;
    const plan = (last.structured as { file_plan?: unknown } | undefined)?.file_plan;
    if (!Array.isArray(plan) || plan.length === 0) return false;
    return rt.resolveApproval({ approved: true, auto: true });
  };

  /** Planı otomatik iletme: session verilirse yalnızca o oturum (config.json'a dokunmaz),
   *  yoksa genel ayar (Ayarlar) — config.json'a yazar, yeni oturumlar bunu alır */
  const setAutoForward = (enabled: boolean, sessionId?: string): { ok: boolean; error?: string; enabled?: boolean } => {
    if (sessionId) {
      if (!sessions.setAutoForward(sessionId, enabled)) return { ok: false, error: "oturum bulunamadı" };
      // Onay kartı şu an açıksa ve ayar "onaysız ilet"e çevrildiyse bekleyen planı hemen
      // ilet — ayar son haliyle davransın (plan dolu, bilgi cevabı değil)
      const forwarded = enabled ? forwardPendingPlan(sessionId) : false;
      runtimes.notify();
      return { ok: true, enabled, ...(forwarded ? { forwarded } : {}) };
    }
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

  /** Aynı anda koşabilecek görev sınırı (Ayarlar): config.json'a yazar, sıradaki görevde geçerli.
   *  Düşürmek çalışanları durdurmaz — yalnızca sayı sınırın altına inene dek yeni görev reddedilir */
  const setMaxParallel = (value: number): { ok: boolean; error?: string; value?: number } => {
    const prev = fs.readFileSync(resolvedConfigPath, "utf8");
    try {
      const parsed = JSON.parse(prev) as AppConfig;
      parsed.maxParallelRuns = value;
      fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
      loadAppConfig(resolvedConfigPath); // 1 veya daha büyük tam sayı mı
      cfg.maxParallelRuns = value;
      return { ok: true, value };
    } catch (e) {
      fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  /** Planı uzak ajana gönderme adresi (Ayarlar): config.json'a yazar, hemen geçerli. Boş adres = kaldır;
   *  boş anahtar = anahtarsız */
  const setPlanWebhook = (url: string, apiKey: string): { ok: boolean; error?: string } => {
    const prev = fs.readFileSync(resolvedConfigPath, "utf8");
    const u = url.trim();
    const k = apiKey.trim();
    try {
      const parsed = JSON.parse(prev) as AppConfig;
      if (u) parsed.planWebhook = { url: u, ...(k ? { apiKey: k } : {}) };
      else delete parsed.planWebhook;
      fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
      loadAppConfig(resolvedConfigPath); // adres http(s) mi
      if (parsed.planWebhook) cfg.planWebhook = parsed.planWebhook;
      else delete cfg.planWebhook;
      return { ok: true };
    } catch (e) {
      fs.writeFileSync(resolvedConfigPath, prev); // geçersizse geri al
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  /** Kullanıcı talimatı (Ayarlar): config.json'a yazar, sıradaki görevde her ajanın prompt'una eklenir */
  const setUserPrompt = (text: string): { ok: boolean; error?: string; text?: string } => {
    const prev = fs.readFileSync(resolvedConfigPath, "utf8");
    const value = text.trim();
    try {
      const parsed = JSON.parse(prev) as AppConfig;
      if (value) parsed.userPrompt = value;
      else delete parsed.userPrompt;
      fs.writeFileSync(resolvedConfigPath, JSON.stringify(parsed, null, 2));
      loadAppConfig(resolvedConfigPath); // yapı doğrulaması
      // Çalışan koşu kendi cfg kopyasıyla devam eder
      if (value) cfg.userPrompt = value;
      else delete cfg.userPrompt;
      return { ok: true, text: value };
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
  const SEC_PERSONA = ".claude/agents/guvenlik.md";
  /** Rol tanımı / hook şablonu çalışma klasöründe yoksa paketten kopyalar; dosya varsa true */
  const ensureTemplate = (rel: string): boolean => {
    const abs = path.join(configRoot, rel);
    if (fs.existsSync(abs)) return true;
    const src = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), rel);
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(src, abs);
    return true;
  };
  /** Onay/red kararı veren inceleme adımı (öncelik "teftis") — denetçi onun ayarlarını alır */
  const inspectorKey = (): string | undefined => {
    const verdicts = Object.keys(cfg.workflow.agents).filter(
      (k) => (cfg.workflow.agents[k] as { verdict?: unknown }).verdict,
    );
    return verdicts.includes("teftis") ? "teftis" : verdicts[0];
  };
  /** Denetçi düğümü (geçişsiz): Teftiş'in eklentileri ve kuralları; dosya yazan araç yok,
   *  salt okunur hook'u (dosyası varsa) — akışa eklerken de bağımsız denetimde de aynısı */
  const securityNode = (insp?: { tools?: string[]; rules?: string[] }) => ({
    file: SEC_PERSONA,
    tools: ["Read", "Glob", "Grep", ...(insp?.tools ?? []).filter((t) => t.startsWith("mcp__"))],
    ...(insp?.rules?.length ? { rules: [...insp.rules] } : {}),
    ...(ensureTemplate(".claude/hooks/guard-readonly.js")
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
  });

  /**
   * Bağımsız denetimin ajanı: akıştaki denetçi düğümü (akışta kapalı olsa da). Akışta yoksa
   * aynı ayarlarla geçici bir tanım kurulur — config.json'a yazılmaz, akış değişmez.
   */
  const auditAgent = (): AgentDefinition | { error: string } => {
    const nodes = cfg.workflow.agents;
    const key = Object.keys(nodes).find((k) => (nodes[k] as { securityReport?: boolean }).securityReport);
    const existing = key && agents.get(key);
    if (existing) return existing;
    if (!ensureTemplate(SEC_PERSONA)) return { error: `denetçinin rol tanımı bulunamadı: ${SEC_PERSONA}` };
    const insp = inspectorKey();
    const node = securityNode(insp ? (nodes[insp] as { tools?: string[]; rules?: string[] }) : undefined);
    // loadAppConfig'in yaptığı gibi: hook komutundaki ${configDir} = config.json'ın klasörü
    for (const h of node.hooks ?? []) h.command = h.command.split("${configDir}").join(configRoot.replace(/\\/g, "/"));
    try {
      const wf = {
        entry: "guvenlik",
        maxCycles: 1,
        agents: { guvenlik: { ...node, next: null } },
      } as unknown as WorkflowConfig;
      const def = loadAgents(wf, configRoot, offOf(cfg)).get("guvenlik");
      return def ?? { error: "denetçi yüklenemedi" };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

  /** Bağımsız denetimi başlatır (/guvenlik sayfası): seçilen dizindeki kod tabanının tamamı */
  const startAudit = (dir: string): { ok: boolean; error?: string; job?: unknown } => {
    const resolvedDir = path.resolve(dir);
    if (!dirOk(resolvedDir)) return { ok: false, error: `dizin bulunamadı: ${resolvedDir}` };
    if (modelMissing(cfg))
      return { ok: false, error: "Model seçilmedi — izleme panelindeki model listesinden bir model seç" };
    if (audits.runningIn(resolvedDir)) return { ok: false, error: "Bu dizinde zaten bir denetim sürüyor" };
    if (runtimes.busy().length + audits.running() >= maxParallel()) {
      return {
        ok: false,
        error: `Aynı anda en fazla ${maxParallel()} görev çalışabilir (panel görevleri dahil) — biri bitince tekrar dene ya da Ayarlar sayfasından artır`,
      };
    }
    const agent = auditAgent();
    if ("error" in agent) return { ok: false, error: agent.error };
    // Kopya: Ayarlar'dan canlı değişen alanlar süren denetimi etkilemesin
    return { ok: true, job: audits.start(resolvedDir, agent, snapshotConfig(cfg)) };
  };

  /** Sayfadaki dizin önerileri: genel dizin, oturumların ve önceki denetimlerin dizinleri */
  const auditDirs = (): string[] => {
    const dirs = [cwd, ...audits.list().map((j) => j.dir), ...sessions.all().map((s) => s.targetDir ?? "")];
    return [...new Set(dirs.filter((d) => d && dirOk(d)))].slice(0, 10);
  };

  const addSecurityAudit = (): { ok: boolean; error?: string; key?: string; node?: unknown; attachedTo?: string } => {
    const nodes = cfg.workflow.agents;
    const disk = () => JSON.parse(fs.readFileSync(resolvedConfigPath, "utf8")) as AppConfig;
    const existing = Object.keys(nodes).find((k) => (nodes[k] as { securityReport?: boolean }).securityReport);
    if (existing) {
      const r = setNodeDisabled(existing, false);
      return r.ok ? { ok: true, key: existing, node: disk().workflow.agents[existing] } : r;
    }
    // Bağlanacak yer: onay/red kararı veren inceleme adımı (öncelik "teftis")
    const inspector = inspectorKey();
    if (!inspector) {
      return {
        ok: false,
        error: "akışta onay/red kararı veren bir inceleme adımı yok — denetçi Teftiş onayından sonra çalışır",
      };
    }
    if (!ensureTemplate(SEC_PERSONA)) return { ok: false, error: `denetçinin rol tanımı bulunamadı: ${SEC_PERSONA}` };

    let key = "guvenlik";
    for (let i = 2; nodes[key]; i++) key = `guvenlik-${i}`;
    const prev = fs.readFileSync(resolvedConfigPath, "utf8");
    try {
      const parsed = JSON.parse(prev) as AppConfig;
      const insp = parsed.workflow?.agents?.[inspector] as
        { tools?: string[]; rules?: string[]; verdict?: { onApprove: string | null } } | undefined;
      if (!insp?.verdict) return { ok: false, error: `düğüm ayar dosyasında yok: ${inspector}` };
      const node = { ...securityNode(insp), next: insp.verdict.onApprove ?? null };
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
    const skillNames = new Set(
      lsClaude("skills")
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
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
          .filter(([, n]) =>
            (n as { tools?: string[] }).tools?.some((t) => t === `mcp__${name}` || t.startsWith(`mcp__${name}__`)),
          )
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
      return {
        ok: false,
        error: `eklenti bulunamadı: ${name} (ayar dosyasına yeni eklendiyse servisi yeniden başlat)`,
      };
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
        nextMcp = {
          ...cfg.mcpServers,
          [name]: disabled ? { ...rest, disabled: true } : rest,
        } as AppConfig["mcpServers"];
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
      runsDir,
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
        const skills = ls("skills")
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
        const agentMds = ls("agents")
          .filter((e) => e.isFile() && e.name.endsWith(".md"))
          .map((e) => e.name.replace(/\.md$/, ""));
        return { raw, rules, skills, agents: agentMds };
      },
      createAgentMd: (name) => {
        // path traversal'a karşı ad temizlenir; yalnızca .claude/agents altına yazılır
        const safe = String(name)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "-")
          .replace(/^-+|-+$/g, "");
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
        const context = {
          compactPercent: compactPercent(cfg),
          fallbackWindow: cfg.limits?.contextTokens ?? null,
          reserve: cfg.limits?.maxOutputTokens ?? null,
        };
        if (!cfg.modelsUrl) {
          return {
            current,
            required,
            effort,
            context,
            models: [],
            error: "model listesi adresi tanımlı değil — ⚙ Ayarlar sayfasındaki Bağlantı bölümünden ekle",
          };
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
        planWebhook: !!cfg.planWebhook?.url,
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
      setMaxParallel,
      setUserPrompt,
      setPlanWebhook,
      getPlanTarget: () => (cfg.planWebhook?.url ? cfg.planWebhook : undefined),
      search: (q, session, kind) => {
        const list = session ? sessions.all().filter((s) => s.id === session) : sessions.all();
        // Bellekteki oturumda panelin oynattığı geçmişin kendisi aranır (olay sırası birebir aynı)
        const sources = list.map((s) => ({
          id: s.id,
          name: s.name,
          updatedAt: s.updatedAt,
          targetDir: s.targetDir,
          runLogs: s.runLogs ?? [],
          history: runtimes.peek(s.id)?.bus.history,
        }));
        return searchSessions(runsDir, sources, q, session ? { kind, perSession: 300 } : { kind });
      },
      addSecurityAudit,
      getToggles,
      listSecurityReports: () => securityReports.list(),
      ...(task
        ? {} // CLI görevli modda bağımsız denetim de başlatılmaz (servis görev bitince kapanır)
        : {
            listAudits: () => ({ jobs: audits.list(), dirs: auditDirs(), defaultDir: cwd, model: cfg.model ?? "" }),
            startAudit,
            cancelAudit: (id: string) => audits.cancel(id),
          }),
      getSecurityReport: (id) => securityReports.get(id),
      // TFS uçları CLI görevli modda da okunabilir (Ayarlar); görev yalnızca sunucu modunda
      tfs: tfsApi,
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
        : async (t, sessionId, runAt, files, targetDir, workItemId, prId, prMode) => {
            const existing = sessionId ? sessions.get(sessionId) : undefined;
            if (modelMissing({ ...cfg, model: existing?.model || cfg.model })) {
              return { ok: false, error: "Model seçilmedi — üst çubuktaki model listesinden bir model seç" };
            }
            const entry = sessionId ? sessions.get(sessionId) : undefined;
            if (sessionId && !entry) return { ok: false, error: "oturum bulunamadı" };
            // Görevle seçilen dizin > oturumun dizini > genel dizin (yeni oturum)
            const chosen = targetDir ? path.resolve(targetDir) : undefined;
            const dir = chosen ?? entry?.targetDir ?? cwd;
            /** Başlatma koşulları — TFS'ten okuma sürerken başka görev başlamış olabilir, sonra yine bakılır */
            const blocked = (): string | undefined => {
              if (!dirOk(dir)) {
                return chosen
                  ? `Seçilen dizin bulunamadı: ${dir} — görev kutusundaki 📁 ile başka bir dizin seç`
                  : `Hedef dizin bulunamadı: ${dir} — sağdaki hedef dizine tıklayıp geçerli bir dizin seç`;
              }
              if (entry && runtimes.get(entry.id, entry.runLogs).busy) {
                return "Bu oturumda zaten bir görev çalışıyor — bitmesini bekle ya da yeni oturum aç";
              }
              if (runtimes.busy().length + audits.running() >= maxParallel()) {
                return (
                  `Aynı anda en fazla ${maxParallel()} görev çalışabilir` +
                  `${audits.running() ? " (bağımsız güvenlik denetimleri dahil)" : ""} — biri bitince tekrar dene ya da Ayarlar sayfasından artır`
                );
              }
              return undefined;
            };
            const why = blocked();
            if (why) return { ok: false, error: why };

            // TFS: iş öğesi seçildiyse görev ondan kurulur (okuma + eklerin indirilmesi birkaç saniye
            // sürebilir); seçilmediyse ve oturum bir iş öğesine bağlıysa görev onun devamıdır
            let agentTask = t;
            let tfsFiles: FileInput[] = [];
            let tfs: Parameters<typeof launch>[5];
            if (workItemId !== undefined) {
              let conn;
              try {
                conn = tfsConn();
              } catch (e) {
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
              }
              let prepared;
              try {
                prepared = await prepareWorkItemTask(conn, workItemId, t);
              } catch (e) {
                return { ok: false, error: `TFS: ${e instanceof Error ? e.message : String(e)}` };
              }
              const again = blocked();
              if (again) return { ok: false, error: again };
              agentTask = prepared.text;
              tfsFiles = prepared.files;
              const label = workItemLabel(prepared.meta);
              tfs = {
                display: t.trim() ? `${label}\n${t.trim()}` : label,
                workItem: {
                  ...prepared.meta,
                  // Ekranda ve aramada yalnızca iş öğesinin içeriği; ajan talimatı ajana gider
                  text: prepared.display,
                  ...(t.trim() ? { note: t.trim() } : {}),
                  ...(prepared.skipped.length ? { skipped: prepared.skipped } : {}),
                },
                attachmentIntro:
                  `TFS iş öğesindeki ekler ve metindeki görseller (${prepared.files.length} dosya)` +
                  `${files?.length ? `, ayrıca kullanıcının verdiği ${files.length} dosya` : ""}.`,
              };
              console.log(`📌 TFS #${prepared.meta.id} alındı: ${prepared.meta.title} (${prepared.files.length} ek)`);
            } else if (prId !== undefined) {
              let conn;
              try {
                conn = tfsConn();
              } catch (e) {
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
              }
              let prepared;
              try {
                prepared = await preparePrTask(conn, prId, prMode ?? "yorum", dir, t);
              } catch (e) {
                return { ok: false, error: `TFS: ${e instanceof Error ? e.message : String(e)}` };
              }
              const again = blocked();
              if (again) return { ok: false, error: again };
              agentTask = prepared.text;
              tfs = {
                display: t.trim() ? `${prepared.label}\n${t.trim()}` : prepared.label,
                name: prepared.label,
                pr: { ...prepared.meta, text: prepared.display, ...(t.trim() ? { note: t.trim() } : {}) },
              };
              console.log(
                `🔀 TFS !${prepared.meta.id} alındı (${prepared.meta.mode === "incele" ? "inceleme" : `${prepared.meta.threads?.length ?? 0} açık yorum`})`,
              );
            } else if (entry?.pr && tfsReady(cfg.tfs, configRoot)) {
              // Oturumun PR'ının devamı: aynı dalda çalışılır, sonuç aynı PR'a yazılır
              let prepared;
              try {
                prepared = await preparePrFollowUp(tfsConn(), entry.pr.id, dir, t);
              } catch (e) {
                return { ok: false, error: `TFS: ${e instanceof Error ? e.message : String(e)}` };
              }
              const again = blocked();
              if (again) return { ok: false, error: again };
              agentTask = prepared.text;
              tfs = { display: t, pr: { ...prepared.meta, inherited: true } };
            } else if (entry?.workItem && tfsReady(cfg.tfs, configRoot)) {
              const w = entry.workItem;
              agentTask = `Bu görev, bu oturumda üzerinde çalışılan TFS #${w.id} — "${w.title}" iş öğesinin devamıdır.\n\n${t}`;
              tfs = { display: t, workItem: { ...w, inherited: true } };
            }
            const busy = runtimes.busy();
            // Aynı dizine iki akış aynı anda yazarsa birbirini ezer — engellemiyoruz
            // (salt okunur bilgi soruları zararsız) ama açıkça uyarıyoruz
            const clash = busy.find((r) => r.cwd === dir);
            // Var olan oturum başka dizinde sürecekse dizini değişir — Analist'in konuşması eski
            // dizine bağlı olduğu için o oturumda yeni konuşmayla başlar (sağdaki dizin seçiciyle aynı)
            let resetResume = false;
            const dirChanged = !!(entry && chosen && (entry.targetDir ?? cwd) !== chosen);
            if (entry && chosen && dirChanged) {
              resetResume = sessions.setTargetDir(entry.id, chosen).resetResume;
              runtimes.notify();
            }
            const { entry: e, run } = launch(agentTask, entry, runAt, [...tfsFiles, ...(files ?? [])], chosen, tfs);
            run.catch((err) => console.error(`💥 [${e.name}] Koşu hatası:`, err instanceof Error ? err.message : err));
            return {
              ok: true,
              session: e.id,
              ...(tfs ? { display: tfs.display } : {}),
              ...(dirChanged ? { dirChanged: dir, resetResume } : {}),
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
        console.log(
          `🔌 Eklentiler: ${list.map((s) => `${s.name} ${s.status === "connected" ? "✓" : `✗ (${s.error ?? s.status})`}`).join(" · ")}`,
        );
      });
    }
  }

  console.log(
    `🔌 Sağlayıcı: ${cfg.provider}${cfg.baseUrl ? ` (${cfg.baseUrl})` : ""}${cfg.model ? ` | model: ${cfg.model}` : ""}`,
  );
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
  console.log(`⏳ Görev bekleniyor — panelden girebilirsin (aynı anda en fazla ${maxParallel()}).`);
}

main().catch((err) => {
  console.error("\n💥 Hata:", err instanceof Error ? err.message : err);
  process.exit(1);
});
