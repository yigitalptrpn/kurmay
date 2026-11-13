import fs from "node:fs";
import path from "node:path";
import type { TimedEvent } from "./events.js";
import { readRunLogs } from "./runtime.js";

/**
 * Oturum arama (panelde sol sütundaki kutu): görevler, planlar, ajan mesajları,
 * dosya/komut, Teftiş, ret gerekçesi, hata ve güvenlik raporları içinde arar.
 * Kaynak, panelin oturumu yeniden oynatırken kullandığı olay geçmişiyle AYNI —
 * sonuçtaki `ei` panelde o olayın satırına atlamak için olay sırasıdır.
 * Eşleşme büyük/küçük harfe ve Türkçe harflere duyarsız ("siparis" → "Sipariş").
 */

export type SearchKind =
  | "gorev" | "plan" | "cikti" | "mesaj" | "dosya" | "komut" | "teftis" | "ret" | "hata" | "guvenlik";
export const SEARCH_KINDS: readonly SearchKind[] =
  ["gorev", "plan", "cikti", "mesaj", "dosya", "komut", "teftis", "ret", "hata", "guvenlik"];

/** Bir olaydan çıkan aranabilir metin */
interface Doc {
  ei: number;
  ts: string;
  kind: SearchKind;
  agent?: string;
  text: string;
  folded: string;
}

export interface SearchHit {
  ei: number;
  ts: string;
  kind: SearchKind;
  agent?: string;
  /** Eşleşmenin çevresi; marks = vurgulanacak [başlangıç, bitiş) aralıkları */
  snippet: string;
  marks: Array<[number, number]>;
}

export interface SessionResult {
  session: string;
  name: string;
  updatedAt: string;
  targetDir?: string;
  /** Bu oturumdaki toplam eşleşme (hits sınırlı olabilir) */
  total: number;
  hits: SearchHit[];
}

/** Uzun çıktıların yalnızca başı aranır — büyük kod blokları aramayı yavaşlatmasın */
const TEXT_MAX = 20_000;
const SNIPPET = 160;

const FOLD: Record<string, string> = {
  ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u",
  Ç: "c", Ğ: "g", I: "i", İ: "i", Ö: "o", Ş: "s", Ü: "u", Â: "a", Î: "i", Û: "u",
};

/** Küçük harf + Türkçe harfleri sadeleştir; uzunluk korunur (vurgu aralıkları özgün metne denk gelsin) */
export function fold(s: string): string {
  let out = "";
  for (const c of s) {
    const m = FOLD[c] ?? c.toLowerCase();
    // Uzunluğu değiştiren dönüşüm (nadir: ß vb.) olduğu gibi kalır
    out += m.length === c.length ? m : c;
  }
  return out;
}

/** Sorguyu terimlere böler: tırnak içi tek terim, diğerleri boşlukla */
export function parseQuery(q: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (let m = re.exec(q); m; m = re.exec(q)) {
    const t = fold((m[1] ?? m[2]).trim());
    if (t) terms.push(t);
  }
  return terms;
}

/** Şemanın sabit (İngilizce) değerli alanları — ekranda görünmesin, aramaya da girmesin */
const ENUM_KEYS = new Set(["route", "approved", "action", "severity", "risk"]);

/** Yapılandırılmış çıktıdaki tüm metinler (sabit değerli alanlar hariç) */
function flatten(v: unknown, out: string[], key = ""): void {
  if (ENUM_KEYS.has(key)) return;
  if (typeof v === "string") {
    if (v.trim()) out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) flatten(x, out);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) flatten(x, out, k);
  }
}

/** Yapılandırılmış çıktının türü: plan / Teftiş kararı / güvenlik raporu / diğer */
function structuredKind(s: Record<string, unknown>): SearchKind {
  if ("file_plan" in s || "answer" in s) return "plan";
  if ("approved" in s && "issues" in s) return "teftis";
  if ("findings" in s && "risk" in s) return "guvenlik";
  return "cikti";
}

/** Olaydan aranabilir metinler. Aynı bilgi iki olayda geçiyorsa (plan hem ajan çıktısında hem
 *  onay kartında) yalnızca biri alınır — sonuçlar yinelenmesin */
function eventTexts(e: TimedEvent): Array<{ kind: SearchKind; text: string; agent?: string }> {
  switch (e.type) {
    case "workflow_started":
      return [
        { kind: "gorev", text: e.task },
        ...(e.attachments ?? []).map((a) => ({ kind: "gorev" as const, text: a.original })),
        // TFS: iş öğesinin / çekme isteğinin ekibe giden metni (açıklama, kabul kriterleri, yorumlar…)
        ...(e.workItem?.text ? [{ kind: "gorev" as const, text: e.workItem.text }] : []),
        ...(e.pr?.text ? [{ kind: "gorev" as const, text: e.pr.text }] : []),
      ];
    case "agent_text":
      return [{ kind: "mesaj", text: e.text, agent: e.agent }];
    case "agent_finished": {
      const s = e.structured;
      if (!s || typeof s !== "object") return [];
      const parts: string[] = [];
      flatten(s, parts);
      return parts.length ? [{ kind: structuredKind(s as Record<string, unknown>), text: parts.join(" · "), agent: e.agent }] : [];
    }
    case "tool_used":
      if (e.command) return [{ kind: "komut", text: e.command, agent: e.agent }];
      return [{ kind: "dosya", text: e.file || e.detail, agent: e.agent }];
    case "approval_resolved":
      return !e.approved && e.comment ? [{ kind: "ret", text: e.comment, agent: e.agent }] : [];
    case "workflow_failed":
      return [{ kind: "hata", text: e.error }];
    default:
      return [];
  }
}

function toDocs(events: readonly TimedEvent[], offset = 0): Doc[] {
  const docs: Doc[] = [];
  events.forEach((e, i) => {
    for (const t of eventTexts(e)) {
      if (!t.text) continue;
      const text = t.text.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
      if (text) docs.push({ ei: offset + i, ts: e.ts, kind: t.kind, ...(t.agent ? { agent: t.agent } : {}), text, folded: fold(text) });
    }
  });
  return docs;
}

/** Kayıt dosyası başına çıkarılmış metinler — dosya değişmedikçe yeniden okunmaz */
const fileCache = new Map<string, { mtimeMs: number; size: number; count: number; docs: Doc[] }>();

function fileDocs(runsDir: string, file: string): { count: number; docs: Doc[] } {
  const full = path.join(runsDir, file);
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    return { count: 0, docs: [] }; // silinmiş kayıt — panel de atlıyor
  }
  const hit = fileCache.get(full);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const events = readRunLogs(runsDir, [file]);
  const entry = { mtimeMs: st.mtimeMs, size: st.size, count: events.length, docs: toDocs(events) };
  fileCache.set(full, entry);
  return entry;
}

/** Oturumun tüm metinleri; olay sırası panelin yeniden oynatmasıyla aynı */
function sessionDocs(runsDir: string, runLogs: readonly string[], history?: readonly TimedEvent[]): Doc[] {
  // Bellekteki oturum: panel tam olarak bu geçmişi oynatır (koşu sırasında eklenenler dahil)
  if (history) return toDocs(history);
  const docs: Doc[] = [];
  let offset = 0;
  for (const f of runLogs) {
    const { count, docs: d } = fileDocs(runsDir, f);
    for (const x of d) docs.push(offset ? { ...x, ei: x.ei + offset } : x);
    offset += count;
  }
  return docs;
}

function snippetOf(doc: Doc, terms: string[]): { snippet: string; marks: Array<[number, number]> } {
  const first = Math.min(...terms.map((t) => doc.folded.indexOf(t)).filter((i) => i >= 0));
  let start = Math.max(0, first - Math.floor(SNIPPET / 3));
  // Kelime ortasından başlamasın
  if (start > 0) {
    const sp = doc.text.indexOf(" ", start);
    if (sp > 0 && sp < first) start = sp + 1;
  }
  const end = Math.min(doc.text.length, start + SNIPPET);
  const pre = start > 0 ? "…" : "";
  const post = end < doc.text.length ? "…" : "";
  const snippet = pre + doc.text.slice(start, end) + post;
  const window = doc.folded.slice(start, end);
  const marks: Array<[number, number]> = [];
  for (const t of terms) {
    for (let i = window.indexOf(t); i >= 0; i = window.indexOf(t, i + t.length)) {
      marks.push([pre.length + i, pre.length + i + t.length]);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  // Çakışan aralıklar birleşir
  const merged: Array<[number, number]> = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([m[0], m[1]]);
  }
  return { snippet, marks: merged };
}

export interface SearchSource {
  id: string;
  name: string;
  updatedAt: string;
  targetDir?: string;
  runLogs: readonly string[];
  /** Oturum bellekteyse geçmişi (panelin oynattığı) */
  history?: readonly TimedEvent[];
}

export function searchSessions(
  runsDir: string,
  sources: readonly SearchSource[],
  q: string,
  opts: { kind?: SearchKind; perSession?: number; maxSessions?: number } = {},
): { results: SessionResult[]; sessions: number; hits: number; truncated: boolean } {
  const terms = parseQuery(q);
  const perSession = opts.perSession ?? 20;
  const maxSessions = opts.maxSessions ?? 50;
  const results: SessionResult[] = [];
  let hits = 0;
  let truncated = false;
  if (!terms.length) return { results, sessions: 0, hits, truncated };
  for (const s of sources) {
    const found: SearchHit[] = [];
    let total = 0;
    for (const d of sessionDocs(runsDir, s.runLogs, s.history)) {
      if (opts.kind && d.kind !== opts.kind) continue;
      if (!terms.every((t) => d.folded.includes(t))) continue;
      total++;
      if (found.length < perSession) {
        found.push({ ei: d.ei, ts: d.ts, kind: d.kind, ...(d.agent ? { agent: d.agent } : {}), ...snippetOf(d, terms) });
      }
    }
    if (!total) continue;
    if (results.length >= maxSessions) {
      truncated = true;
      continue;
    }
    hits += total;
    if (total > found.length) truncated = true;
    results.push({ session: s.id, name: s.name, updatedAt: s.updatedAt, ...(s.targetDir ? { targetDir: s.targetDir } : {}), total, hits: found });
  }
  return { results, sessions: results.length, hits, truncated };
}
