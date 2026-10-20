import path from "node:path";
import { askUserApproval, fmtDate, waitForScheduledTime, type WebApprovalChannel } from "./approval.js";
import { runBuild } from "./build.js";
import type { EventBus } from "./events.js";
import { extractVerdict } from "./verdict.js";
import { runAgent } from "./runAgent.js";
import {
  isCommandNode,
  isFanoutNode,
  passThroughTarget,
  ReviewVerdictSchema,
  RunCancelledError,
  type AgentDefinition,
  type AgentNodeConfig,
  type AgentRunResult,
  type FanoutNodeConfig,
  type ProviderConfig,
  type ReviewVerdict,
  type WorkflowConfig,
  type WorkflowNode,
} from "./types.js";

interface AgentOutput {
  name: string;
  result: AgentRunResult;
}

interface RunContext {
  task: string;
  /** Her ajanın en güncel çıktısı — sonraki ajanların prompt'una enjekte edilir */
  outputs: Map<string, AgentOutput>;
  /** Reject döngüsünden veya kullanıcı reddinden gelen düzeltme talebi */
  feedback?: string;
  /** En son structured çıktıdaki değişen dosya yolları — build düğümü kullanır */
  changedFiles: string[];
  /** Fanout düğümü → repo → o repo kopyasının son sonucu. Red turunda yalnızca
   *  geri bildirimde adı geçen repolar yeniden koşar; diğerlerinin sonucu buradan
   *  birleşik çıktıya taşınır. */
  fanout: Map<string, Map<string, AgentRunResult>>;
  /** Bu koşuda devre dışı olduğu için atlanan düğümler — sonraki ajanlar
   *  onlardan çıktı gelmeyeceğini bilsin (ör. analist kapalıysa plan yok) */
  skipped: string[];
}

/**
 * Rota çözümü (saf): structured çıktıdaki `field` değerine göre hedef düğümü
 * seçer. Değer string değilse veya cases'te yoksa default'a (o da yoksa akışın
 * sonuna) düşer. value = okunan rota değeri (belirsizse null).
 */
export function resolveRoute(
  routes: NonNullable<AgentNodeConfig["routes"]>,
  structured: unknown,
): { target: string | null; value: string | null } {
  const raw = (structured as Record<string, unknown> | undefined)?.[routes.field];
  const value = typeof raw === "string" ? raw : null;
  const target = value != null && value in routes.cases ? routes.cases[value] : routes.default ?? null;
  return { target, value };
}

/** Bir ajanın structured çıktısından değişen dosya yollarını çıkarır (varsa) */
function changedFilesOf(result: AgentRunResult): string[] | null {
  const s = result.structured as { changes?: unknown } | undefined;
  if (!s || !Array.isArray(s.changes)) return null;
  const files = s.changes
    .map((c) => (c && typeof c === "object" ? (c as { file?: unknown }).file : undefined))
    .filter((f): f is string => typeof f === "string" && f.length > 0);
  return files;
}

/** Ajanın çıktı şemasında plan (file_plan) var mı — otomatik iletme yalnızca planlara uygulanır */
function producesPlan(agent: AgentDefinition): boolean {
  const props = (agent.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return !!props && "file_plan" in props;
}

/** Onay/aktarım için görünüm: yapılandırılmış çıktı varsa okunur JSON, yoksa metin */
function outputView(result: AgentRunResult): string {
  return result.structured !== undefined
    ? JSON.stringify(result.structured, null, 2)
    : result.text;
}

function buildPrompt(agent: AgentDefinition, ctx: RunContext): string {
  const parts: string[] = [`# Görev\n${ctx.task}`];

  // Ajanlar birbirleriyle yapılandırılmış format üzerinden konuşur:
  // önceki ajanın çıktısı varsa şemalı JSON olarak enjekte edilir
  for (const [key, entry] of ctx.outputs) {
    if (key === agent.key) continue;
    if (entry.result.structured !== undefined) {
      parts.push(
        `# "${entry.name}" ajanının çıktısı (yapılandırılmış JSON)\n` +
          "```json\n" + JSON.stringify(entry.result.structured, null, 2) + "\n```",
      );
    } else {
      parts.push(`# "${entry.name}" ajanının çıktısı\n${entry.result.text}`);
    }
  }

  if (ctx.feedback) {
    parts.push(`# Düzeltilmesi gerekenler (öncelikli)\n${ctx.feedback}`);
  }

  // Kullanıcı bazı adımları kapattıysa (ör. küçük iş için planlamasız akış),
  // ajan beklediği girdiyi aramasın: görevi doğrudan kendisi ele alsın
  if (ctx.skipped.length > 0) {
    parts.push(
      `# Not: atlanan adımlar\nBu koşuda şu adımlar kullanıcı tarafından devre dışı bırakıldı: ` +
        `${ctx.skipped.join(", ")}. Onlardan çıktı (ör. plan) gelmeyecek — görevi yukarıdaki ` +
        `açıklamadan doğrudan ele al; kendi kapsamını ve yaklaşımını sen belirle.`,
    );
  }

  parts.push("Rolünün gerektirdiği işi yap.");
  return parts.join("\n\n");
}

/** Dosyanın reposu: targetDir altındaki en üst klasör (build.ts ile aynı kural); kökteki dosyalar "." */
function repoOfPath(file: string, cwd: string): string | null {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/);
  return parts.length > 1 ? parts[0] : ".";
}

/** En son file_plan taşıyan çıktı (analist planı) — dağıtım bunu mıntıkalara böler */
function findPlan(ctx: RunContext): { key: string; plan: unknown[] } | null {
  let found: { key: string; plan: unknown[] } | null = null;
  for (const [key, entry] of ctx.outputs) {
    const fp = (entry.result.structured as { file_plan?: unknown } | undefined)?.file_plan;
    if (Array.isArray(fp)) found = { key, plan: fp };
  }
  return found;
}

/** Geri bildirim metni bu repoyu anıyor mu (yol başı, tırnaklı ad ya da köşeli etiket) */
function mentionsRepo(feedback: string, repo: string): boolean {
  const r = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Sol sınırda / ve \ YOK: yol ortasındaki klasör (ör. ".../src/...") repo sayılmasın.
  // Eşleşme bulunamazsa çağıran tüm repoları yeniden koşturur (güvenli taraf).
  return new RegExp(`(^|[\\s"'\`\\[(])${r}([/\\\\"'\`\\]):\\s]|$)`, "m").test(feedback);
}

/** En fazla `limit` iş aynı anda; iptal edildiyse yeni iş başlatmaz */
async function runLimited<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      if (signal.aborted) {
        results[i] = { status: "rejected", reason: new RunCancelledError() };
        continue;
      }
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  const width = Math.max(1, Math.min(limit > 0 ? limit : items.length, items.length));
  await Promise.all(Array.from({ length: width }, lane));
  return results;
}

/**
 * Kopyaların sonuçlarını tek çıktıda birleştirir (sonraki düğümler — inceleme,
 * build — tek bir saha çıktısı görür). Diziler birleşir, metin alanları repo
 * etiketiyle satır satır toplanır. changes[].file yolları targetDir'e göre
 * normalize edilir; yapılandırılmış çıktısı gelmeyen repo için bir işaretçi
 * eklenir — yoksa build düğümü o repoyu hiç derlemezdi.
 */
function mergeWorkerResults(parts: Array<[string, AgentRunResult]>): AgentRunResult {
  const merged: Record<string, unknown> = {};
  for (const [repo, res] of parts) {
    const st = res.structured as Record<string, unknown> | undefined;
    if (!st || typeof st !== "object") {
      const arr = (merged.changes as unknown[] | undefined) ?? (merged.changes = []) as unknown[];
      arr.push({ file: repo === "." ? "." : `${repo}/`, action: "modified", summary: "(yapılandırılmış çıktı yok — ayrıntı metinde)" });
      continue;
    }
    for (const [k, v] of Object.entries(st)) {
      if (Array.isArray(v)) {
        const items = v.map((item) => {
          if (typeof item === "string") return `[${repo}] ${item}`;
          if (k === "changes" && item && typeof item === "object" && repo !== ".") {
            const f = (item as { file?: unknown }).file;
            if (typeof f === "string" && !path.isAbsolute(f) && !f.replace(/\\/g, "/").startsWith(`${repo}/`)) {
              return { ...item, file: `${repo}/${f}` };
            }
          }
          return item;
        });
        merged[k] = [...((merged[k] as unknown[] | undefined) ?? []), ...items];
      } else if (typeof v === "string") {
        merged[k] = merged[k] ? `${merged[k]}\n[${repo}] ${v}` : `[${repo}] ${v}`;
      } else if (!(k in merged)) {
        merged[k] = v;
      }
    }
  }
  return {
    text: parts.map(([repo, r]) => `## ${repo}\n${r.text}`).join("\n\n"),
    structured: merged,
  };
}

/**
 * Fanout düğümü: planı repolara böler, ajanın repo başına kopyalarını koşturur.
 * Sıra: parent (varsa ve plandaysa) tek başına → diğer repolar eş zamanlı
 * (maxConcurrency sınırıyla) → kökteki dosyalar (".") en sonda tek başına (yazma
 * kapsamı tüm dizin olduğu için kimseyle aynı anda koşamaz). Plan yoksa ya da
 * tek repoya dokunuyorsa ajan tek kez normal koşar.
 */
async function runFanout(
  nodeKey: string,
  node: FanoutNodeConfig,
  agents: Map<string, AgentDefinition>,
  ctx: RunContext,
  cwd: string,
  cfg: ProviderConfig,
  bus: EventBus,
  abortController: AbortController,
): Promise<AgentRunResult> {
  const agent = agents.get(node.agent)!;
  const plan = findPlan(ctx);
  const groups = new Map<string, unknown[]>();
  for (const item of plan?.plan ?? []) {
    const p = (item as { path?: unknown } | null)?.path;
    if (typeof p !== "string" || !p) continue;
    const repo = repoOfPath(p, cwd) ?? ".";
    (groups.get(repo) ?? groups.set(repo, []).get(repo)!).push(item);
  }

  if (!plan || groups.size <= 1) {
    const why = !plan ? "plan (file_plan) bulunamadı" : "plan tek repoya dokunuyor";
    console.log(`\n🔀 ${nodeKey}: ${why} — ${agent.name} tek kopya koşuyor`);
    bus.emit({ type: "agent_text", agent: agent.key, text: `🔀 ${why} — dağıtım gerekmedi, tek kopya` });
    return runAgent(agent, buildPrompt(agent, ctx), cwd, cfg, bus, abortController);
  }

  const prev = ctx.fanout.get(nodeKey) ?? new Map<string, AgentRunResult>();
  ctx.fanout.set(nodeKey, prev);
  let repos = [...groups.keys()];
  // Red/build turu: yalnızca geri bildirimde adı geçen (ve daha önce koşmuş) repolar
  let partial = false;
  if (ctx.feedback && prev.size > 0) {
    const hit = repos.filter((r) => r !== "." && mentionsRepo(ctx.feedback!, r));
    const fresh = repos.filter((r) => !prev.has(r)); // plan değiştiyse yeni repolar da koşar
    const pick = [...new Set([...hit, ...fresh])];
    if (pick.length > 0 && pick.length < repos.length) {
      repos = pick;
      partial = true;
    }
  }

  const workerKey = (repo: string) => `${agent.key}@${repo}`;
  const maxConcurrency = node.maxConcurrency ?? 0;
  bus.emit({
    type: "fanout_started",
    node: nodeKey,
    agent: agent.key,
    workers: repos.map((repo) => ({ key: workerKey(repo), repo })),
    maxConcurrency,
    partial,
  });
  console.log(
    `\n🔀 ${nodeKey}: ${agent.name} ${repos.length} repoya dağıtılıyor (${repos.join(", ")})` +
      `${maxConcurrency ? ` — aynı anda en fazla ${maxConcurrency}` : ""}${partial ? " [yalnızca geri bildirimdeki repolar]" : ""}`,
  );

  const others = (repo: string) => [...groups.keys()].filter((r) => r !== repo);
  const runOne = (repo: string): Promise<AgentRunResult> => {
    const clone: AgentDefinition = { ...agent, key: workerKey(repo), name: `${agent.name} · ${repo}` };
    // Plan yalnızca bu repo dilimiyle; prompt'un geri kalanı (görev, geri bildirim) ortak
    const outputs = new Map(ctx.outputs);
    const src = outputs.get(plan.key)!;
    outputs.set(plan.key, {
      name: src.name,
      result: { ...src.result, structured: { ...(src.result.structured as object), file_plan: groups.get(repo) } },
    });
    const scopeNote = repo === "."
      ? `# Mıntıkan\nBu görev mıntıka (repo) başına bölündü; sana düşen kısım hedef dizinin KÖKÜNDEKİ dosyalar ` +
        `(merkez mıntıka; yukarıdaki plan yalnızca onları içeriyor). Mıntıka klasörlerine (${others(repo).join(", ")}) dokunma — ` +
        `onlar başka saha ajanlarına atandı.`
      : `# Mıntıkan\nBu görev mıntıka (repo) başına bölündü; sana düşen mıntıka: "${repo}" (yukarıdaki plan yalnızca bu ` +
        `mıntıkaya ait kısım). Yalnızca bu klasördeki dosyaları değiştir — yazma araçların bu klasörün dışına ` +
        `engellenmiştir. Diğer mıntıkalar (${others(repo).join(", ")}) aynı anda başka saha ajanlarına atandı; ` +
        `onlara dokunma, okuman serbest. Çıktındaki dosya yollarını hedef dizine göre ver (ör. "${repo}/src/...").`;
    const prompt = buildPrompt(agent, { ...ctx, outputs }) + "\n\n" + scopeNote;
    return runAgent(clone, prompt, cwd, cfg, bus, abortController, undefined, {
      writeScope: repo === "." ? undefined : path.join(cwd, repo),
    });
  };

  const phases: string[][] = [];
  if (node.parent && repos.includes(node.parent)) phases.push([node.parent]);
  const middle = repos.filter((r) => r !== node.parent && r !== ".");
  if (middle.length) phases.push(middle);
  if (repos.includes(".")) phases.push(["."]);

  const failed: Array<{ repo: string; error: string }> = [];
  for (const phase of phases) {
    const settled = await runLimited(phase, maxConcurrency, abortController.signal, runOne);
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") {
        prev.set(phase[i], s.value);
        return;
      }
      if (s.reason instanceof RunCancelledError) throw s.reason; // iptal: akışın tamamı durur
      failed.push({ repo: phase[i], error: s.reason instanceof Error ? s.reason.message : String(s.reason) });
    });
    if (failed.length) break; // parent düştüyse servisleri eski sözleşmeyle koşturmanın anlamı yok
  }
  bus.emit({ type: "fanout_finished", node: nodeKey, repos, failed });
  if (failed.length) {
    throw new Error(`${nodeKey}: ${failed.length} repo tamamlanamadı — ${failed.map((f) => `${f.repo}: ${f.error}`).join("; ")}`);
  }

  // Plandan çıkmış repoların eski sonuçları birleşime girmez
  const parts = [...groups.keys()].filter((r) => prev.has(r)).map((r) => [r, prev.get(r)!] as [string, AgentRunResult]);
  const merged = mergeWorkerResults(parts);
  bus.emit({ type: "agent_finished", agent: agent.key, output: merged.text, structured: merged.structured });
  return merged;
}

/**
 * Grafı yürüten motor. Kim kimi çağırır, onay nerede beklenir, döngü ne zaman
 * biter — hepsi config'den gelir ve kodda deterministik işler; hiçbir geçiş
 * modelin "hatırlamasına" bırakılmaz. Her adım EventBus'a yayınlanır.
 */
export async function runWorkflow(
  workflow: WorkflowConfig,
  agents: Map<string, AgentDefinition>,
  task: string,
  cwd: string,
  cfg: ProviderConfig,
  bus: EventBus,
  abortController: AbortController,
  web?: WebApprovalChannel,
  // Entry ajanın SDK oturum kimliği burada tutulur: gelen değer varsa o oturum
  // sürdürülür (resume), koşu boyunca en güncel kimlikle güncellenir (bellekte)
  // entryContext: o konuşmanın bilinen boyutu (token) — eşiği geçmişse özetlenir
  sessionStore: { entrySessionId?: string; entryContext?: number } = {},
  /** Verilirse akış (ilk düğüm dahil) bu zamana kadar bekler — görevin kendisini
   *  ileri bir saate kurmak için. Beklerken "şimdi çalıştır"/iptal/Durdur çalışır. */
  startAt?: number,
): Promise<void> {
  const ctx: RunContext = { task, outputs: new Map(), changedFiles: [], fanout: new Map(), skipped: [] };
  let current: string | null = workflow.entry;
  let rejectCycles = 0;
  // Art arda atlanan devre dışı düğüm sayısı — geçer kenarları bir döngü
  // oluşturuyorsa (A→B→A, hepsi kapalı) sonsuza dönmesin
  let consecutiveSkips = 0;

  try {
  // Zamanlanmış başlangıç: onaydan sonraki zamanlamayla aynı mekanizma (geri sayım
  // kartı, terminal/panelden erken çalıştırma ya da iptal)
  if (startAt && startAt > Date.now()) {
    bus.emit({ type: "run_scheduled", agent: workflow.entry, runAt: startAt });
    console.log(`\n⏰ Görev ${fmtDate(startAt)} için zamanlandı — bekleniyor…`);
    const { outcome, source } = await waitForScheduledTime(startAt, web, abortController.signal);
    if (outcome === "cancelled") {
      bus.emit({ type: "run_schedule_cancelled", agent: workflow.entry, source });
      console.log(`\n🛑 Zamanlama iptal edildi (${source}) — görev çalıştırılmadı.`);
      bus.emit({ type: "workflow_finished" });
      return;
    }
    bus.emit({ type: "run_resumed", agent: workflow.entry, source });
    console.log(`\n▶ ${outcome === "run_now" ? "Erken çalıştırma" : "Zamanı geldi"} (${source}) — görev başlıyor.`);
  }

  while (current !== null) {
    // Kullanıcı adımlar arasında iptal ettiyse burada temiz dur
    if (abortController.signal.aborted) throw new RunCancelledError();
    const node: WorkflowNode = workflow.agents[current];

    // Devre dışı düğüm: koşturulmaz, "geçer" kenarından (başarı yönü) devam edilir.
    // İstisna fanout: kapalıyken DAĞITIM kapanır, ajan tek kopya koşar (aşağıda) —
    // böylece aynı anahtarla paralel/tek kopya karşılaştırılabilir.
    if (node.disabled && !isFanoutNode(node)) {
      const to = passThroughTarget(node);
      if (++consecutiveSkips > Object.keys(workflow.agents).length) {
        throw new Error(`Devre dışı düğümlerin geçer kenarları döngü oluşturuyor ("${current}" civarı) — en az birini aç`);
      }
      console.log(`\n⏭ "${current}" devre dışı — atlandı → ${to ?? "akış biter"}`);
      bus.emit({ type: "node_skipped", node: current, to });
      if (!ctx.skipped.includes(current)) ctx.skipped.push(current);
      current = to;
      continue;
    }
    consecutiveSkips = 0;

    // Komut düğümü (LLM değil): değişen modülleri deterministik sırada build eder.
    // Başarılıysa onSuccess'e, ilk hata onFailure'a (build log'u geri bildirim olur).
    if (isCommandNode(node)) {
      const result = await runBuild(node, ctx.changedFiles, cwd, bus);
      if (result.ok) {
        ctx.feedback = undefined;
        current = node.onSuccess;
        continue;
      }
      rejectCycles++;
      if (rejectCycles >= workflow.maxCycles) {
        const error = `Build ${workflow.maxCycles} turda düzeltilemedi (son hata: ${result.failedModule})`;
        console.log(`\n⚠️ ${error}`);
        bus.emit({ type: "workflow_failed", error });
        return;
      }
      ctx.feedback =
        `Build başarısız — "${result.failedModule}" modülü derlenmedi. ` +
        `Aşağıdaki build çıktısındaki hataları düzelt:\n\n${result.log ?? ""}`;
      console.log(`\n🔁 Tur ${rejectCycles}/${workflow.maxCycles}: build hatası "${node.onFailure}" ajanına gönderiliyor`);
      bus.emit({ type: "cycle", n: rejectCycles, max: workflow.maxCycles, to: node.onFailure });
      current = node.onFailure;
      continue;
    }

    // Fanout düğümü (LLM değil, bir kapı): ajanın repo başına kopyaları koşar,
    // sonuçlar birleşip ajanın kendi çıktısıymış gibi kaydedilir (inceleme/build onu görür)
    if (isFanoutNode(node)) {
      if (workflow.agents[node.agent]?.disabled) {
        console.log(`\n⏭ "${node.agent}" devre dışı — "${current}" dağıtımı atlandı → ${node.next ?? "akış biter"}`);
        bus.emit({ type: "node_skipped", node: current, to: node.next });
        if (!ctx.skipped.includes(node.agent)) ctx.skipped.push(node.agent);
        current = node.next;
        continue;
      }
      const worker = agents.get(node.agent)!;
      let result: AgentRunResult;
      if (node.disabled) {
        console.log(`\n🔀 "${current}" devre dışı — dağıtım yok, ${worker.name} tek kopya koşuyor`);
        bus.emit({ type: "node_skipped", node: current, to: node.agent });
        result = await runAgent(worker, buildPrompt(worker, ctx), cwd, cfg, bus, abortController);
      } else {
        result = await runFanout(current, node, agents, ctx, cwd, cfg, bus, abortController);
      }
      ctx.outputs.set(worker.key, { name: worker.name, result });
      ctx.feedback = undefined;
      const changed = changedFilesOf(result);
      if (changed) ctx.changedFiles = changed;
      current = node.next;
      continue;
    }

    const agent: AgentDefinition = agents.get(current)!;
    // Yalnızca entry ajan (analist) oturum sürdürür; diğerleri her koşuda taze
    const isEntry = agent.key === workflow.entry;
    const result = await runAgent(
      agent, buildPrompt(agent, ctx), cwd, cfg, bus, abortController,
      isEntry ? sessionStore.entrySessionId : undefined,
      isEntry && sessionStore.entrySessionId ? { contextTokens: sessionStore.entryContext } : {},
    );
    if (isEntry && result.sessionId) {
      sessionStore.entrySessionId = result.sessionId;
      sessionStore.entryContext = result.contextTokens;
    }
    ctx.outputs.set(agent.key, { name: agent.name, result });
    ctx.feedback = undefined;
    // Structured çıktı değişen dosyalar taşıyorsa build düğümü için sakla
    const changed = changedFilesOf(result);
    if (changed) ctx.changedFiles = changed;

    // Rota (varsa) onaydan ÖNCE çözülür: akışı bitirecekse (hedef null) onay
    // sormanın anlamı yok — onaylanacak/uygulanacak bir sonraki adım yok.
    // routeTarget: undefined = düğümde routes yok; string = sonraki düğüm; null = akış biter
    let routeTarget: string | null | undefined;
    if (agent.config.routes) {
      const { target, value } = resolveRoute(agent.config.routes, result.structured);
      routeTarget = target;
      const note = `${agent.name} rotası: ${value ?? "(belirsiz)"} → ${target ?? "akış biter (saha timi çağrılmaz)"}`;
      console.log(`\n🧭 ${note}`);
      bus.emit({ type: "agent_text", agent: agent.key, text: `🧭 ${note}` });
    }

    // 1) Kullanıcı onayı gereken düğüm: terminal veya web'den — hangisi önce cevap verirse.
    //    Reddedilirse yorumla birlikte aynı düğüm tekrarlanır.
    //    Rota akışı bitirecekse (routeTarget === null) onay ATLANMAZ: aksi halde
    //    ajan "gerek yok" deyip akışı sessizce bitirir, kullanıcıya söz düşmezdi.
    //    Onay = bitir; red = gerekçeyle aynı ajanı yeniden koştur (ör. "bu bir
    //    değişiklik talebi, planla") — böylece saha timine boş planla gidilmez.
    const endsFlow = routeTarget === null;
    // Planı otomatik iletme (Ayarlar): plan üreten düğümün DOLU planı onay beklemeden
    // sonraki adıma geçer. Plan okunamadıysa ya da boşsa onay yine sorulur (kart nedenini
    // yazar) — saha timi plansız koşmasın. Akışı bitiren rotada (bilgi cevabı) onay sorulur.
    let autoBlocked: "empty" | "unreadable" | undefined;
    let forwarded = false;
    if (agent.config.requiresUserApproval && workflow.autoForwardPlan && !endsFlow && producesPlan(agent)) {
      const plan = (result.structured as { file_plan?: unknown } | undefined)?.file_plan;
      if (Array.isArray(plan) && plan.length > 0) {
        const to = routeTarget !== undefined ? routeTarget : agent.config.next ?? null;
        bus.emit({ type: "plan_forwarded", agent: agent.key, to, files: plan.length });
        console.log(`\n⏩ ${agent.name} planı (${plan.length} dosya) onay beklemeden iletildi → ${to ?? "akış biter"}`);
        forwarded = true;
      } else {
        autoBlocked = Array.isArray(plan) ? "empty" : "unreadable";
      }
    }
    if (agent.config.requiresUserApproval && !forwarded) {
      const approval = await askUserApproval(
        agent.name,
        outputView(result),
        bus,
        web,
        result.structured,
        abortController.signal,
        endsFlow,
        result.miss,
        autoBlocked,
      );
      if (!approval.approved) {
        ctx.feedback = approval.comment || "Kullanıcı çıktıyı reddetti, gözden geçir.";
        console.log(`\n↩ ${agent.name} kullanıcı geri bildirimiyle yeniden çalıştırılıyor`);
        continue;
      }

      // Onaylandı ama ileri bir zaman verildiyse, o zamana kadar kodda gerçek
      // bir duraklama. Bekleme sırasında panelden/terminalden erken çalıştırma
      // ya da iptal edilebilir (üç kanal yarışır). Akış zaten bitiyorsa
      // (endsFlow) bekleyecek bir sonraki adım yok — zamanlama yok sayılır.
      if (!endsFlow && approval.runAt && approval.runAt > Date.now()) {
        bus.emit({ type: "run_scheduled", agent: agent.key, runAt: approval.runAt });
        console.log(`\n⏰ ${agent.name} planı ${fmtDate(approval.runAt)} için zamanlandı — bekleniyor…`);
        const { outcome, source } = await waitForScheduledTime(approval.runAt, web, abortController.signal);
        if (outcome === "cancelled") {
          bus.emit({ type: "run_schedule_cancelled", agent: agent.key, source });
          console.log(`\n🛑 Zamanlama iptal edildi (${source}) — koşu sonlandırılıyor.`);
          bus.emit({ type: "workflow_finished" });
          return;
        }
        bus.emit({ type: "run_resumed", agent: agent.key, source });
        console.log(`\n▶ ${outcome === "run_now" ? "Erken çalıştırma" : "Zamanı geldi"} (${source}) — devam ediliyor.`);
      }
    }

    // 2) Verdict düğümü: karar doğrudan ajanın yapılandırılmış çıktısından alınır
    //    (outputFormat şemayı SDK'de zorlar); gelmediyse metinden çıkarma yedeği
    if (agent.config.verdict) {
      let verdict: ReviewVerdict;
      const parsed = ReviewVerdictSchema.safeParse(result.structured);
      if (parsed.success) {
        verdict = parsed.data;
      } else {
        console.log("⚠ Yapılandırılmış karar alınamadı, rapor metninden çıkarılıyor…");
        verdict = await extractVerdict(result.text, cfg, abortController);
      }

      bus.emit({
        type: "verdict",
        agent: agent.key,
        approved: verdict.approved,
        issues: verdict.issues,
        summary: verdict.summary,
      });
      console.log(`\n📋 ${agent.name} kararı: ${verdict.approved ? "ONAYLANDI ✅" : "REDDEDİLDİ ❌"} — ${verdict.summary}`);

      if (verdict.approved) {
        current = agent.config.verdict.onApprove;
      } else {
        rejectCycles++;
        if (rejectCycles >= workflow.maxCycles) {
          console.log(`\n⚠️ Maksimum döngü sayısına (${workflow.maxCycles}) ulaşıldı — insan müdahalesi gerekiyor.`);
          console.log("Son inceleme sorunları:");
          for (const issue of verdict.issues) {
            console.log(`  - [${issue.severity}] ${issue.file}: ${issue.description}`);
          }
          bus.emit({
            type: "workflow_failed",
            error: `Maksimum döngü sayısına (${workflow.maxCycles}) ulaşıldı; teftiş onayı alınamadı`,
          });
          return;
        }
        ctx.feedback = verdict.issues
          .map((i) => `- [${i.severity}] ${i.file}: ${i.description}`)
          .join("\n");
        console.log(`🔁 Tur ${rejectCycles}/${workflow.maxCycles}: sorunlar "${agent.config.verdict.onReject}" ajanına geri gönderiliyor`);
        bus.emit({ type: "cycle", n: rejectCycles, max: workflow.maxCycles, to: agent.config.verdict.onReject });
        current = agent.config.verdict.onReject;
      }
      continue;
    }

    // 3) Koşullu rota: hedef ajan çalıştıktan hemen sonra çözüldü (yukarıda),
    //    onay ondan sonra yapıldı. Burada sadece o hedefe geçilir.
    if (agent.config.routes) {
      current = routeTarget ?? null;
      continue;
    }

    // 4) Koşulsuz geçiş
    current = agent.config.next ?? null;
  }
  } catch (err) {
    // Kullanıcı iptali: akışı temiz durdur, panel başlangıç durumuna döner
    if (err instanceof RunCancelledError) {
      console.log("\n🛑 Koşu kullanıcı tarafından iptal edildi.");
      bus.emit({ type: "workflow_cancelled" });
      return;
    }
    throw err;
  }

  bus.emit({ type: "workflow_finished" });
  console.log("\n🎉 İş akışı tamamlandı.");
}
