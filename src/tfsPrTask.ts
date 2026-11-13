import path from "node:path";
import type { TimedEvent } from "./events.js";
import { getSummaries, type TfsConnection } from "./tfs.js";
import { POSTA_BASLIK, SADE_DIL } from "./tfsTask.js";
import {
  authEnv,
  currentBranch,
  dirtyFiles,
  fileLines,
  findRepo,
  aheadBehind,
  prDiff,
  type LocalRepo,
} from "./tfsGit.js";
import {
  getChanges,
  getPrWorkItems,
  getPullRequest,
  getThreads,
  type TfsPullRequest,
  type TfsThread,
} from "./tfsPr.js";

/**
 * TFS çekme isteği (PR) → ajanlara giden görev, ve iş bitince PR'a yazılacakların taslağı.
 * İki kip:
 *  - "yorum": inceleyenlerin açık yorum dizilerini ele al — kodu PR'ın dalında düzelt; bitince
 *    her diziye ne yapıldığı cevap olarak yazılır, istenirse "düzeltildi" yapılır, değişiklik
 *    PR'ın dalına gönderilir.
 *  - "incele": PR'ı incele, kod değiştirme — Analist bilgi cevabı (route=done) verir: genel
 *    değerlendirme (answer) PR'a genel yorum, bulgular (references: yol + satır + not) satıra
 *    bağlı yorum olarak yazılır.
 */

export type PrMode = "yorum" | "incele";

const kirp = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + " …(kırpıldı)" : s;
const tarih = (iso?: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("tr-TR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};
const VOTES: Record<string, string> = {
  "10": "onayladı",
  "5": "önerilerle onayladı",
  "0": "oy vermedi",
  "-5": "düzeltme bekliyor",
  "-10": "reddetti",
};
const STATUS: Record<string, string> = {
  active: "açık",
  pending: "beklemede",
  fixed: "düzeltildi",
  wontFix: "düzeltilmeyecek",
  closed: "kapatıldı",
  byDesign: "tasarım gereği",
  unknown: "bilinmiyor",
};
const OPEN = new Set(["active", "pending"]);

/** Yerel depo durumu — panel kartı ve başlatma denetimi */
export interface LocalStatus {
  /** Hedef dizine göre depo klasörü ("." = hedef dizinin kendisi) */
  rel?: string;
  dir?: string;
  branch?: string;
  onBranch?: boolean;
  dirty?: number;
  behind?: number;
  /** Depo bulunamadı / git yok */
  error?: string;
}

export async function localStatus(
  targetDir: string,
  pr: TfsPullRequest,
): Promise<{ repo?: LocalRepo; status: LocalStatus }> {
  let repo: LocalRepo | undefined;
  try {
    repo = await findRepo(targetDir, pr.repository.name);
  } catch (e) {
    return { status: { error: `git çalıştırılamadı: ${e instanceof Error ? e.message : String(e)}` } };
  }
  if (!repo) {
    return {
      status: {
        error: `"${pr.repository.name}" deposu hedef dizinde bulunamadı (${targetDir}) — dizin ya da bir alt klasörü bu deponun kopyası olmalı`,
      },
    };
  }
  try {
    const branch = await currentBranch(repo.dir);
    const dirty = (await dirtyFiles(repo.dir)).length;
    const ab = branch === pr.source ? await aheadBehind(repo.dir, repo.remote, pr.source) : undefined;
    return {
      repo,
      status: {
        rel: repo.rel,
        dir: repo.dir,
        branch,
        onBranch: branch === pr.source,
        dirty,
        ...(ab?.behind ? { behind: ab.behind } : {}),
      },
    };
  } catch (e) {
    return { repo, status: { rel: repo.rel, dir: repo.dir, error: e instanceof Error ? e.message : String(e) } };
  }
}

/** Kullanıcının yorumu olan, açık diziler (sistem dizileri hariç) */
export const openThreads = (threads: TfsThread[]) => threads.filter((t) => !t.system && OPEN.has(t.status));

export interface PrPreview {
  pr: TfsPullRequest;
  threads: Array<{
    id: number;
    status: string;
    file?: string;
    line?: number;
    lineEnd?: number;
    comments: Array<{ author: string; date: string; content: string }>;
  }>;
  openCount: number;
  changes: Array<{ path: string; change: string }>;
  workItems: Array<{ id: number; title?: string; type?: string; state?: string }>;
  local: LocalStatus;
}

/** Panel kartı için PR özeti (yerel depo durumu dahil) */
export async function previewPr(
  c: TfsConnection,
  id: number,
  targetDir: string,
  signal?: AbortSignal,
): Promise<PrPreview> {
  const pr = await getPullRequest(c, id, signal);
  const [threads, changes, wiIds, local] = await Promise.all([
    getThreads(c, pr, signal),
    getChanges(c, pr, signal).catch(() => []),
    getPrWorkItems(c, pr, signal),
    localStatus(targetDir, pr),
  ]);
  const sum = await getSummaries(c, wiIds, signal).catch(() => new Map());
  const user = threads.filter((t) => !t.system);
  return {
    pr,
    threads: user.map((t) => ({
      id: t.id,
      status: t.status,
      ...(t.file ? { file: t.file } : {}),
      ...(t.line ? { line: t.line } : {}),
      ...(t.lineEnd ? { lineEnd: t.lineEnd } : {}),
      comments: t.comments
        .filter((cm) => !cm.system)
        .map((cm) => ({ author: cm.author, date: cm.date, content: cm.content })),
    })),
    openCount: openThreads(threads).length,
    changes,
    workItems: wiIds.map((w) => ({
      id: w,
      ...(sum.get(w) ? { title: sum.get(w)!.title, type: sum.get(w)!.type, state: sum.get(w)!.state } : {}),
    })),
    local: local.status,
  };
}

/** Koşunun PR bilgisi — workflow_started'da taşınır, oturuma bağlanır, yazma bunu kullanır */
export interface PrMeta {
  id: number;
  title: string;
  url: string;
  project: string;
  repositoryId: string;
  repository: string;
  source: string;
  target: string;
  mode: PrMode;
  /** Yerel deponun hedef dizine göre klasörü ve mutlak yolu */
  repoRel?: string;
  repoDir?: string;
  /** "yorum" kipinde ele alınan diziler (yazarken cevap/durum için) */
  threads?: Array<{ id: number; firstCommentId: number; file?: string; line?: number; quote: string }>;
}

export interface PreparedPrTask {
  meta: PrMeta;
  /** Ajanlara giden metin: talimat + içerik */
  text: string;
  /** Ekranda (görev balonu, arama) gösterilen kısım: yalnızca çekme isteğinin içeriği */
  display: string;
  label: string;
}

/** Yorum dizisinin metin hali (görev için) */
function threadText(t: TfsThread, repo: LocalRepo | undefined): string {
  const yer = t.file
    ? `${t.file.replace(/^\//, "")}${t.line ? `, satır ${t.line}${t.lineEnd && t.lineEnd !== t.line ? `–${t.lineEnd}` : ""}` : ""}`
    : "genel yorum";
  const L = [`#### [Y-${t.id}] ${yer} (${STATUS[t.status] ?? t.status})`];
  if (repo && t.file && t.line) {
    const kod = fileLines(repo, t.file, t.line, t.lineEnd ?? t.line);
    if (kod)
      L.push(
        "Kodun yerel kopyadaki hali (▶ yorumun satırları; PR sonrası değiştiyse kaymış olabilir):",
        "```",
        kod,
        "```",
      );
  }
  for (const cm of t.comments.filter((x) => !x.system)) {
    L.push(`- **${cm.author}** (${tarih(cm.date)}): ${kirp(cm.content.trim(), 1500).replace(/\n/g, "\n  ")}`);
  }
  return L.join("\n");
}

/**
 * PR'ı görev olarak hazırlar. targetDir: oturumun hedef dizini — PR'ın deposu orada (ya da
 * bir alt klasöründe) bulunmalı. "yorum" kipinde yerel depo PR'ın dalında olmalı.
 */
export async function preparePrTask(
  c: TfsConnection,
  id: number,
  mode: PrMode,
  targetDir: string,
  userNote: string,
  signal?: AbortSignal,
): Promise<PreparedPrTask> {
  const pr = await getPullRequest(c, id, signal);
  if (pr.status && pr.status !== "active")
    throw new Error(
      `!${id} çekme isteği açık değil (${pr.status === "completed" ? "tamamlanmış" : pr.status === "abandoned" ? "bırakılmış" : pr.status})`,
    );
  const [threads, changes, wiIds, local] = await Promise.all([
    getThreads(c, pr, signal),
    getChanges(c, pr, signal).catch(() => []),
    getPrWorkItems(c, pr, signal),
    localStatus(targetDir, pr),
  ]);
  const repo = local.repo;
  if (mode === "yorum") {
    if (!repo) throw new Error(local.status.error ?? "çekme isteğinin deposu hedef dizinde bulunamadı");
    if (!local.status.onBranch) {
      throw new Error(
        `bilgisayardaki kopya ("${repo.rel}") şu an "${local.status.branch}" dalında; çekme isteğinin dalı "${pr.source}" — önce karttaki "Dala geç" düğmesine bas`,
      );
    }
  }
  const acik = openThreads(threads);
  if (mode === "yorum" && !acik.length && !userNote.trim())
    throw new Error(`!${id} çekme isteğinde açık yorum yok — ne yapılacağını görev kutusuna yaz`);
  const sum = await getSummaries(c, wiIds, signal).catch(() => new Map());

  // Ajan talimatı (şema alan adları dahil) ekranda gösterilmez — görev balonunda yalnızca içerik
  const guide =
    mode === "yorum"
      ? [
          `Bu görev TFS'teki !${pr.id} numaralı çekme isteğinin (pull request) inceleme yorumlarını ele almaktır — Kurmay isteği TFS'ten aldı.`,
          `- Çalışma kopyası isteğin "${pr.source}" dalında${repo && repo.rel !== "." ? ` (depo hedef dizinde "${repo.rel}" klasöründe)` : ""}; değişiklikleri burada yap.`,
          "- Her açık yorumu oku. Haklıysa kodu düzelt; katılmıyorsan o kodu değiştirme ve nedenini planın varsayımlarında (assumptions) yaz.",
          "- Planındaki her değişikliğin gerekçesinin (rationale) BAŞINA hangi yorumu karşıladığını yaz: [Y-12] biçiminde (birden çoksa [Y-12][Y-15]). " +
            "Kurmay bitince her yorumun altına bu gerekçeleri cevap olarak yazacak.",
          "- Yorumda istenmeyen değişiklik yapma; isteğin kapsamı dışına çıkma.",
          `- ${SADE_DIL}`,
        ]
      : [
          `Bu görev TFS'teki !${pr.id} numaralı çekme isteğini (pull request) incelemektir — kod DEĞİŞTİRME, plan çıkarma.`,
          '- route alanını "done" yap; file_plan boş kalsın.',
          "- answer alanına genel değerlendirmeyi Markdown olarak yaz (isteğe genel yorum olarak gidecek): ne yapılmış, riskler, eksikler.",
          "- Somut her bulguyu references'a ayrı bir kayıt olarak yaz: path = dosya yolu (hedef dizine göre), line = isteğin SON halindeki satır " +
            "(farktaki + satırları), note = yorum metni (sorun + öneri, kısa ve net). Bunlar o satıra yorum olarak yazılacak.",
          "- Yalnızca bu isteğin değiştirdiği kodla ilgili yorum yap; zaten açık olan yorumları tekrarlama.",
          `- ${SADE_DIL}`,
        ];
  const L: string[] = [];
  if (userNote.trim()) L.push("## Kullanıcının ek talimatı (öncelikli)", userNote.trim(), "");

  L.push(`## !${pr.id} — ${pr.title}`);
  L.push(`- Depo: ${pr.repository.name} · Dal: ${pr.source} → ${pr.target}${pr.isDraft ? " · taslak" : ""}`);
  if (pr.createdBy) L.push(`- Açan: ${pr.createdBy}${pr.creationDate ? ` (${tarih(pr.creationDate)})` : ""}`);
  if (pr.reviewers.length)
    L.push(`- İnceleyenler: ${pr.reviewers.map((r) => `${r.name} (${VOTES[String(r.vote)] ?? r.vote})`).join(", ")}`);
  if (wiIds.length)
    L.push(
      `- Bağlı iş öğeleri: ${wiIds.map((w) => (sum.get(w) ? `#${w} (${sum.get(w)!.type}) ${sum.get(w)!.title}` : `#${w}`)).join("; ")}`,
    );
  L.push(`- Adres: ${pr.webUrl}`);
  if (pr.description.trim()) L.push("", "### Açıklama", kirp(pr.description.trim(), 6000));

  if (mode === "yorum") {
    L.push("", `### Açık yorumlar (${acik.length})`);
    for (const t of acik) L.push("", threadText(t, repo));
  } else if (acik.length) {
    L.push("", `### Zaten açık yorumlar (${acik.length}) — tekrarlama`);
    for (const t of acik.slice(0, 30)) {
      const ilk = t.comments.find((x) => !x.system);
      L.push(
        `- ${t.file ? `${t.file.replace(/^\//, "")}${t.line ? `:${t.line}` : ""}` : "genel"} — ${kirp((ilk?.content ?? "").replace(/\s+/g, " "), 200)}`,
      );
    }
  }

  if (changes.length) {
    L.push("", `### Değişen dosyalar (${changes.length})`);
    for (const ch of changes.slice(0, 200))
      L.push(`- ${ch.change}: ${repo && repo.rel !== "." ? `${repo.rel}/` : ""}${ch.path.replace(/^\//, "")}`);
  }
  if (mode === "incele" && repo) {
    try {
      const d = await prDiff(repo, pr.source, pr.target, await authEnv(c, repo.remoteUrl), 60_000, signal);
      if (d.diff.trim()) {
        L.push(
          "",
          `### Fark (${pr.target} → ${pr.source})${d.truncated ? " — büyük olduğu için dosya başına kırpıldı; gerekirse dosyayı oku" : ""}`,
          "```diff",
          d.diff.trim(),
          "```",
        );
      }
    } catch (e) {
      L.push("", `(Fark alınamadı: ${e instanceof Error ? e.message : String(e)} — değişen dosyaları diskten oku.)`);
    }
  }

  const meta: PrMeta = {
    id: pr.id,
    title: pr.title,
    url: pr.webUrl,
    project: pr.repository.project,
    repositoryId: pr.repository.id,
    repository: pr.repository.name,
    source: pr.source,
    target: pr.target,
    mode,
    ...(repo ? { repoRel: repo.rel, repoDir: repo.dir } : {}),
    ...(mode === "yorum"
      ? {
          threads: acik.map((t) => {
            const ilk = t.comments.find((x) => !x.system) ?? t.comments[0];
            return {
              id: t.id,
              firstCommentId: ilk?.id ?? 1,
              ...(t.file ? { file: t.file } : {}),
              ...(t.line ? { line: t.line } : {}),
              quote: kirp((ilk?.content ?? "").replace(/\s+/g, " ").trim(), 160),
            };
          }),
        }
      : {}),
  };
  const t = pr.title.trim();
  const display = L.join("\n");
  return {
    meta,
    text: `${guide.join("\n")}\n\n${display}`,
    display,
    label: `!${pr.id} · ${t.length > 70 ? t.slice(0, 70) + "…" : t}`,
  };
}

// ── Bitince PR'a yazılacaklar ─────────────────────────────────────────────

/** Hedef dizine göre yolu depo köküne göre yola çevirir ("siparis/src/A.java" → "/src/A.java"); depo dışıysa undefined */
export function toRepoPath(
  file: string,
  repoRel: string | undefined,
  targetDir: string,
  repoDir?: string,
): string | undefined {
  const f = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (repoDir && path.isAbsolute(file)) {
    const r = path.relative(repoDir, file).split(path.sep).join("/");
    return r.startsWith("..") ? undefined : "/" + r;
  }
  if (!repoRel || repoRel === ".") return "/" + f.replace(/^\/+/, "");
  if (f.toLowerCase().startsWith(repoRel.toLowerCase() + "/")) return "/" + f.slice(repoRel.length + 1);
  if (path.isAbsolute(file) && targetDir) return toRepoPath(path.relative(targetDir, file), repoRel, targetDir);
  return undefined;
}

export interface PrReplyDraft {
  threadId: number;
  firstCommentId: number;
  file?: string;
  line?: number;
  quote: string;
  text: string;
  /** "düzeltildi" yapılsın mı (cevapta değişiklik varsa varsayılan evet) */
  resolve: boolean;
}

export interface PrCommentDraft {
  file?: string;
  line?: number;
  text: string;
}

export interface PrWriteDraft {
  mode: PrMode;
  replies: PrReplyDraft[];
  comments: PrCommentDraft[];
  general: string;
  /** Commit'lenecek dosyalar (depo köküne göre, "/" olmadan) ve önerilen mesaj */
  commit?: { files: string[]; message: string };
}

/** Bu koşunun olaylarından PR'a yazılacakların taslağı */
export function prWriteDraft(
  events: readonly TimedEvent[],
  meta: PrMeta,
  entryKey: string,
  targetDir: string,
): PrWriteDraft {
  let summary = "";
  let answer = "";
  let references: Array<{ path?: unknown; line?: unknown; note?: unknown }> = [];
  let planChanges: Array<{ path: string; location: string; rationale: string }> = [];
  let changes: Array<{ file: string; summary?: string }> = [];
  const touched = new Set<string>();
  let verdict: { approved: boolean; summary: string } | undefined;
  for (const e of events) {
    if (e.type === "agent_finished") {
      const st = (e.structured ?? {}) as {
        summary?: unknown;
        answer?: unknown;
        references?: unknown;
        file_plan?: unknown;
        changes?: unknown;
      };
      if (e.agent === entryKey) {
        summary = typeof st.summary === "string" ? st.summary.trim() : "";
        answer = typeof st.answer === "string" ? st.answer.trim() : "";
        references = Array.isArray(st.references) ? (st.references as typeof references) : [];
        planChanges = [];
        for (const f of Array.isArray(st.file_plan)
          ? (st.file_plan as Array<{ path?: unknown; changes?: unknown }>)
          : []) {
          for (const ch of Array.isArray(f.changes)
            ? (f.changes as Array<{ location?: unknown; rationale?: unknown }>)
            : []) {
            planChanges.push({
              path: String(f.path ?? ""),
              location: String(ch.location ?? ""),
              rationale: String(ch.rationale ?? ""),
            });
          }
        }
      } else if (Array.isArray(st.changes)) {
        changes = (st.changes as Array<{ file?: unknown; summary?: unknown }>)
          .filter((c) => typeof c.file === "string" && c.file)
          .map((c) => ({
            file: String(c.file),
            ...(typeof c.summary === "string" && c.summary.trim() ? { summary: c.summary.trim() } : {}),
          }));
      }
    } else if (e.type === "tool_used" && e.file && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(e.tool)) {
      touched.add(e.file);
    } else if (e.type === "write_blocked") {
      touched.delete(e.file);
    } else if (e.type === "verdict") {
      verdict = { approved: e.approved, summary: e.summary };
    }
  }
  const rp = (f: string) => toRepoPath(f, meta.repoRel, targetDir, meta.repoDir);

  if (meta.mode === "incele") {
    const comments: PrCommentDraft[] = [];
    for (const r of references) {
      const note = typeof r.note === "string" ? r.note.trim() : "";
      if (!note || typeof r.path !== "string") continue;
      const file = rp(r.path);
      const line = typeof r.line === "number" && r.line > 0 ? r.line : undefined;
      if (file) comments.push({ file, ...(line ? { line } : {}), text: `${POSTA_BASLIK}\n**Tespit:** ${note}` });
      else
        comments.push({
          text: `${POSTA_BASLIK}\n**Tespit:** ${note}\n\n**Yer:** \`${r.path}${line ? `:${line}` : ""}\``,
        });
    }
    const general = answer || summary;
    return {
      mode: "incele",
      replies: [],
      comments,
      general: general
        ? `${POSTA_BASLIK}\n**İNCELEME RAPORU — !${meta.id}**\n\n${general}${comments.length ? `\n\nAyrıca ${comments.length} satıra yorum yazıldı.` : ""}\n\n*Arz ederim. — Kurmay*`
        : "",
    };
  }

  // "yorum" kipi: her diziye cevap — plandaki [Y-n] etiketli gerekçeler + o dosyadaki değişiklikler
  const repoFiles = new Map<string, string | undefined>(); // depo yolu → özet
  for (const c of changes) {
    const f = rp(c.file);
    if (f) repoFiles.set(f, c.summary);
  }
  for (const t of touched) {
    const f = rp(t);
    if (f && !repoFiles.has(f)) repoFiles.set(f, undefined);
  }
  const replies: PrReplyDraft[] = (meta.threads ?? []).map((t) => {
    const tag = new RegExp(`\\[Y-${t.id}\\]`, "i");
    const satirlar: string[] = [];
    for (const pc of planChanges) {
      if (!tag.test(pc.rationale)) continue;
      const neden = pc.rationale.replace(/\[Y-\d+\]\s*/gi, "").trim();
      satirlar.push(`- ${pc.location ? `${pc.location}: ` : ""}${neden}`);
    }
    const dosya = t.file
      ? [...repoFiles.entries()].find(([f]) => f.toLowerCase() === t.file!.toLowerCase())
      : undefined;
    if (dosya) satirlar.push(`- \`${dosya[0].replace(/^\//, "")}\` güncellendi${dosya[1] ? ` — ${dosya[1]}` : ""}`);
    const yapildi = satirlar.length > 0;
    return {
      threadId: t.id,
      firstCommentId: t.firstCommentId,
      ...(t.file ? { file: t.file } : {}),
      ...(t.line ? { line: t.line } : {}),
      quote: t.quote,
      text: yapildi
        ? `${POSTA_BASLIK}\n**Emir yerine getirildi.**\n${satirlar.join("\n")}`
        : `${POSTA_BASLIK}\n**Bilgi:** Bu yorum için kod değişikliği yapılmadı.`,
      resolve: yapildi,
    };
  });
  const files = [...repoFiles.keys()].map((f) => f.replace(/^\//, ""));
  const ozet = summary ? summary.replace(/\s+/g, " ") : "";
  const yapilan = replies.filter((r) => r.resolve).length;
  const general =
    `${POSTA_BASLIK}\n**HAREKÂT RAPORU — !${meta.id}**\n` +
    (replies.length
      ? `**Durum:** ${replies.length} yorumdan ${yapilan} tanesi için kod değiştirildi.`
      : "**Durum:** Tamamlandı.") +
    (ozet ? `\n\n**Özet:** ${kirp(ozet, 1200)}` : "") +
    (verdict
      ? `\n\n**Kod kontrolü:** ${verdict.approved ? "Onaylandı" : "Onaylanmadı"}${verdict.summary ? ` — ${kirp(verdict.summary.replace(/\s+/g, " "), 400)}` : ""}`
      : "") +
    "\n\n*Arz ederim. — Kurmay*";
  const baslik = `!${meta.id}: ${ozet || "inceleme yorumları"}`;
  const subject = baslik.length > 72 ? baslik.slice(0, 71).replace(/\s+\S*$/, "") + "…" : baslik;
  return {
    mode: "yorum",
    replies,
    comments: [],
    general,
    ...(files.length
      ? {
          commit: {
            files,
            message: `${subject}\n\n${replies
              .filter((r) => r.resolve)
              .map((r) => `- [Y-${r.threadId}] ${r.quote}`)
              .join("\n")}`.trim(),
          },
        }
      : {}),
  };
}

/**
 * Oturumun PR'ının devam görevi (PR seçilmeden verilen görev): kısa bağlam + yerel depo
 * denetimi (PR'ın dalında olunmalı). Sonuç aynı PR'a yazılır (genel yorum + commit).
 */
export async function preparePrFollowUp(
  c: TfsConnection,
  id: number,
  targetDir: string,
  userNote: string,
  signal?: AbortSignal,
): Promise<PreparedPrTask> {
  const pr = await getPullRequest(c, id, signal);
  if (pr.status && pr.status !== "active") throw new Error(`!${id} çekme isteği artık açık değil`);
  const local = await localStatus(targetDir, pr);
  if (!local.repo) throw new Error(local.status.error ?? "çekme isteğinin deposu hedef dizinde bulunamadı");
  if (!local.status.onBranch)
    throw new Error(
      `bilgisayardaki kopya ("${local.repo.rel}") şu an "${local.status.branch}" dalında; çekme isteğinin dalı "${pr.source}" — önce dala geç`,
    );
  const text =
    `Bu görev, bu oturumda üzerinde çalışılan TFS çekme isteği !${pr.id} — "${pr.title}" ile ilgilidir ` +
    `(dal "${pr.source}"${local.repo.rel !== "." ? `, depo "${local.repo.rel}" klasöründe` : ""}). Değişiklikleri bu dalda yap.\n\n${userNote}`;
  const t = pr.title.trim();
  return {
    meta: {
      id: pr.id,
      title: pr.title,
      url: pr.webUrl,
      project: pr.repository.project,
      repositoryId: pr.repository.id,
      repository: pr.repository.name,
      source: pr.source,
      target: pr.target,
      mode: "yorum",
      repoRel: local.repo.rel,
      repoDir: local.repo.dir,
      threads: [],
    },
    text,
    display: userNote,
    label: `!${pr.id} · ${t.length > 70 ? t.slice(0, 70) + "…" : t}`,
  };
}
