import path from "node:path";
import type { FileInput } from "./attachments.js";
import type { TimedEvent } from "./events.js";
import {
  attachmentFileName,
  attachmentGuid,
  downloadAttachment,
  downloadSameOrigin,
  getComments,
  getSummaries,
  getWorkItem,
  TfsError,
  type TfsComment,
  type TfsConnection,
  type TfsWorkItem,
} from "./tfs.js";
import { htmlToMarkdown, imageSources } from "./tfsHtml.js";

/**
 * TFS iş öğesi → ajanlara giden görev. Elle kopyalamanın yerine: Kurmay iş öğesini
 * (alanlar, zengin metin bölümleri, tartışma, bağlı öğeler, ekler ve metindeki görseller)
 * TFS'ten alır, okunur Markdown'a çevirir; ekleri indirip görev ekleri gibi kaydettirir
 * (ajanlar Read ile açar; PDF/Word metni çıkarılır). Bitince sonucu iş öğesine yazmak
 * için taslağı da buradan üretir.
 */

/** Ajan bağlamı sınırlı (yerel model) — bölümler ve yorumlar kırpılır, kırpıldığı yazılır */
const SECTION_MAX = 8000;
const COMMENT_MAX = 1500;
const COMMENTS_IN_TASK = 10;
const PARENT_MAX = 1500;
const TASK_MAX = 40_000;
/** İndirilecek ekler: adet, dosya başına ve toplam bayt sınırı */
const FILES_MAX = 20;
const FILE_BYTES = 20 * 1024 * 1024;
const TOTAL_BYTES = 80 * 1024 * 1024;

const kirp = (s: string, n: number): string => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + " …(kırpıldı)" : s);
const tarih = (iso?: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** Bölüm adından dosya adı öneki: "Yeniden üretme adımları" → "adimlar" */
function sectionSlug(field: string): string {
  const known: Record<string, string> = {
    "Microsoft.VSTS.TCM.ReproSteps": "adimlar",
    "System.Description": "aciklama",
    "Microsoft.VSTS.Common.AcceptanceCriteria": "kabul",
    "Microsoft.VSTS.TCM.SystemInfo": "sistem",
  };
  return known[field] ?? "alan";
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** Metindeki görselin karşılığı: indirilecek ek ya da indirilmeyecek dış adres/veri */
interface ImageRef {
  /** TFS eki: GUID; data: adresi: içerik; url: aynı sunucudaki başka biçimli adres (eski FileID biçimi) */
  guid?: string;
  data?: Buffer;
  url?: string;
  /** Kaydedilecek ad (benzersiz) */
  name: string;
  /** İndirilmeyecekse neden */
  skip?: string;
}

/** Bir HTML metnindeki görselleri ad ve kaynaklarıyla çıkarır; aynı ek iki kez sayılmaz */
function collectImages(html: string, prefix: string, seen: Map<string, ImageRef>, counter: { n: number }, origin = ""): Map<string, ImageRef> {
  const bySrc = new Map<string, ImageRef>();
  for (const src of imageSources(html)) {
    const guid = attachmentGuid(src);
    if (guid) {
      const had = seen.get(guid);
      if (had) {
        bySrc.set(src, had);
        continue;
      }
      const orig = attachmentFileName(src) ?? "";
      const ext = IMG_EXT.exec(orig)?.[0]?.toLowerCase() ?? ".png";
      const ref: ImageRef = { guid, name: `${prefix}-gorsel-${++counter.n}${ext}` };
      seen.set(guid, ref);
      bySrc.set(src, ref);
      continue;
    }
    const data = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
    if (data) {
      const ext = data[1].toLowerCase().replace("jpeg", "jpg");
      bySrc.set(src, { data: Buffer.from(data[2].replace(/\s+/g, ""), "base64"), name: `${prefix}-gorsel-${++counter.n}.${ext}` });
      continue;
    }
    let host = "";
    try {
      const u = new URL(src, origin || undefined);
      host = u.host;
      // Ayarlardaki sunucunun kendi adresi (ör. eski "?FileID=" biçimi, göreli adres): anahtarla indirilir
      if (origin && u.origin.toLowerCase() === origin.toLowerCase()) {
        const had = seen.get(u.toString());
        if (had) {
          bySrc.set(src, had);
          continue;
        }
        const orig = u.searchParams.get("fileName") ?? u.searchParams.get("FileName") ?? "";
        const ext = IMG_EXT.exec(orig)?.[0]?.toLowerCase() ?? ".png";
        const ref: ImageRef = { url: u.toString(), name: `${prefix}-gorsel-${++counter.n}${ext}` };
        seen.set(u.toString(), ref);
        bySrc.set(src, ref);
        continue;
      }
    } catch {
      /* bozuk adres */
    }
    bySrc.set(src, { name: "", skip: host ? `dış adres: ${host}` : "adres okunamadı" });
  }
  return bySrc;
}

/** Görselin metindeki yer tutucusu */
function imageText(ref: ImageRef | undefined): string {
  if (!ref) return "[görsel]";
  if (ref.skip) return `[görsel — indirilmedi, ${ref.skip}]`;
  return `[görsel: ${ref.name} — Ekler bölümünde]`;
}

// ── Önizleme (panel) ──────────────────────────────────────────────────────

export interface WorkItemPreview {
  id: number;
  project: string;
  type: string;
  title: string;
  state: string;
  reason?: string;
  assignedTo?: string;
  createdBy?: string;
  createdDate?: string;
  area?: string;
  iteration?: string;
  tags: string[];
  facts: Array<{ label: string; value: string }>;
  extra: Array<{ label: string; value: string }>;
  sections: Array<{ label: string; markdown: string }>;
  comments: Array<{ author: string; date: string; markdown: string }>;
  commentCount: number;
  attachments: Array<{ name: string; guid: string; size?: number; image: boolean }>;
  /** Metindeki görseller (TFS eki olanlar) — panelde küçük resim */
  images: Array<{ name: string; guid: string }>;
  /** Metindeki görsel sayısı (indirilebilenler) */
  inlineImages: number;
  links: Array<{ label: string; id: number; title?: string; type?: string; state?: string }>;
  code: string[];
  hyperlinks: string[];
  webUrl: string;
}

/** Bağlı öğelerin başlık/tür/durumu (okunamayanlar boş kalır) */
async function fillLinks(c: TfsConnection, item: TfsWorkItem, signal?: AbortSignal): Promise<void> {
  if (!item.links.length) return;
  const sum = await getSummaries(c, item.links.map((l) => l.id), signal).catch(() => new Map());
  for (const l of item.links) {
    const s = sum.get(l.id);
    if (s) Object.assign(l, { title: s.title, type: s.type, state: s.state });
  }
}

/** Panelin iş öğesi kartı için: indirme yapmaz, görseller adlarıyla yazılır */
export async function previewWorkItem(c: TfsConnection, id: number, signal?: AbortSignal): Promise<WorkItemPreview> {
  const item = await getWorkItem(c, id, signal);
  const [comments] = await Promise.all([
    getComments(c, item, 50, signal).catch((): TfsComment[] => []),
    fillLinks(c, item, signal),
  ]);
  const seen = new Map<string, ImageRef>();
  const counter = { n: 0 };
  const sections = item.sections.map((s) => {
    const imgs = collectImages(s.html, sectionSlug(s.field), seen, counter, new URL(c.url).origin);
    return { label: s.label, markdown: htmlToMarkdown(s.html, { image: (src) => imageText(imgs.get(src)) }) };
  });
  const shown = comments.slice(-20).map((cm) => {
    const imgs = collectImages(cm.html, "yorum", seen, counter, new URL(c.url).origin);
    return { author: cm.author, date: cm.date, markdown: htmlToMarkdown(cm.html, { image: (src) => imageText(imgs.get(src)) }) };
  });
  return {
    id: item.id,
    project: item.project,
    type: item.type,
    title: item.title,
    state: item.state,
    ...(item.reason ? { reason: item.reason } : {}),
    ...(item.assignedTo ? { assignedTo: item.assignedTo } : {}),
    ...(item.createdBy ? { createdBy: item.createdBy } : {}),
    ...(item.createdDate ? { createdDate: item.createdDate } : {}),
    ...(item.area ? { area: item.area } : {}),
    ...(item.iteration ? { iteration: item.iteration } : {}),
    tags: item.tags,
    facts: item.facts,
    extra: item.extra,
    sections,
    comments: shown,
    commentCount: comments.length,
    attachments: item.attachments.map((a) => ({ name: a.name, guid: a.guid, ...(a.size !== undefined ? { size: a.size } : {}), image: IMG_EXT.test(a.name) })),
    images: [...seen.values()].filter((r) => r.guid).map((r) => ({ name: r.name, guid: r.guid! })),
    inlineImages: [...seen.values()].filter((r) => r.guid || r.data || r.url).length,
    links: item.links.map((l) => ({ label: l.label, id: l.id, ...(l.title !== undefined ? { title: l.title, type: l.type, state: l.state } : {}) })),
    code: item.code,
    hyperlinks: item.hyperlinks,
    webUrl: item.webUrl,
  };
}

// ── Görev (ajanlar) ───────────────────────────────────────────────────────

/** Koşunun iş öğesi bilgisi — workflow_started olayında taşınır, oturuma bağlanır */
export interface WorkItemMeta {
  id: number;
  type: string;
  title: string;
  state: string;
  url: string;
  project: string;
  assignedTo?: string;
}

export interface PreparedWorkItemTask {
  meta: WorkItemMeta;
  /** Ajanlara giden metin: talimat + içerik (ekler bölümü hariç — o, kaydedilen dosyaların yollarıyla sonradan eklenir) */
  text: string;
  /** Ekranda (görev balonu, arama) gösterilen kısım: yalnızca iş öğesinin içeriği — ajan talimatı yok */
  display: string;
  /** İndirilen ekler ve görseller — görev ekleri gibi kaydedilir */
  files: FileInput[];
  /** İndirilemeyenler ("video.mp4 — 48 MB, sınır 20 MB") */
  skipped: string[];
}

/**
 * İş öğesini görev olarak hazırlar: okur, yorumları ve bağlı öğeleri ekler, ekleri ve
 * metindeki görselleri indirir. userNote: kullanıcının görev kutusuna yazdığı ek talimat.
 */
export async function prepareWorkItemTask(
  c: TfsConnection,
  id: number,
  userNote: string,
  signal?: AbortSignal,
): Promise<PreparedWorkItemTask> {
  const item = await getWorkItem(c, id, signal);
  const [comments] = await Promise.all([
    getComments(c, item, COMMENTS_IN_TASK, signal).catch((): TfsComment[] => []),
    fillLinks(c, item, signal),
  ]);

  // Üst öğenin özü (ör. hatanın bağlı olduğu ürün iş öğesi, PBI'ın özelliği) — bağlam için
  let parentText = "";
  const parentLink = item.links.find((l) => l.kind === "parent");
  if (parentLink) {
    try {
      const p = await getWorkItem(c, parentLink.id, signal);
      const body = p.sections
        .filter((s) => s.field === "System.Description" || s.field === "Microsoft.VSTS.Common.AcceptanceCriteria")
        .map((s) => `**${s.label}:**\n${htmlToMarkdown(s.html, { image: () => "[görsel]" })}`)
        .join("\n\n");
      if (body.trim()) parentText = `### Üst öğe #${p.id} — ${p.title} (${p.type}, ${p.state})\n${kirp(body, PARENT_MAX)}`;
    } catch {
      /* okunamadı — başlığı bağlı öğeler listesinde zaten var */
    }
  }

  // Görseller: bölümler + son yorumlar; ekler: iş öğesine eklenmiş dosyalar
  const seen = new Map<string, ImageRef>();
  const counter = { n: 0 };
  const origin = new URL(c.url).origin;
  const sectionImgs = item.sections.map((s) => collectImages(s.html, sectionSlug(s.field), seen, counter, origin));
  const commentImgs = comments.map((cm) => collectImages(cm.html, "yorum", seen, counter, origin));

  const files: FileInput[] = [];
  const skipped: string[] = [];
  let total = 0;
  const take = async (name: string, guid: string | undefined, data: Buffer | undefined, size?: number, url?: string) => {
    if (files.length >= FILES_MAX) return skipped.push(`${name} — en fazla ${FILES_MAX} dosya indirilir`);
    if (size !== undefined && size > FILE_BYTES) return skipped.push(`${name} — ${Math.round(size / 1024 / 1024)} MB, sınır ${FILE_BYTES / 1024 / 1024} MB`);
    try {
      const buf = data ?? (url ? await downloadSameOrigin(c, url, FILE_BYTES, signal) : await downloadAttachment(c, guid!, name, FILE_BYTES, signal));
      if (total + buf.length > TOTAL_BYTES) return skipped.push(`${name} — toplam ${TOTAL_BYTES / 1024 / 1024} MB sınırı`);
      total += buf.length;
      files.push({ name, data: buf });
    } catch (e) {
      if (e instanceof TfsError && e.code === "ABORTED") throw e;
      skipped.push(`${name} — indirilemedi: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // Önce metindeki görseller (görevin parçası), sonra ekler
  const inlineRefs = [...new Set([...seen.values(), ...commentImgs.flatMap((m) => [...m.values()]), ...sectionImgs.flatMap((m) => [...m.values()])])];
  for (const ref of inlineRefs) {
    if (ref.skip || !ref.name) continue;
    await take(ref.name, ref.guid, ref.data, undefined, ref.url);
  }
  for (const a of item.attachments) {
    if (seen.has(a.guid)) continue; // metinde görsel olarak zaten indirildi
    await take(a.name, a.guid, undefined, a.size);
  }

  // ── Metin ──
  // Ajan talimatı ekranda gösterilmez (görev balonunda yalnızca iş öğesinin içeriği)
  const guide = [
    `Bu görev TFS'teki #${item.id} numaralı iş öğesidir — Kurmay iş öğesini TFS'ten aldı (alanlar, bölümler, ` +
      "tartışma, bağlı öğeler; ekler ve metindeki görseller indirildi).",
    "- Hata ise: yeniden üretme adımları ve sistem bilgisiyle kök nedeni bul ve düzelt; yalnızca belirtiyi gizleme.",
    "- Ürün iş öğesi / kullanıcı hikâyesi ise: kabul kriterlerinin HEPSİNİ karşıla — karşılanmayan kriter kalmasın.",
    "- Tartışmadaki son kararlar açıklamadaki eski bilgiden önce gelir. Belirsiz ya da çelişkili bir nokta varsa makul bir varsayım seç ve yaz.",
    `- ${SADE_DIL}`,
  ].join("\n");
  const L: string[] = [];
  if (userNote.trim()) L.push("## Kullanıcının ek talimatı (öncelikli)", userNote.trim(), "");

  L.push(`## #${item.id} — ${item.title}`);
  const line = (parts: Array<string | undefined | false>) => parts.filter(Boolean).join(" · ");
  L.push(`- ${line([`Tür: ${item.type}`, `Durum: ${item.state}${item.reason ? ` (neden: ${item.reason})` : ""}`])}`);
  const kim = line([item.assignedTo && `Atanan: ${item.assignedTo}`, item.createdBy && `Oluşturan: ${item.createdBy}${item.createdDate ? ` (${tarih(item.createdDate)})` : ""}`]);
  if (kim) L.push(`- ${kim}`);
  if (item.facts.length) L.push(`- ${item.facts.map((f) => `${f.label}: ${f.value}`).join(" · ")}`);
  const yer = line([item.area && `Alan: ${item.area}`, item.iteration && `Yineleme: ${item.iteration}`]);
  if (yer) L.push(`- ${yer}`);
  if (item.tags.length) L.push(`- Etiketler: ${item.tags.join(", ")}`);
  L.push(`- Adres: ${item.webUrl}`);

  item.sections.forEach((s, i) => {
    const md = htmlToMarkdown(s.html, { image: (src) => imageText(sectionImgs[i].get(src)) });
    if (md.trim()) L.push("", `### ${s.label}`, kirp(md, SECTION_MAX));
  });

  if (item.extra.length) {
    L.push("", "### Diğer alanlar", ...item.extra.map((e) => `- ${e.label}: ${e.value}`));
  }

  if (item.links.length) {
    L.push("", "### Bağlı öğeler");
    for (const l of item.links) {
      L.push(`- ${l.label}: #${l.id}${l.title !== undefined ? ` (${l.type}, ${l.state}) ${l.title}` : " (okunamadı)"}`);
    }
    if (parentText) L.push("", parentText);
  }
  if (item.code.length) L.push("", "### Bağlı kod", `- ${item.code.join(", ")}`);
  if (item.hyperlinks.length) L.push("", "### Bağlantılar", ...item.hyperlinks.map((h) => `- ${h}`));

  if (comments.length) {
    L.push("", `### Tartışma (son ${comments.length} yorum, eskiden yeniye)`);
    comments.forEach((cm, i) => {
      const md = htmlToMarkdown(cm.html, { image: (src) => imageText(commentImgs[i].get(src)) });
      if (md.trim()) L.push("", `**${cm.author} — ${tarih(cm.date)}**`, kirp(md, COMMENT_MAX));
    });
  }

  const names = files.map((f) => f.name);
  if (names.length || skipped.length) {
    L.push("", "### İş öğesinin ekleri");
    if (names.length) L.push(`İndirilenler (yolları aşağıdaki "Ekler" bölümünde): ${names.join(", ")}`);
    if (skipped.length) L.push(`İndirilemeyenler: ${skipped.join("; ")}`);
  }

  let display = L.join("\n");
  if (display.length > TASK_MAX) display = display.slice(0, TASK_MAX).replace(/\s+\S*$/, "") + "\n…(iş öğesi metni çok uzun, kırpıldı)";
  const text = `${guide}\n\n${display}`;
  return {
    meta: {
      id: item.id,
      type: item.type,
      title: item.title,
      state: item.state,
      url: item.webUrl,
      project: item.project,
      ...(item.assignedTo ? { assignedTo: item.assignedTo } : {}),
    },
    text,
    display,
    files,
    skipped,
  };
}

/** Oturum adı / koşu etiketi: "#12345 · Başlık" */
export function workItemLabel(meta: { id: number; title: string }): string {
  const t = meta.title.trim();
  return `#${meta.id} · ${t.length > 70 ? t.slice(0, 70) + "…" : t}`;
}

// ── Sonucu TFS'e yazma ────────────────────────────────────────────────────

/** Koşunun sonucu iyi bitti mi (yazma yalnızca bu durumda önerilir) */
export function runSucceeded(events: readonly TimedEvent[]): boolean {
  let ok = false;
  for (const e of events) {
    if (e.type === "workflow_finished") ok = true;
    else if (e.type === "workflow_failed" || e.type === "workflow_cancelled" || e.type === "run_schedule_cancelled") return false;
  }
  return ok;
}

/**
 * İş öğesine yazılacak notun taslağı (panelde düzenlenebilir düz metin; gönderirken
 * HTML'e çevrilir): Analist'in özeti ya da cevabı, değişen dosyalar, Teftiş kararı,
 * güvenlik raporu. Kaynak bu koşunun olayları.
 */
/**
 * TFS'e olduğu gibi yazılacak metinler (özet, gerekçe, cevap) için ajanlara giden yazım kuralı —
 * kullanıcı isteği (2026-11-13): "sektör dışı biri bile anlasın, yarım İngilizce yok, laf salatası yok".
 * Sade dil ilkeleri (ISO 24495-1): okuyan aradığını bulur, anlar, kullanır.
 */
export const SADE_DIL =
  "Yazdığın özet, gerekçe ve cevaplar TFS'e olduğu gibi yazılacak; işin dışından biri de anlamalı: kısa cümle, " +
  "günlük kelime, bir cümlede bir bilgi. Türkçesi olan yabancı kelimeyi kullanma (çekme isteği, dal, kayıt, birleştirme…); " +
  "gereksiz söz ve süs yok. Kod, dosya ve sınıf adları olduğu gibi kalır.";

/** Kurmay'ın TFS'e yazdığı her mesajın başlığı (iş öğesi notu, PR cevabı/yorumu, PR açıklaması) —
 *  kullanıcı isteği (2026-11-13): "mesaj atarken başına KURMAY POSTA KOMUTANI gibi bir şey yazsın,
 *  daha askerî dilde". Tek yerde: değiştirmek için yalnızca burası. */
export const POSTA_BASLIK = "**--- KURMAY POSTA KOMUTANI ---**";

export function writeBackDraft(events: readonly TimedEvent[], entryKey: string, targetDir?: string, id?: number): string {
  let summary = "";
  let answer = "";
  let changes: Array<{ file: string; summary?: string }> = [];
  const touched = new Set<string>();
  let verdict: { approved: boolean; summary: string; issues: number } | undefined;
  let security: { risk?: string; total: number; top: string } | undefined;
  const rel = (f: string) => {
    if (!targetDir || !path.isAbsolute(f)) return f.replace(/\\/g, "/");
    const r = path.relative(targetDir, f);
    return (r && !r.startsWith("..") ? r : f).replace(/\\/g, "/");
  };
  for (const e of events) {
    if (e.type === "agent_finished") {
      const st = (e.structured ?? {}) as { summary?: unknown; answer?: unknown; changes?: unknown };
      if (e.agent === entryKey) {
        if (typeof st.summary === "string") summary = st.summary.trim();
        answer = typeof st.answer === "string" ? st.answer.trim() : "";
      }
      if (Array.isArray(st.changes) && e.agent !== entryKey) {
        changes = st.changes
          .map((c) => c as { file?: unknown; summary?: unknown })
          .filter((c) => typeof c.file === "string" && c.file)
          .map((c) => ({ file: rel(String(c.file)), ...(typeof c.summary === "string" && c.summary.trim() ? { summary: c.summary.trim() } : {}) }));
      }
    } else if (e.type === "tool_used" && e.file && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(e.tool)) {
      touched.add(rel(e.file));
    } else if (e.type === "write_blocked") {
      touched.delete(rel(e.file));
    } else if (e.type === "verdict") {
      verdict = { approved: e.approved, summary: e.summary, issues: e.issues.length };
    } else if (e.type === "security_report") {
      const c = e.counts;
      const names: Record<string, string> = { critical: "kritik", high: "yüksek", medium: "orta", low: "düşük" };
      const top = (["critical", "high", "medium", "low"] as const).filter((k) => c[k]).map((k) => `${c[k]} ${names[k]}`).join(", ");
      security = { risk: e.risk, total: Object.values(c).reduce((a, b) => a + b, 0), top };
    }
  }
  const riskNames: Record<string, string> = { none: "yok", low: "düşük", medium: "orta", high: "yüksek", critical: "kritik" };
  const L: string[] = [];
  const codeless = !changes.length && !touched.size && !!answer;
  const no = id ? ` — #${id}` : "";
  L.push(POSTA_BASLIK, codeless ? `**BİLGİ RAPORU${no}**` : `**HAREKÂT RAPORU${no}**`);
  L.push(
    codeless
      ? "**Durum:** İncelendi. Kod değişikliği gerekmedi."
      : `**Durum:** Tamamlandı.${verdict ? (verdict.approved ? " Kod kontrolünden geçti." : " Kod kontrolü onaylamadı.") : ""}`,
  );
  if (codeless) L.push("", `**Cevap:** ${kirp(answer.replace(/\s+/g, " "), 1500)}`);
  else if (summary) L.push("", `**Özet:** ${kirp(summary.replace(/\s+/g, " "), 1500)}`);
  const list: Array<{ file: string; summary?: string }> = changes.length ? changes : [...touched].map((file) => ({ file }));
  if (list.length) {
    L.push("", `**Değişen dosyalar (${list.length}):**`);
    for (const c of list.slice(0, 40)) L.push(`- \`${c.file}\`${c.summary ? ` — ${kirp(c.summary, 200)}` : ""}`);
    if (list.length > 40) L.push(`- … ve ${list.length - 40} dosya daha`);
  }
  if (verdict) {
    L.push("", `**Kod kontrolü:** ${verdict.approved ? "Onaylandı" : `Onaylanmadı (${verdict.issues} sorun)`}${verdict.summary ? ` — ${kirp(verdict.summary.replace(/\s+/g, " "), 600)}` : ""}`);
  }
  if (security) {
    L.push(`**Güvenlik kontrolü:** ${security.total ? `risk ${riskNames[security.risk ?? ""] ?? security.risk ?? "?"}, ${security.total} bulgu${security.top ? ` (${security.top})` : ""}` : "bulgu yok"}`);
  }
  if (!codeless && list.length) L.push("", "*Değişiklikler şimdilik geliştiricinin bilgisayarında; kontrol edilip gönderilmesi gerekiyor.*");
  L.push("", "*Arz ederim. — Kurmay*");
  return L.join("\n");
}

/** Koşuda değişen dosyalar (saha çıktısındaki changes + yazma araçları; engellenenler hariç).
 *  targetDir verilirse yollar ona göre göreli yazılır — aynı dosya tam ve göreli yoluyla iki kez sayılmasın */
export function runChangedFiles(events: readonly TimedEvent[], entryKey: string, targetDir?: string): string[] {
  const norm = (f: string) => {
    if (targetDir && path.isAbsolute(f)) {
      const r = path.relative(targetDir, f);
      if (r && !r.startsWith("..") && !path.isAbsolute(r)) return r.split(path.sep).join("/");
    }
    return f.replace(/\\/g, "/").replace(/^\.\//, "");
  };
  const files = new Set<string>();
  for (const e of events) {
    if (e.type === "agent_finished" && e.agent !== entryKey) {
      const ch = (e.structured as { changes?: Array<{ file?: unknown }> } | undefined)?.changes;
      if (Array.isArray(ch)) for (const x of ch) if (typeof x.file === "string" && x.file && !x.file.endsWith("/")) files.add(norm(x.file));
    } else if (e.type === "tool_used" && e.file && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(e.tool)) files.add(norm(e.file));
    else if (e.type === "write_blocked") files.delete(norm(e.file));
  }
  return [...files];
}
