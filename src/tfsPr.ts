import { identityName, releasedVersion, serverVersion, tfsCall, TfsError, type TfsConnection } from "./tfs.js";

/**
 * TFS çekme isteği (PR) uçları: PR'ı ve yorum dizilerini okuma, değişen dosyalar, cevap
 * yazma, diziyi "düzeltildi" yapma, yeni (genel ya da satıra bağlı) yorum, PR açma.
 * Git REST'i TFS 2017'den beri aynı (3.0+); sürüm, iş öğeleriyle aynı tespitten gelir.
 * PR açıklaması ve yorumları Markdown'dır (iş öğesi alanları HTML iken).
 */

export interface TfsPullRequest {
  id: number;
  title: string;
  description: string;
  /** active | completed | abandoned */
  status: string;
  isDraft: boolean;
  createdBy?: string;
  creationDate?: string;
  /** Kısa dal adları (refs/heads/ olmadan) */
  source: string;
  target: string;
  repository: { id: string; name: string; project: string; projectId?: string; remoteUrl?: string; webUrl?: string };
  reviewers: Array<{ name: string; vote: number; required?: boolean }>;
  mergeStatus?: string;
  lastSourceCommit?: string;
  webUrl: string;
}

export interface TfsThreadComment {
  id: number;
  parentId: number;
  author: string;
  date: string;
  content: string;
  /** Sistem yorumu (oy, gönderim, dal güncellemesi…) */
  system: boolean;
}

export interface TfsThread {
  id: number;
  /** active | fixed | wontFix | closed | byDesign | pending | unknown */
  status: string;
  /** Depo köküne göre yol ("/src/A.java"); genel yorumda yok */
  file?: string;
  line?: number;
  lineEnd?: number;
  comments: TfsThreadComment[];
  /** Kullanıcı yorumu değil (oy, gönderim, bağlı iş öğesi…) */
  system: boolean;
}

const THREAD_STATUS = ["unknown", "active", "fixed", "wontFix", "closed", "byDesign", "pending"];
/** Eski sunucular durumu sayı döndürebilir */
const threadStatus = (v: unknown): string =>
  typeof v === "number"
    ? (THREAD_STATUS[v] ?? "unknown")
    : typeof v === "string"
      ? v.charAt(0).toLowerCase() + v.slice(1)
      : "unknown";
const shortRef = (r: unknown) => (typeof r === "string" ? r.replace(/^refs\/heads\//, "") : "");
const enc = encodeURIComponent;

interface RawPr {
  pullRequestId?: number;
  title?: string;
  description?: string;
  status?: unknown;
  isDraft?: boolean;
  createdBy?: unknown;
  creationDate?: string;
  sourceRefName?: string;
  targetRefName?: string;
  mergeStatus?: unknown;
  lastMergeSourceCommit?: { commitId?: string };
  repository?: {
    id?: string;
    name?: string;
    remoteUrl?: string;
    webUrl?: string;
    project?: { id?: string; name?: string };
  };
  reviewers?: Array<{ displayName?: string; vote?: number; isRequired?: boolean }>;
  _links?: { web?: { href?: string } };
}

const PR_STATUS = ["notSet", "active", "abandoned", "completed"];

function normalizePr(c: TfsConnection, r: RawPr): TfsPullRequest {
  const repo = r.repository ?? {};
  const project = repo.project?.name ?? c.project;
  const id = r.pullRequestId ?? 0;
  const web =
    r._links?.web?.href ??
    (repo.webUrl
      ? `${repo.webUrl}/pullrequest/${id}`
      : `${c.url}/${enc(project)}/_git/${enc(repo.name ?? "")}/pullrequest/${id}`);
  return {
    id,
    title: r.title ?? "",
    description: r.description ?? "",
    status: typeof r.status === "number" ? (PR_STATUS[r.status] ?? "notSet") : String(r.status ?? ""),
    isDraft: !!r.isDraft,
    ...(identityName(r.createdBy) ? { createdBy: identityName(r.createdBy) } : {}),
    ...(r.creationDate ? { creationDate: r.creationDate } : {}),
    source: shortRef(r.sourceRefName),
    target: shortRef(r.targetRefName),
    repository: {
      id: repo.id ?? "",
      name: repo.name ?? "",
      project,
      ...(repo.project?.id ? { projectId: repo.project.id } : {}),
      ...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : {}),
      ...(repo.webUrl ? { webUrl: repo.webUrl } : {}),
    },
    reviewers: (r.reviewers ?? []).map((x) => ({
      name: x.displayName ?? "?",
      vote: x.vote ?? 0,
      ...(x.isRequired ? { required: true } : {}),
    })),
    ...(r.mergeStatus !== undefined ? { mergeStatus: String(r.mergeStatus) } : {}),
    ...(r.lastMergeSourceCommit?.commitId ? { lastSourceCommit: r.lastMergeSourceCommit.commitId } : {}),
    webUrl: web,
  };
}

const ver = async (c: TfsConnection, signal?: AbortSignal) => releasedVersion(await serverVersion(c, signal));
/** PR listesi süzgeci: 4.1'den itibaren "searchCriteria." önekli, TFS 2017'de öneksiz (status, creatorId…) */
const crit = (v: string, name: string) => (Number(v) >= 4.1 ? `searchCriteria.${name}` : name);

/** "!123", "123" ya da PR adresi (…/_git/Depo/pullrequest/123) */
export function parsePrRef(input: string): number | undefined {
  const t = input.trim();
  const m = /^!\s*(\d{1,9})$/.exec(t) ?? /\/pullrequest\/(\d+)(?:[/?#]|$)/i.exec(t);
  return m ? Number(m[1]) : undefined;
}

/** PR'ı numarasıyla okur (koleksiyon düzeyinde; olmazsa ayarlardaki projede) */
export async function getPullRequest(c: TfsConnection, id: number, signal?: AbortSignal): Promise<TfsPullRequest> {
  const v = await ver(c, signal);
  const tries = [`/_apis/git/pullrequests/${id}`, `/${enc(c.project)}/_apis/git/pullrequests/${id}`];
  let last: unknown;
  for (const p of tries) {
    try {
      return normalizePr(
        c,
        await tfsCall<RawPr>(c, "GET", p, { query: { "api-version": v }, what: `!${id} çekme isteği`, signal }),
      );
    } catch (e) {
      last = e;
      if (!(e instanceof TfsError) || (e.status !== 404 && e.status !== 400)) throw e;
    }
  }
  if (last instanceof TfsError && last.status === 404)
    throw new TfsError(`!${id} çekme isteği bulunamadı ya da okuma yetkin yok`, 404, last.code);
  throw last;
}

const prBase = (pr: TfsPullRequest) =>
  `/${enc(pr.repository.project)}/_apis/git/repositories/${enc(pr.repository.id)}/pullRequests/${pr.id}`;

/**
 * Yorum dizileri (silinenler hariç; sistem dizileri işaretli). iteration verilirse satırlar o
 * yinelemeye göre izlenir ($iteration + $baseIteration=0 — dosyalar sekmesinde görünen satırlar;
 * yorum yazıldıktan sonra gelen gönderimler satırı kaydırmış olabilir). 4.1'den önce yok.
 */
export async function getThreads(
  c: TfsConnection,
  pr: TfsPullRequest,
  signal?: AbortSignal,
  iteration?: number,
): Promise<TfsThread[]> {
  const v = await ver(c, signal);
  const izle = iteration && Number(v) >= 4.1 ? { $iteration: iteration, $baseIteration: 0 } : {};
  const r = await tfsCall<{
    value?: Array<{
      id?: number;
      status?: unknown;
      isDeleted?: boolean;
      threadContext?: {
        filePath?: string;
        rightFileStart?: { line?: number };
        rightFileEnd?: { line?: number };
        leftFileStart?: { line?: number };
      } | null;
      properties?: Record<string, unknown>;
      comments?: Array<{
        id?: number;
        parentCommentId?: number;
        author?: unknown;
        content?: string;
        commentType?: unknown;
        publishedDate?: string;
        isDeleted?: boolean;
      }>;
    }>;
  }>(c, "GET", `${prBase(pr)}/threads`, { query: { "api-version": v, ...izle }, what: `!${pr.id} yorumları`, signal });
  const out: TfsThread[] = [];
  for (const t of r?.value ?? []) {
    if (t.isDeleted || typeof t.id !== "number") continue;
    const comments: TfsThreadComment[] = (t.comments ?? [])
      .filter((cm) => !cm.isDeleted && typeof cm.id === "number")
      .map((cm) => ({
        id: cm.id!,
        parentId: cm.parentCommentId ?? 0,
        author: identityName(cm.author) ?? "?",
        date: cm.publishedDate ?? "",
        content: cm.content ?? "",
        system: cm.commentType === "system" || cm.commentType === 3,
      }));
    if (!comments.length) continue;
    const props = t.properties ?? {};
    // Oy, gönderim, iş öğesi bağlama gibi otomatik diziler: CodeReviewThreadType özelliği taşır
    const system = comments.every((cm) => cm.system) || "CodeReviewThreadType" in props;
    const ctx = t.threadContext ?? undefined;
    const line = ctx?.rightFileStart?.line ?? ctx?.leftFileStart?.line;
    out.push({
      id: t.id,
      status: threadStatus(t.status),
      ...(ctx?.filePath ? { file: ctx.filePath } : {}),
      ...(line ? { line } : {}),
      ...(ctx?.rightFileEnd?.line ? { lineEnd: ctx.rightFileEnd.line } : {}),
      comments,
      system,
    });
  }
  return out;
}

export interface TfsPrChange {
  path: string;
  change: string;
  /** Satır yorumunu bu dosyaya bağlamak için (yineleme bağlamı) */
  changeTrackingId?: number;
}

/** Son yineleme (her gönderim bir yineleme) ve o yinelemede değişen dosyalar */
export async function getIterationChanges(
  c: TfsConnection,
  pr: TfsPullRequest,
  signal?: AbortSignal,
): Promise<{ iteration: number; changes: TfsPrChange[] }> {
  const v = await ver(c, signal);
  const its = await tfsCall<{ value?: Array<{ id?: number }> }>(c, "GET", `${prBase(pr)}/iterations`, {
    query: { "api-version": v },
    what: `!${pr.id} yinelemeleri`,
    signal,
  });
  const last = Math.max(0, ...(its?.value ?? []).map((i) => i.id ?? 0));
  if (!last) return { iteration: 0, changes: [] };
  const out: TfsPrChange[] = [];
  for (let skip = 0; skip < 5000;) {
    const r = await tfsCall<{
      changeEntries?: Array<{
        changeTrackingId?: number;
        item?: { path?: string; isFolder?: boolean };
        changeType?: unknown;
        originalPath?: string;
      }>;
      nextSkip?: number;
    }>(c, "GET", `${prBase(pr)}/iterations/${last}/changes`, {
      query: { "api-version": v, $top: 1000, $skip: skip },
      what: `!${pr.id} değişiklikleri`,
      signal,
    });
    for (const e of r?.changeEntries ?? []) {
      if (!e.item?.path || e.item.isFolder) continue;
      out.push({
        path: e.item.path,
        change: String(e.changeType ?? "edit"),
        ...(typeof e.changeTrackingId === "number" ? { changeTrackingId: e.changeTrackingId } : {}),
      });
    }
    if (!r?.nextSkip || r.nextSkip <= skip) break;
    skip = r.nextSkip;
  }
  return { iteration: last, changes: out };
}

/** Son yinelemede değişen dosyalar (yol + değişiklik türü) */
export async function getChanges(c: TfsConnection, pr: TfsPullRequest, signal?: AbortSignal): Promise<TfsPrChange[]> {
  return (await getIterationChanges(c, pr, signal)).changes;
}

/** PR'a bağlı iş öğeleri */
export async function getPrWorkItems(c: TfsConnection, pr: TfsPullRequest, signal?: AbortSignal): Promise<number[]> {
  const v = await ver(c, signal);
  try {
    const r = await tfsCall<{ value?: Array<{ id?: string | number }> }>(c, "GET", `${prBase(pr)}/workitems`, {
      query: { "api-version": v },
      what: `!${pr.id} iş öğeleri`,
      signal,
    });
    return (r?.value ?? []).map((w) => Number(w.id)).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

let meCache: { url: string; id: string } | undefined;
/** Anahtarın sahibinin kimliği (PR listelerinde "benim" süzgeci için) */
export async function myId(c: TfsConnection, signal?: AbortSignal): Promise<string | undefined> {
  if (meCache?.url === c.url) return meCache.id;
  const r = await tfsCall<{ authenticatedUser?: { id?: string } }>(c, "GET", "/_apis/connectionData", {
    what: "kimlik",
    signal,
  }).catch(() => undefined);
  const id = r?.authenticatedUser?.id;
  if (id) meCache = { url: c.url, id };
  return id;
}

export interface TfsPrListItem {
  id: number;
  title: string;
  repository: string;
  source: string;
  target: string;
  createdBy?: string;
  creationDate?: string;
  isDraft: boolean;
  /** Ben açtım | inceleyeniyim */
  role: "acan" | "inceleyen";
}

/** Projede açık PR'lardan benim açtıklarım ve inceleyeni olduklarım */
export async function myPullRequests(c: TfsConnection, signal?: AbortSignal): Promise<TfsPrListItem[]> {
  const v = await ver(c, signal);
  const id = await myId(c, signal);
  if (!id) throw new TfsError("kimliğin okunamadı — PR listesi için bağlantı bilgisi gerekli");
  const list = async (key: string, role: TfsPrListItem["role"]) => {
    const r = await tfsCall<{ value?: RawPr[] }>(c, "GET", `/${enc(c.project)}/_apis/git/pullrequests`, {
      query: { "api-version": v, [crit(v, "status")]: "active", [crit(v, key)]: id, $top: 50 },
      what: "PR listesi",
      signal,
    });
    return (r?.value ?? []).map((x) => {
      const n = normalizePr(c, x);
      return {
        id: n.id,
        title: n.title,
        repository: n.repository.name,
        source: n.source,
        target: n.target,
        ...(n.createdBy ? { createdBy: n.createdBy } : {}),
        ...(n.creationDate ? { creationDate: n.creationDate } : {}),
        isDraft: n.isDraft,
        role,
      };
    });
  };
  const [mine, review] = await Promise.all([list("creatorId", "acan"), list("reviewerId", "inceleyen")]);
  const seen = new Set<number>();
  return [...mine, ...review].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

/** Diziye cevap yazar (dizinin ilk yorumuna) */
export async function replyToThread(
  c: TfsConnection,
  pr: TfsPullRequest,
  thread: { id: number; firstCommentId: number },
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const v = await ver(c, signal);
  await tfsCall(c, "POST", `${prBase(pr)}/threads/${thread.id}/comments`, {
    query: { "api-version": v },
    json: { content, parentCommentId: thread.firstCommentId, commentType: 1 },
    what: `!${pr.id} dizi ${thread.id} cevabı`,
    signal,
  });
}

/** Dizinin durumunu değiştirir (fixed = düzeltildi, closed = kapatıldı, wontFix…) */
export async function setThreadStatus(
  c: TfsConnection,
  pr: TfsPullRequest,
  threadId: number,
  status: string,
  signal?: AbortSignal,
): Promise<void> {
  const v = await ver(c, signal);
  const n = THREAD_STATUS.indexOf(status);
  if (n < 1) throw new TfsError(`geçersiz yorum durumu: ${status}`);
  await tfsCall(c, "PATCH", `${prBase(pr)}/threads/${threadId}`, {
    query: { "api-version": v },
    // Durum her sürümde sayı olarak belgeli (2 = düzeltildi); metin biçimi her sunucuda doğrulanmadı
    json: { status: n },
    what: `!${pr.id} dizi ${threadId} durumu`,
    signal,
  });
}

/**
 * Yeni yorum dizisi: genel (file yok) ya da dosyaya/satıra bağlı. file depo köküne göre
 * ("/src/A.java"); satır isteğin son halindeki (sağ taraf) satırdır. Satıra bağlı yorum, dosyanın son
 * yinelemedeki changeTrackingId'siyle gönderilir (yoksa yalnızca threadContext — bulutta sunucu
 * kendisi tamamlıyor). Başlangıç ve bitiş hep birlikte (bitiş yoksa web arayüzü çöküyor); bitiş
 * sütunu dışlayıcı — 9999 satırın tamamı (Microsoft'un simple_ado'su da böyle).
 * status: 1 = açık (bulgu), 4 = kapatıldı (bilgi/özet — "yorumlar çözülmeli" kuralı birleştirmeyi kilitlemesin).
 */
export async function createThread(
  c: TfsConnection,
  pr: TfsPullRequest,
  content: string,
  at?: { file: string; line?: number; lineEnd?: number; changeTrackingId?: number; iteration?: number },
  signal?: AbortSignal,
  status = 1,
): Promise<number | undefined> {
  const v = await ver(c, signal);
  const file = at?.file ? "/" + at.file.replace(/\\/g, "/").replace(/^\/+/, "") : undefined;
  const line = at?.line && at.line > 0 ? at.line : undefined;
  const r = await tfsCall<{ id?: number }>(c, "POST", `${prBase(pr)}/threads`, {
    query: { "api-version": v },
    json: {
      comments: [{ parentCommentId: 0, content, commentType: 1 }],
      status,
      ...(file
        ? {
            threadContext: {
              filePath: file,
              ...(line
                ? {
                    rightFileStart: { line, offset: 1 },
                    rightFileEnd: { line: Math.max(line, at?.lineEnd ?? line), offset: 9999 },
                  }
                : {}),
            },
            ...(at?.changeTrackingId && at.iteration
              ? {
                  pullRequestThreadContext: {
                    changeTrackingId: at.changeTrackingId,
                    iterationContext: { firstComparingIteration: at.iteration, secondComparingIteration: at.iteration },
                  },
                }
              : {}),
          }
        : {}),
    },
    what: `!${pr.id} yeni yorum`,
    signal,
  });
  return r?.id;
}

/** Depo bilgisi (PR açmak için): ad → kimlik, varsayılan dal */
export async function getRepository(
  c: TfsConnection,
  project: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ id: string; name: string; defaultBranch?: string; webUrl?: string }> {
  const v = await ver(c, signal);
  const r = await tfsCall<{ id?: string; name?: string; defaultBranch?: string; webUrl?: string }>(
    c,
    "GET",
    `/${enc(project)}/_apis/git/repositories/${enc(name)}`,
    { query: { "api-version": v }, what: `"${name}" deposu`, signal },
  );
  if (!r?.id) throw new TfsError(`"${name}" deposu bulunamadı`, 404);
  return {
    id: r.id,
    name: r.name ?? name,
    ...(r.defaultBranch ? { defaultBranch: shortRef(r.defaultBranch) } : {}),
    ...(r.webUrl ? { webUrl: r.webUrl } : {}),
  };
}

/** PR açar; iş öğeleri bağlanır. Aynı dallar için açık PR varsa onu döndürür. */
export async function createPullRequest(
  c: TfsConnection,
  o: {
    project: string;
    repositoryId: string;
    repositoryName: string;
    source: string;
    target: string;
    title: string;
    description: string;
    workItems: number[];
    draft?: boolean;
  },
  signal?: AbortSignal,
): Promise<{ id: number; webUrl: string; existed?: boolean; artifactId?: string }> {
  const v = await ver(c, signal);
  const base = `/${enc(o.project)}/_apis/git/repositories/${enc(o.repositoryId)}/pullrequests`;
  const web = (id: number) => `${c.url}/${enc(o.project)}/_git/${enc(o.repositoryName)}/pullrequest/${id}`;
  try {
    const r = await tfsCall<{ pullRequestId?: number; artifactId?: string }>(c, "POST", base, {
      query: { "api-version": v },
      json: {
        sourceRefName: `refs/heads/${o.source}`,
        targetRefName: `refs/heads/${o.target}`,
        title: o.title.slice(0, 400),
        // Açıklama sınırı 4000 karakter
        description: o.description.length > 3990 ? o.description.slice(0, 3980) + "\n…" : o.description,
        ...(o.workItems.length ? { workItemRefs: o.workItems.map((id) => ({ id: String(id) })) } : {}),
        ...(o.draft && Number(v) >= 5 ? { isDraft: true } : {}),
      },
      what: "PR açma",
      signal,
    });
    if (typeof r?.pullRequestId !== "number") throw new TfsError("çekme isteği açıldı ama numarası okunamadı");
    return { id: r.pullRequestId, webUrl: web(r.pullRequestId), ...(r.artifactId ? { artifactId: r.artifactId } : {}) };
  } catch (e) {
    // Aynı kaynak/hedef için açık istek var (409, TF401179 / GitPullRequestExistsException): onu bul.
    // Süzgeç eski sürümde farklı adlı olduğu için sonuç burada da süzülür
    if (e instanceof TfsError && (e.status === 409 || /PullRequestExists|TF401179/i.test(`${e.code} ${e.message}`))) {
      const src = `refs/heads/${o.source}`;
      const dst = `refs/heads/${o.target}`;
      const r = await tfsCall<{ value?: Array<RawPr & { artifactId?: string }> }>(c, "GET", base, {
        query: {
          "api-version": v,
          [crit(v, "status")]: "active",
          [crit(v, "sourceRefName")]: src,
          [crit(v, "targetRefName")]: dst,
          $top: 100,
        },
        what: "açık çekme isteği",
        signal,
      }).catch(() => undefined);
      const hit = (r?.value ?? []).find((p) => p.sourceRefName === src && p.targetRefName === dst);
      if (hit?.pullRequestId) {
        return {
          id: hit.pullRequestId,
          webUrl: web(hit.pullRequestId),
          existed: true,
          ...(hit.artifactId ? { artifactId: hit.artifactId } : {}),
        };
      }
    }
    throw e;
  }
}

/**
 * Uzak depo adresinden depo bilgisi: `{https klon adresi}/vsts/info` — koleksiyon, proje ve depo
 * kimliğini sunucu söyler (adresi ayrıştırmaktan güvenli: depo adı projeyle aynıysa adreste proje
 * yazmıyor). Yalnızca ayarlardaki sunucuyla aynı ana makinedeki http(s) adreslere sorulur.
 */
export async function repoInfoFromRemote(
  c: TfsConnection,
  remoteUrl: string,
  signal?: AbortSignal,
): Promise<{ id: string; name: string; project: string } | undefined> {
  let u: URL;
  try {
    u = new URL(remoteUrl.trim().replace(/\.git$/i, ""));
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(u.protocol) || u.hostname.toLowerCase() !== new URL(c.url).hostname.toLowerCase())
    return undefined;
  u.username = "";
  u.password = "";
  const r = await tfsCall<{ repository?: { id?: string; name?: string; project?: { name?: string } } }>(
    c,
    "GET",
    `${u.toString().replace(/\/+$/, "")}/vsts/info`,
    { what: "depo bilgisi", signal },
  ).catch(() => undefined);
  const repo = r?.repository;
  return repo?.id && repo.name && repo.project?.name
    ? { id: repo.id, name: repo.name, project: repo.project.name }
    : undefined;
}
