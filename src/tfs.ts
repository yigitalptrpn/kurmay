import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";
import { htmlToMarkdown } from "./tfsHtml.js";

/**
 * TFS / Azure DevOps Server istemcisi — bağımlılıksız (node:http/https), kişisel erişim
 * anahtarıyla (PAT). Neden MCP değil de kod: iş öğesini almak ve sonucu yazmak her
 * seferinde aynı olması gereken mekanik adımlar; anahtar modelin bağlamına girmemeli;
 * yerel modelde araç çağrısı en kırılgan nokta (aynı gerekçe: eski PR düğümü, 3041d64).
 *
 * Sürüm: sunucunun desteklediği en yüksek REST sürümü bir kez sorulur (7.1 istenir,
 * sunucu "aralık dışı" derse mesajındaki en son sürüm alınır) ve önbelleğe girer —
 * TFS 2017 (3.x) / 2018 (4.x) / Azure DevOps Server 2019 (5.x) / 2020 (6.0) / 2022 (7.x)
 * aynı kodla çalışır. Yorumlar: 5.0 ve üstünde yorum ucu, altında iş öğesinin
 * güncelleme geçmişi (System.History). Yazma her sürümde aynı: System.History'ye ekleme.
 *
 * Güvenlik: anahtar YALNIZCA ayarlardaki koleksiyon adresinin sunucusuna gider. İş
 * öğesindeki görsellerin adresi başka bir ada (ör. sunucunun genel adı) işaret etse de
 * ek kimliği (GUID) alınıp ayarlardaki adresten indirilir; başka sunucuya yönlendirme
 * izlenmez. Anahtar panele, olaylara, ajanlara ve günlüğe hiç yazılmaz.
 */

export interface TfsConnection {
  /** Koleksiyon adresi (sonunda / yok): http://sunucu:8080/tfs/DefaultCollection, https://dev.azure.com/kurum */
  url: string;
  /** Takım projesi (sorgular ve bağlantılar için) */
  project: string;
  /** Kişisel erişim anahtarı (PAT) */
  token: string;
  /** Sertifika doğrulamasını atla (kendinden imzalı iç ağ sunucusu) */
  insecureTls?: boolean;
  /** Ek güvenilen kök sertifika (PEM dosyası) — kurum sertifika otoritesi */
  caFile?: string;
}

export class TfsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Sunucunun hata türü (typeKey) ya da ağ hata kodu */
    readonly code?: string,
  ) {
    super(message);
    this.name = "TfsError";
  }
}

/** Koleksiyon adresini sadeleştirir: boşluk, sondaki / ve yanlışlıkla yapıştırılan proje/sayfa kısmı */
export function normalizeCollectionUrl(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

/**
 * Tarayıcıdan kopyalanan bir TFS adresini koleksiyon + proje + iş öğesine ayırır:
 *   http://sunucu:8080/tfs/DefaultCollection/Proje/_workitems/edit/123
 *   https://dev.azure.com/kurum/Proje/_boards/board/…?workitem=123
 *   http://sunucu/tfs/Koleksiyon/Proje/_backlogs/…
 * "_" ile başlayan ilk bölümden önceki bölüm projedir. Ayrılamazsa undefined.
 */
export function parseTfsUrl(input: string): { collection: string; project?: string; id?: number } | undefined {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(u.protocol)) return undefined;
  const segs = u.pathname.split("/").filter(Boolean);
  const idQ = Number(u.searchParams.get("workitem") ?? u.searchParams.get("id") ?? NaN);
  const at = segs.findIndex((s) => s.startsWith("_"));
  const base = `${u.protocol}//${u.host}`;
  if (at <= 0) {
    // Yalnızca koleksiyon adresi yapıştırılmış (…/tfs/DefaultCollection)
    return segs.length ? { collection: `${base}/${segs.join("/")}` } : undefined;
  }
  const project = decodeURIComponent(segs[at - 1]);
  const collSegs = segs.slice(0, at - 1);
  // Bulut: dev.azure.com/{kurum}/{proje}; eski bulut: {kurum}.visualstudio.com/{proje}
  if (!collSegs.length && !/\.visualstudio\.com$/i.test(u.hostname)) return undefined;
  const edit = segs.indexOf("edit");
  const idPath = segs[at] === "_workitems" && edit > at ? Number(segs[edit + 1]) : NaN;
  const id = Number.isInteger(idPath) && idPath > 0 ? idPath : Number.isInteger(idQ) && idQ > 0 ? idQ : undefined;
  return { collection: `${base}${collSegs.length ? "/" + collSegs.join("/") : ""}`, project, ...(id ? { id } : {}) };
}

/** Görev kutusuna yazılan iş öğesi: "12345", "#12345" ya da iş öğesi adresi */
export function parseWorkItemRef(input: string): number | undefined {
  const t = input.trim();
  const m = /^#?\s*(\d{1,9})$/.exec(t);
  if (m) return Number(m[1]);
  return parseTfsUrl(t)?.id;
}

// ── HTTP ──────────────────────────────────────────────────────────────────

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const agents = new Map<string, https.Agent>();

/**
 * Güvenilen kök sertifikalar: Node'un kendi listesi + işletim sisteminin deposu (Windows'ta kurumun
 * Grup İlkesiyle dağıttığı kök sertifika oradadır — tarayıcı TFS'i bu yüzden sorunsuz açar) + varsa
 * Ayarlar'daki sertifika dosyası. Sistem deposu tls.getCACertificates ile okunur (Node 22.15+ / 23.8+);
 * eski Node'da yalnızca Node'un listesi + dosya. DİKKAT: "ca" verilince varsayılan liste ve
 * NODE_EXTRA_CA_CERTS yok sayılır — bu yüzden "default" (ikisini de içerir) listeye katılır.
 */
function trustedRoots(caFile?: string): string[] | undefined {
  const getCA = (tls as unknown as { getCACertificates?: (t: string) => string[] }).getCACertificates;
  let pem: string | undefined;
  if (caFile) {
    try {
      pem = fs.readFileSync(caFile, "utf8");
    } catch {
      throw new TfsError(`sertifika dosyası okunamadı: ${caFile}`, undefined, "CA_FILE");
    }
  }
  if (!getCA) return pem ? [...tls.rootCertificates, pem] : undefined;
  const list = new Set<string>();
  for (const t of ["default", "system"]) {
    try {
      for (const c of getCA(t)) list.add(c);
    } catch {
      /* bu türü desteklemiyor */
    }
  }
  if (pem) list.add(pem);
  return list.size ? [...list] : undefined;
}

/** Ayarlara göre TLS ajanı (bağlantılar yeniden kullanılsın diye önbellekte). Özel ajan ortamdaki
 *  vekil sunucu ayarlarını (HTTPS_PROXY) kullanmaz — iç ağdaki TFS'e istek doğrudan gider. */
function httpsAgent(c: TfsConnection): https.Agent {
  const key = `${c.insecureTls ? 1 : 0}|${c.caFile ?? ""}`;
  let a = agents.get(key);
  if (!a) {
    const ca = c.insecureTls ? undefined : trustedRoots(c.caFile);
    a = new https.Agent({ keepAlive: true, rejectUnauthorized: !c.insecureTls, ...(ca ? { ca } : {}) });
    agents.set(key, a);
  }
  return a;
}
const httpAgent = new http.Agent({ keepAlive: true });

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|DEPTH_ZERO|ALTNAME|ERR_TLS/;

/** Ağ hatasının Türkçe açıklaması */
function networkError(e: unknown, host: string): TfsError {
  if (e instanceof TfsError) return e;
  const code = (e as { code?: string }).code ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  if (TLS_CODES.test(code) || TLS_CODES.test(msg)) {
    return new TfsError(
      `${host} sunucusunun sertifikası doğrulanamadı (${code || msg}) — kurumun kök sertifikasını Ayarlar'daki ` +
        `"sertifika dosyası"na ver ya da iç ağdaysan "sertifika doğrulamasını atla"yı aç`,
      undefined,
      code || "TLS",
    );
  }
  const why: Record<string, string> = {
    ENOTFOUND: "sunucu adı çözülemedi — adresi kontrol et",
    EAI_AGAIN: "sunucu adı çözülemedi (ad sunucusu yanıt vermedi)",
    ECONNREFUSED: "bağlantı reddedildi — adres/port doğru mu, sunucu açık mı",
    ECONNRESET: "bağlantı koptu",
    ETIMEDOUT: "sunucu yanıt vermedi (zaman aşımı)",
    EHOSTUNREACH: "sunucuya ulaşılamıyor (ağ)",
    ENETUNREACH: "ağa ulaşılamıyor",
    EPROTO: "bağlantı kurulamadı — adres http mi https mi, kontrol et",
  };
  return new TfsError(`${host}: ${why[code] ?? msg}`, undefined, code || "NET");
}

interface RequestOptions {
  body?: string | Buffer;
  contentType?: string;
  accept?: string;
  timeoutMs?: number;
  /** Yanıt bundan büyükse kesilir (bayt) */
  maxBytes?: number;
  signal?: AbortSignal;
}

function rawRequest(c: TfsConnection, method: string, url: string, o: RequestOptions, hops = 0): Promise<RawResponse> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const lib = isHttps ? https : http;
  const headers: Record<string, string | number> = {
    authorization: "Basic " + Buffer.from(":" + c.token).toString("base64"),
    accept: o.accept ?? "application/json",
    // Kimlik doğrulama başarısızsa oturum açma sayfasına yönlendirme yerine 401 dönsün
    "x-tfs-fedauthredirect": "Suppress",
    "user-agent": "Kurmay",
  };
  if (o.body !== undefined) {
    headers["content-type"] = o.contentType ?? "application/json";
    headers["content-length"] = Buffer.byteLength(o.body);
  }
  const max = o.maxBytes ?? 50 * 1024 * 1024;
  return new Promise<RawResponse>((resolve, reject) => {
    let agent: http.Agent;
    try {
      agent = isHttps ? httpsAgent(c) : httpAgent;
    } catch (e) {
      return reject(e);
    }
    const req = lib.request(u, { method, headers, agent, timeout: o.timeoutMs ?? 30_000 }, (res) => {
      const status = res.statusCode ?? 0;
      // Yönlendirme: yalnızca aynı sunucuya (http → https yükseltmesi dahil) — anahtar başka yere gitmesin
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u);
        // Oturum açma sayfasına yönlendirme: anahtar kabul edilmedi (izlenirse 203 + HTML sayfası gelir)
        if (/\/_signin|\/_signedin|login\.microsoftonline|vssps\./i.test(next.toString())) {
          return reject(
            new TfsError(
              "sunucu oturum açma sayfasına yönlendirdi — erişim anahtarı kabul edilmedi (yanlış, süresi dolmuş ya da iptal edilmiş)",
              401,
              "SIGNIN",
            ),
          );
        }
        const sameHost = next.hostname.toLowerCase() === u.hostname.toLowerCase();
        if (!sameHost || hops >= 3) {
          return reject(
            new TfsError(
              `sunucu başka bir adrese yönlendirdi (${next.host}) — çoğu zaman oturum açma sayfasıdır: erişim anahtarı ` +
                "geçersiz ya da koleksiyon adresi eksik/yanlış",
              status,
              "REDIRECT",
            ),
          );
        }
        const m = status === 303 ? "GET" : method;
        return resolve(rawRequest(c, m, next.toString(), m === "GET" ? { ...o, body: undefined } : o, hops + 1));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (d: Buffer) => {
        size += d.length;
        if (size > max) {
          req.destroy(
            new TfsError(`yanıt çok büyük (${Math.round(max / 1024 / 1024)} MB sınırı aşıldı)`, status, "TOO_LARGE"),
          );
          return;
        }
        chunks.push(d);
      });
      res.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", (e) => reject(networkError(e, u.host)));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("zaman aşımı"), { code: "ETIMEDOUT" })));
    req.on("error", (e) => reject(networkError(e, u.host)));
    if (o.signal) {
      if (o.signal.aborted) req.destroy(new TfsError("iptal edildi", undefined, "ABORTED"));
      else
        o.signal.addEventListener("abort", () => req.destroy(new TfsError("iptal edildi", undefined, "ABORTED")), {
          once: true,
        });
    }
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** Sunucunun JSON hata gövdesi: { message, typeKey } (yoksa metnin başı) */
function serverMessage(r: RawResponse): { message: string; typeKey?: string } {
  const text = r.body.toString("utf8");
  try {
    const j = JSON.parse(text) as { message?: unknown; typeKey?: unknown; value?: { Message?: unknown } };
    const message =
      typeof j.message === "string" ? j.message : typeof j.value?.Message === "string" ? j.value.Message : "";
    return { message, typeKey: typeof j.typeKey === "string" ? j.typeKey : undefined };
  } catch {
    // HTML hata sayfası: başlığını al
    const t = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
    return {
      message:
        t ??
        text
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200),
    };
  }
}

const isHtml = (r: RawResponse) => /text\/html/i.test(String(r.headers["content-type"] ?? ""));

/** Durum koduna göre Türkçe hata (sunucunun mesajı sonda, olduğu gibi) */
function httpError(r: RawResponse, what: string): TfsError {
  const parsed = serverMessage(r);
  const typeKey = parsed.typeKey;
  // TFS hata metnini X-TFS-ServiceError başlığında da verir (gövde IIS sayfası olsa bile)
  let message = parsed.message;
  const svc = r.headers["x-tfs-serviceerror"];
  if (typeof svc === "string" && svc) {
    try {
      message = decodeURIComponent(svc.replace(/\+/g, " "));
    } catch {
      message = svc;
    }
  }
  const tail = message ? ` — sunucu: ${message}` : "";
  switch (r.status) {
    case 401: {
      // Uygulamanın değil IIS'in reddi: JSON yok, TFS başlıkları yok, yalnızca Windows kimlik doğrulaması öneriliyor
      const auth = String(r.headers["www-authenticate"] ?? "");
      const iis =
        !svc &&
        !/json/i.test(String(r.headers["content-type"] ?? "")) &&
        /negotiate|ntlm/i.test(auth) &&
        !/basic|bearer/i.test(auth);
      return new TfsError(
        iis
          ? "sunucu yalnızca Windows oturumuyla giriş kabul ediyor (IIS'te anonim kimlik doğrulaması kapalı görünüyor) — " +
              "kişisel erişim anahtarının çalışması için sunucu yöneticisi IIS'te anonim kimlik doğrulamasını açık, Temel kimlik doğrulamasını kapalı tutmalı"
          : "erişim anahtarı reddedildi — anahtar yanlış, süresi dolmuş ya da iptal edilmiş olabilir. Anahtar doğruysa: sunucudaki " +
              "IIS'te Temel kimlik doğrulaması açıkken kişisel erişim anahtarı çalışmaz (sunucu yöneticisine sor)" +
              tail,
        401,
        typeKey,
      );
    }
    case 203:
      return new TfsError("sunucu oturum açma sayfası döndürdü — erişim anahtarı geçersiz", 203, typeKey);
    case 403:
      return new TfsError(
        `yetki yok: ${what} (anahtarın kapsamında "İş öğeleri — okuma ve yazma" var mı?)${tail}`,
        403,
        typeKey,
      );
    case 404:
      return new TfsError(`bulunamadı: ${what}${tail}`, 404, typeKey);
    default:
      if (r.status >= 500) return new TfsError(`sunucu hatası (${r.status}): ${what}${tail}`, r.status, typeKey);
      return new TfsError(`${what} başarısız (${r.status})${tail}`, r.status, typeKey);
  }
}

interface CallOptions {
  /** Sorgu parametreleri — anahtar olduğu gibi yazılır ($expand, $top kodlanmaz) */
  query?: Record<string, string | number | undefined>;
  /** JSON gövde (patch: true ise application/json-patch+json) */
  json?: unknown;
  patch?: boolean;
  /** Hata mesajında ne yapıldığı ("#123 okunurken") */
  what: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function buildUrl(c: TfsConnection, pathOrUrl: string, query?: CallOptions["query"]): string {
  const base = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : c.url + pathOrUrl;
  const q = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return q ? `${base}${base.includes("?") ? "&" : "?"}${q}` : base;
}

/** TFS REST çağrısı (JSON) — src/tfsPr.ts de kullanır */
export async function tfsCall<T>(c: TfsConnection, method: string, pathOrUrl: string, o: CallOptions): Promise<T> {
  return call<T>(c, method, pathOrUrl, o);
}

async function call<T>(c: TfsConnection, method: string, pathOrUrl: string, o: CallOptions): Promise<T> {
  const r = await rawRequest(c, method, buildUrl(c, pathOrUrl, o.query), {
    ...(o.json !== undefined
      ? { body: JSON.stringify(o.json), contentType: o.patch ? "application/json-patch+json" : "application/json" }
      : {}),
    signal: o.signal,
    timeoutMs: o.timeoutMs,
  });
  if (r.status === 203 || (r.status >= 200 && r.status < 300 && isHtml(r))) {
    throw new TfsError(
      "sunucu beklenen veri yerine bir web sayfası döndürdü (büyük olasılıkla oturum açma sayfası) — erişim anahtarı geçersiz " +
        "ya da koleksiyon adresi yanlış",
      r.status,
      "HTML",
    );
  }
  if (r.status < 200 || r.status >= 300) throw httpError(r, o.what);
  if (r.status === 204 || r.body.length === 0) return undefined as T;
  try {
    return JSON.parse(r.body.toString("utf8")) as T;
  } catch {
    throw new TfsError(`sunucunun yanıtı okunamadı: ${o.what}`, r.status, "JSON");
  }
}

// ── Sürüm ─────────────────────────────────────────────────────────────────

/** İstenen en yüksek sürüm — daha yenisi gerekmiyor; yeni sunucular eskiyi de kabul eder */
const MAX_VERSION = 7.1;
/** Yayımlanmış (önizleme olmayan) sürümler. Sunucunun en yüksek sürümü önizleme olabilir (ör.
 *  2020 güncellemesi 6.1 der ama düz "6.1" isteğini VssInvalidPreviewVersionException ile reddeder,
 *  "6.0" çalışır) — istekler bu listeden sunucununkine eşit ya da küçük en büyük sürümle gider. */
// 3.1 / 3.2 / 4.0 için belgelenmiş düz sürüm yok (TFS 2017 güncellemeleri ve TFS 2018 ilk sürüm) — oralarda 3.0
const RELEASED = [7.1, 7.0, 6.0, 5.1, 5.0, 4.1, 3.0, 2.0, 1.0];
const versions = new Map<string, Promise<number>>();

/**
 * "Aralık dışı" hatasının mesajındaki sunucu sürümü: mesajdaki, istenenden farklı EN SON sürüm
 * numarası. Görülen biçimler: "…latest REST API version this server supports is 5.1." /
 * "…supported by this server is 5.1." — sunucu dili Türkçeyse metin de Türkçe olabilir, bu yüzden
 * kalıp değil sayı aranır.
 */
export function versionFromOutOfRange(message: string, requested: number): number | undefined {
  const nums = [...message.matchAll(/(\d+)\.(\d+)/g)].map((m) => Number(`${m[1]}.${m[2]}`));
  return nums.filter((n) => n !== requested && n >= 1 && n < 50).pop();
}

const outOfRange = (e: TfsError) =>
  e.status === 400 && (/VersionOutOfRange/i.test(e.code ?? "") || /out of (the valid )?range|aralık/i.test(e.message));

/**
 * Sunucunun desteklediği en yüksek REST sürümü (koleksiyon başına bir kez sorulur).
 * Hafif bir uç (projeler, 1 kayıt) en yüksek sürümle istenir; sunucu "aralık dışı"
 * (VssVersionOutOfRangeException) derse mesajındaki sürüm kullanılır, mesajdan okunamazsa
 * yayımlanmış sürümler sırayla denenir.
 */
export function serverVersion(c: TfsConnection, signal?: AbortSignal): Promise<number> {
  const key = c.url.toLowerCase();
  let p = versions.get(key);
  if (!p) {
    p = (async () => {
      const dene = (v: number) =>
        call(c, "GET", "/_apis/projects", {
          query: { "api-version": v.toFixed(1), $top: 1 },
          what: "sürüm denetimi",
          signal,
        });
      try {
        await dene(MAX_VERSION);
        return MAX_VERSION;
      } catch (e) {
        if (e instanceof TfsError && outOfRange(e)) {
          const v = versionFromOutOfRange(e.message, MAX_VERSION);
          if (v) return v;
          for (const r of RELEASED.filter((x) => x < MAX_VERSION)) {
            try {
              await dene(r);
              return r;
            } catch (e2) {
              if (!(e2 instanceof TfsError) || !outOfRange(e2)) throw e2;
            }
          }
        }
        if (e instanceof TfsError && e.status === 404) {
          throw new TfsError(
            "koleksiyon bulunamadı — adres koleksiyonu göstermeli (ör. http://sunucu:8080/tfs/DefaultCollection; " +
              "proje adı ya da sayfa yolu olmadan)",
            404,
            e.code,
          );
        }
        throw e;
      }
    })();
    versions.set(key, p);
    p.catch(() => versions.delete(key));
  }
  return p;
}

/** Ayar değişince (adres/anahtar) önbellek temizlenir */
export function forgetServer(url?: string): void {
  if (url) versions.delete(url.toLowerCase());
  else versions.clear();
  fieldCache.clear();
  stateCache.clear();
}

/** İsteklerde kullanılacak sürüm: sunucununkine eşit ya da küçük, yayımlanmış en büyük sürüm */
export const releasedVersion = (v: number) => ver(v);
const ver = (v: number) => (RELEASED.find((r) => r <= v + 1e-9) ?? 1).toFixed(1);

/** Ürün adı (bilgi için): REST sürümünden sunucu sürümü tahmini */
export function productName(v: number): string {
  // Sunucu 2019'dan beri "Azure DevOps Server" adını taşıyor; kullanıcılar yine TFS diyor
  if (v >= 7.1) return "TFS 2022 (güncellemeli) ya da daha yeni";
  if (v >= 7) return "TFS 2022";
  if (v >= 6.1) return "TFS 2020 (güncellemeli)";
  if (v >= 6) return "TFS 2020";
  if (v >= 5.1) return "TFS 2019 (güncellemeli)";
  if (v >= 5) return "TFS 2019";
  if (v >= 4.1) return "TFS 2018 (güncellemeli)";
  if (v >= 4) return "TFS 2018";
  if (v >= 3) return "TFS 2017";
  return "TFS 2015 ya da daha eski";
}

// ── Bağlantı denemesi ─────────────────────────────────────────────────────

export interface TfsProbe {
  /** Anahtarın sahibi (sunucunun gördüğü ad) */
  user?: string;
  version: number;
  product: string;
  /** onPremises | hosted */
  deployment?: string;
  projects: string[];
  /** Ayarlardaki proje sunucuda var mı */
  projectFound?: boolean;
}

/** Ayarları dener: kimlik, sürüm, proje listesi */
export async function probe(c: TfsConnection, signal?: AbortSignal): Promise<TfsProbe> {
  forgetServer(c.url);
  const version = await serverVersion(c, signal);
  const conn = await call<{
    authenticatedUser?: { providerDisplayName?: string; customDisplayName?: string };
    deploymentType?: string;
  }>(c, "GET", "/_apis/connectionData", { what: "kimlik denetimi", signal }).catch(() => undefined);
  const list = await call<{ value?: Array<{ name?: string }> }>(c, "GET", "/_apis/projects", {
    query: { "api-version": ver(version), $top: 1000 },
    what: "proje listesi",
    signal,
  });
  const projects = (list?.value ?? [])
    .map((p) => p.name ?? "")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "tr"));
  const user = conn?.authenticatedUser?.customDisplayName || conn?.authenticatedUser?.providerDisplayName;
  return {
    ...(user ? { user } : {}),
    version,
    product: conn?.deploymentType === "hosted" ? "TFS bulut hizmeti" : productName(version),
    ...(conn?.deploymentType ? { deployment: conn.deploymentType } : {}),
    projects,
    ...(c.project ? { projectFound: projects.some((p) => p.toLowerCase() === c.project.toLowerCase()) } : {}),
  };
}

// ── İş öğesi ──────────────────────────────────────────────────────────────

/** Ham iş öğesi (REST yanıtı) */
interface RawWorkItem {
  id: number;
  rev?: number;
  fields?: Record<string, unknown>;
  relations?: Array<{ rel?: string; url?: string; attributes?: Record<string, unknown> }>;
  _links?: { html?: { href?: string } };
}

/** Kimlik alanı: yeni sürümlerde nesne ({displayName}), eskilerde "Ad Soyad <ALAN\kullanici>" */
export function identityName(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v.replace(/\s*<[^>]*>\s*$/, "").trim() || v;
  const o = v as { displayName?: unknown; uniqueName?: unknown };
  if (typeof o.displayName === "string" && o.displayName) return o.displayName;
  if (typeof o.uniqueName === "string") return o.uniqueName;
  return undefined;
}

export interface TfsSection {
  field: string;
  label: string;
  html: string;
}

export interface TfsLink {
  /** parent | child | related | other */
  kind: "parent" | "child" | "related" | "other";
  /** Türkçe bağ adı ("Üst öğe", "İlişkili"…) */
  label: string;
  id: number;
  /** batch ile doldurulur */
  title?: string;
  type?: string;
  state?: string;
}

export interface TfsAttachmentRef {
  name: string;
  guid: string;
  size?: number;
  comment?: string;
}

export interface TfsWorkItem {
  id: number;
  rev: number;
  project: string;
  type: string;
  title: string;
  state: string;
  reason?: string;
  assignedTo?: string;
  createdBy?: string;
  createdDate?: string;
  changedDate?: string;
  area?: string;
  iteration?: string;
  tags: string[];
  /** Başlık satırındaki kısa alanlar (Öncelik, Önem derecesi, Efor…) — sırasıyla */
  facts: Array<{ label: string; value: string }>;
  /** Zengin metin alanları (HTML) — ajan için bu sırayla */
  sections: TfsSection[];
  /** Diğer dolu kısa alanlar (özel alanlar dahil) */
  extra: Array<{ label: string; value: string }>;
  attachments: TfsAttachmentRef[];
  links: TfsLink[];
  /** Bağlı kod: commit, çekme isteği, dal, derleme, değişiklik kümesi */
  code: string[];
  /** Dış bağlantılar */
  hyperlinks: string[];
  /** Tarayıcıda açılacak adres */
  webUrl: string;
}

/** Bilinen zengin metin alanları ve Türkçe adları (sıra: hata için adımlar önce) */
const RICH_FIELDS: Array<[string, string]> = [
  ["Microsoft.VSTS.TCM.ReproSteps", "Yeniden üretme adımları"],
  ["System.Description", "Açıklama"],
  ["Microsoft.VSTS.Common.AcceptanceCriteria", "Kabul kriterleri"],
  ["Microsoft.VSTS.TCM.SystemInfo", "Sistem bilgisi"],
  ["Microsoft.VSTS.CMMI.Symptom", "Belirti"],
  ["Microsoft.VSTS.Common.Resolution", "Çözüm"],
  ["Microsoft.VSTS.CMMI.ProposedFix", "Önerilen düzeltme"],
  ["Microsoft.VSTS.CMMI.Analysis", "Analiz"],
  ["Microsoft.VSTS.CMMI.Justification", "Gerekçe"],
  ["Microsoft.VSTS.CMMI.ImpactAssessmentHtml", "Etki değerlendirmesi"],
  ["Microsoft.VSTS.CMMI.Mitigation", "Önlem"],
  ["Microsoft.VSTS.TCM.Steps", "Test adımları"],
];

/** Başlıkta gösterilen kısa alanlar */
const FACT_FIELDS: Array<[string, string]> = [
  ["Microsoft.VSTS.Common.Priority", "Öncelik"],
  ["Microsoft.VSTS.Common.Severity", "Önem derecesi"],
  ["Microsoft.VSTS.Scheduling.Effort", "Efor"],
  ["Microsoft.VSTS.Scheduling.StoryPoints", "Hikâye puanı"],
  ["Microsoft.VSTS.Scheduling.Size", "Büyüklük"],
  ["Microsoft.VSTS.Scheduling.OriginalEstimate", "İlk tahmin (saat)"],
  ["Microsoft.VSTS.Scheduling.RemainingWork", "Kalan iş (saat)"],
  ["Microsoft.VSTS.Common.BusinessValue", "İş değeri"],
  ["Microsoft.VSTS.Build.FoundIn", "Bulunduğu derleme"],
  ["Microsoft.VSTS.Build.IntegrationBuild", "Düzeltildiği derleme"],
  ["Microsoft.VSTS.Scheduling.DueDate", "Bitiş tarihi"],
  ["Microsoft.VSTS.Scheduling.TargetDate", "Hedef tarih"],
];

/** Diğer alanlar listesine girmeyecekler (iç/teknik alanlar) */
const SKIP_PREFIX = [
  "System.",
  "WEF_",
  "Microsoft.VSTS.Common.StateChangeDate",
  "Microsoft.VSTS.Common.ActivatedDate",
  "Microsoft.VSTS.Common.ActivatedBy",
  "Microsoft.VSTS.Common.ClosedDate",
  "Microsoft.VSTS.Common.ClosedBy",
  "Microsoft.VSTS.Common.ResolvedDate",
  "Microsoft.VSTS.Common.ResolvedBy",
  "Microsoft.VSTS.Common.ResolvedReason",
  "Microsoft.VSTS.Common.StackRank",
  "Microsoft.VSTS.Common.BacklogPriority",
  "Microsoft.VSTS.Common.ValueArea",
  "Microsoft.VSTS.Common.ReviewedBy",
  "Microsoft.VSTS.Scheduling.CompletedWork",
  "Microsoft.VSTS.Scheduling.StartDate",
  "Microsoft.VSTS.Scheduling.FinishDate",
  "Microsoft.VSTS.TCM.AutomationStatus",
  "Microsoft.VSTS.CodeReview.",
];

/** Bağ türleri */
const LINKS: Record<string, { kind: TfsLink["kind"]; label: string }> = {
  "System.LinkTypes.Hierarchy-Reverse": { kind: "parent", label: "Üst öğe" },
  "System.LinkTypes.Hierarchy-Forward": { kind: "child", label: "Alt öğe" },
  "System.LinkTypes.Related": { kind: "related", label: "İlişkili" },
  "System.LinkTypes.Dependency-Forward": { kind: "related", label: "Ardılı" },
  "System.LinkTypes.Dependency-Reverse": { kind: "related", label: "Öncülü" },
  "System.LinkTypes.Duplicate-Forward": { kind: "related", label: "Kopyası" },
  "System.LinkTypes.Duplicate-Reverse": { kind: "related", label: "Kopyası olduğu öğe" },
  "Microsoft.VSTS.Common.TestedBy-Forward": { kind: "other", label: "Test eden" },
  "Microsoft.VSTS.Common.TestedBy-Reverse": { kind: "other", label: "Test ettiği" },
  "Microsoft.VSTS.Common.Affects-Forward": { kind: "related", label: "Etkilediği" },
  "Microsoft.VSTS.Common.Affects-Reverse": { kind: "related", label: "Etkilendiği" },
};

const GUID = /\/_apis\/wit\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
/** Ek adresindeki kimlik (GUID) — iş öğesi metnindeki görseller dahil */
export function attachmentGuid(url: string): string | undefined {
  return GUID.exec(url)?.[1]?.toLowerCase();
}

/** Ek adresindeki dosya adı (?fileName=) */
export function attachmentFileName(url: string): string | undefined {
  try {
    return new URL(url, "http://x").searchParams.get("fileName") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Bağlı kodun okunur hali (vstfs:///Git/Commit/…) */
function describeArtifact(url: string, name: string): string | undefined {
  const dec = decodeURIComponent(url);
  let m = /^vstfs:\/\/\/Git\/Commit\/[^/]+\/[^/]+\/([0-9a-f]{7,40})/i.exec(dec);
  if (m) return `commit ${m[1].slice(0, 10)}`;
  m = /^vstfs:\/\/\/Git\/PullRequestId\/[^/]+\/[^/]+\/(\d+)/i.exec(dec);
  if (m) return `çekme isteği !${m[1]}`;
  m = /^vstfs:\/\/\/Git\/Ref\/[^/]+\/[^/]+\/GB(.+)$/i.exec(dec);
  if (m) return `dal ${m[1]}`;
  m = /^vstfs:\/\/\/VersionControl\/Changeset\/(\d+)/i.exec(dec);
  if (m) return `değişiklik kümesi ${m[1]}`;
  m = /^vstfs:\/\/\/Build\/Build\/(\d+)/i.exec(dec);
  if (m) return `derleme ${m[1]}`;
  return name ? `${name}` : undefined;
}

const fieldCache = new Map<string, Promise<Map<string, { name: string; type?: string }>>>();
/** Alan tanımları (görünen ad + tür) — özel alanların adı ve zengin metin olup olmadığı */
function fieldDefs(c: TfsConnection, v: number): Promise<Map<string, { name: string; type?: string }>> {
  const key = c.url.toLowerCase();
  let p = fieldCache.get(key);
  if (!p) {
    p = call<{ value?: Array<{ referenceName?: string; name?: string; type?: string }> }>(
      c,
      "GET",
      "/_apis/wit/fields",
      {
        query: { "api-version": ver(v) },
        what: "alan tanımları",
      },
    ).then(
      (r) =>
        new Map(
          (r?.value ?? [])
            .filter((f) => f.referenceName)
            .map((f) => [f.referenceName!, { name: f.name ?? f.referenceName!, type: f.type }]),
        ),
    );
    fieldCache.set(key, p);
    p.catch(() => fieldCache.delete(key));
  }
  return p.catch(() => new Map());
}

const looksHtml = (s: string) => /<(div|p|br|span|ul|ol|li|table|b|strong|i|em|a|img|h\d)\b/i.test(s);

/** Alan değerinin kısa metni */
function scalarText(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "boolean") return v ? "evet" : "hayır";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toLocaleDateString("tr-TR");
    }
    return looksHtml(v) ? htmlToMarkdown(v).replace(/\s+/g, " ").trim() : v.trim();
  }
  return identityName(v);
}

/** Önem derecesi gibi değerlerdeki İngilizce sözcükler ("2 - High" → "2 - Yüksek") */
const LEVEL_WORDS: Record<string, string> = { Critical: "Kritik", High: "Yüksek", Medium: "Orta", Low: "Düşük" };
const levelText = (s: string) => s.replace(/\b(Critical|High|Medium|Low)\b/g, (w) => LEVEL_WORDS[w] ?? w);

/** Ham iş öğesini düzenli biçime çevirir */
async function normalize(c: TfsConnection, v: number, raw: RawWorkItem): Promise<TfsWorkItem> {
  const f = raw.fields ?? {};
  const str = (k: string) =>
    typeof f[k] === "string" ? (f[k] as string) : f[k] !== undefined && f[k] !== null ? String(f[k]) : undefined;
  const defs = await fieldDefs(c, v);
  const project = str("System.TeamProject") ?? c.project;

  const sections: TfsSection[] = [];
  const used = new Set<string>();
  for (const [ref, label] of RICH_FIELDS) {
    const html = str(ref);
    used.add(ref);
    if (html && html.replace(/<[^>]*>|&nbsp;|\s/g, "")) sections.push({ field: ref, label, html });
    else if (html && /<img\b/i.test(html)) sections.push({ field: ref, label, html }); // yalnızca görsel
  }
  const facts: TfsWorkItem["facts"] = [];
  for (const [ref, label] of FACT_FIELDS) {
    used.add(ref);
    const t = scalarText(f[ref]);
    if (t) facts.push({ label, value: ref === "Microsoft.VSTS.Common.Severity" ? levelText(t) : t });
  }

  // Özel alanlar: zengin metinse bölüm, kısaysa "diğer alanlar"
  const extra: TfsWorkItem["extra"] = [];
  for (const [ref, value] of Object.entries(f)) {
    if (used.has(ref) || SKIP_PREFIX.some((p) => ref.startsWith(p))) continue;
    const def = defs.get(ref);
    const label = def?.name ?? ref.replace(/^.*\./, "");
    if (typeof value === "string" && (def?.type?.toLowerCase() === "html" || looksHtml(value))) {
      if (value.replace(/<[^>]*>|&nbsp;|\s/g, "")) sections.push({ field: ref, label, html: value });
      continue;
    }
    const t = scalarText(value);
    if (!t) continue;
    if (extra.length < 20) extra.push({ label, value: t.length > 200 ? t.slice(0, 197) + "…" : t });
  }

  const attachments: TfsAttachmentRef[] = [];
  const links: TfsLink[] = [];
  const code: string[] = [];
  const hyperlinks: string[] = [];
  for (const r of raw.relations ?? []) {
    const rel = r.rel ?? "";
    const url = r.url ?? "";
    const a = r.attributes ?? {};
    if (rel === "AttachedFile") {
      const guid = attachmentGuid(url);
      if (!guid) continue;
      attachments.push({
        name: typeof a.name === "string" && a.name ? a.name : (attachmentFileName(url) ?? "ek"),
        guid,
        ...(typeof a.resourceSize === "number" ? { size: a.resourceSize } : {}),
        ...(typeof a.comment === "string" && a.comment ? { comment: a.comment } : {}),
      });
    } else if (rel === "ArtifactLink") {
      const d = describeArtifact(url, typeof a.name === "string" ? a.name : "");
      if (d && !code.includes(d)) code.push(d);
    } else if (rel === "Hyperlink") {
      if (/^https?:\/\//i.test(url)) hyperlinks.push(url);
    } else {
      const id = Number(/\/workItems\/(\d+)$/i.exec(url)?.[1]);
      if (!Number.isInteger(id)) continue;
      const known = LINKS[rel];
      const name = typeof a.name === "string" ? a.name : rel;
      links.push({ kind: known?.kind ?? "other", label: known?.label ?? name, id });
    }
  }

  const tags = (str("System.Tags") ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
  const web = raw._links?.html?.href ?? `${c.url}/${encodeURIComponent(project)}/_workitems/edit/${raw.id}`;
  return {
    id: raw.id,
    rev: raw.rev ?? 0,
    project,
    type: str("System.WorkItemType") ?? "",
    title: str("System.Title") ?? "",
    state: str("System.State") ?? "",
    ...(str("System.Reason") ? { reason: str("System.Reason") } : {}),
    ...(identityName(f["System.AssignedTo"]) ? { assignedTo: identityName(f["System.AssignedTo"]) } : {}),
    ...(identityName(f["System.CreatedBy"]) ? { createdBy: identityName(f["System.CreatedBy"]) } : {}),
    ...(str("System.CreatedDate") ? { createdDate: str("System.CreatedDate") } : {}),
    ...(str("System.ChangedDate") ? { changedDate: str("System.ChangedDate") } : {}),
    ...(str("System.AreaPath") ? { area: str("System.AreaPath") } : {}),
    ...(str("System.IterationPath") ? { iteration: str("System.IterationPath") } : {}),
    tags,
    facts,
    sections,
    extra,
    attachments,
    links,
    code,
    hyperlinks,
    webUrl: web,
  };
}

/** İş öğesini tüm alanları ve bağlarıyla okur */
export async function getWorkItem(c: TfsConnection, id: number, signal?: AbortSignal): Promise<TfsWorkItem> {
  const v = await serverVersion(c, signal);
  let raw: RawWorkItem;
  try {
    raw = await call<RawWorkItem>(c, "GET", `/_apis/wit/workitems/${id}`, {
      query: { $expand: "all", "api-version": ver(v) },
      what: `#${id} iş öğesi`,
      signal,
    });
  } catch (e) {
    if (e instanceof TfsError && (e.status === 404 || e.status === 403)) {
      throw new TfsError(`#${id} iş öğesi bulunamadı ya da okuma yetkin yok`, e.status, e.code);
    }
    throw e;
  }
  return normalize(c, v, raw);
}

/** Birden çok iş öğesinin başlık/tür/durumu (bağlar ve listeler için). Okunamayanlar atlanır. */
export async function getSummaries(
  c: TfsConnection,
  ids: number[],
  signal?: AbortSignal,
  extraFields: string[] = [],
): Promise<Map<number, { title: string; type: string; state: string; fields: Record<string, unknown> }>> {
  const out = new Map<number, { title: string; type: string; state: string; fields: Record<string, unknown> }>();
  const uniq = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0);
  if (!uniq.length) return out;
  const v = await serverVersion(c, signal);
  const fields = ["System.Id", "System.Title", "System.WorkItemType", "System.State", ...extraFields].join(",");
  const put = (items: RawWorkItem[] | undefined) => {
    for (const w of items ?? []) {
      if (!w || typeof w.id !== "number") continue;
      const f = w.fields ?? {};
      out.set(w.id, {
        title: String(f["System.Title"] ?? ""),
        type: String(f["System.WorkItemType"] ?? ""),
        state: String(f["System.State"] ?? ""),
        fields: f,
      });
    }
  };
  for (let i = 0; i < uniq.length; i += 200) {
    const part = uniq.slice(i, i + 200);
    try {
      const r = await call<{ value?: RawWorkItem[] }>(c, "GET", "/_apis/wit/workitems", {
        query: { ids: part.join(","), fields, "api-version": ver(v), ...(v >= 4.1 ? { errorPolicy: "omit" } : {}) },
        what: "iş öğesi listesi",
        signal,
      });
      put(r?.value);
    } catch (e) {
      if (part.length === 1) continue; // tek öğe okunamadı — atla
      // Eski sunucuda (errorPolicy yok) okunamayan tek bir öğe tüm isteği düşürür — tek tek dene
      if (!(e instanceof TfsError) || e.status !== 404) throw e;
      for (const one of part) {
        try {
          const w = await call<RawWorkItem>(c, "GET", `/_apis/wit/workitems/${one}`, {
            query: { fields, "api-version": ver(v) },
            what: `#${one}`,
            signal,
          });
          put([w]);
        } catch {
          /* okunamıyor — atla */
        }
      }
    }
  }
  return out;
}

export interface TfsComment {
  author: string;
  date: string;
  /** Yorumun metni: çoğunlukla HTML; yeni sunucularda Markdown biçimli yorum da olabilir
   *  (htmlToMarkdown etiketsiz metni olduğu gibi bırakır) */
  html: string;
}

/** Yeni yorum ucunun (5.1+) sürümü: 5.1/6.0/7.0 → -preview.3, 7.1 → -preview.4 */
function commentsVersion(v: number): string | undefined {
  if (v < 5.1) return undefined;
  if (v >= 7.1) return "7.1-preview.4";
  if (v >= 7) return "7.0-preview.3";
  if (v >= 6) return "6.0-preview.3";
  return "5.1-preview.3";
}

/**
 * İş öğesinin tartışması (eskiden yeniye). 5.1+ (Azure DevOps Server 2019 güncelleme 1 ve
 * sonrası): yorum ucu. Öncesinde yorum ucu revizyon tabanlı ve salt okunurdu — her sürümde
 * çalışan güncelleme geçmişi (System.History) okunur. En fazla `max` yorum (en yeniler).
 */
export async function getComments(
  c: TfsConnection,
  item: { id: number; project: string },
  max = 50,
  signal?: AbortSignal,
): Promise<TfsComment[]> {
  const v = await serverVersion(c, signal);
  const cv = commentsVersion(v);
  if (cv) {
    try {
      const out: TfsComment[] = [];
      let token: string | undefined;
      for (let page = 0; page < 10; page++) {
        type C = {
          text?: string;
          renderedText?: string;
          format?: string;
          createdBy?: unknown;
          createdDate?: string;
          isDeleted?: boolean;
        };
        const r = await call<{ comments?: C[]; value?: C[]; continuationToken?: string }>(
          c,
          "GET",
          `/${encodeURIComponent(item.project)}/_apis/wit/workItems/${item.id}/comments`,
          {
            // Markdown biçimli yorumun HTML hâli (7.1+) — yoksa metnin kendisi
            query: {
              "api-version": cv,
              $top: 200,
              ...(v >= 7.1 ? { $expand: "renderedText" } : {}),
              ...(token ? { continuationToken: token } : {}),
            },
            what: `#${item.id} yorumları`,
            signal,
          },
        );
        for (const cm of r?.comments ?? r?.value ?? []) {
          if (cm.isDeleted) continue;
          const text =
            cm.format?.toLowerCase() === "markdown" ? cm.renderedText || cm.text : cm.text || cm.renderedText;
          if (!text) continue;
          out.push({ author: identityName(cm.createdBy) ?? "?", date: cm.createdDate ?? "", html: text });
        }
        token = r?.continuationToken;
        if (!token) break;
      }
      return out.sort((a, b) => a.date.localeCompare(b.date)).slice(-max);
    } catch (e) {
      if (!(e instanceof TfsError) || (e.status !== 400 && e.status !== 404)) throw e;
      // Yorum ucu bu sunucuda farklı — geçmişten oku
    }
  }
  const out: TfsComment[] = [];
  for (let skip = 0; skip < 2000; skip += 200) {
    const r = await call<{
      value?: Array<{ revisedBy?: unknown; revisedDate?: string; fields?: Record<string, { newValue?: unknown }> }>;
    }>(c, "GET", `/_apis/wit/workitems/${item.id}/updates`, {
      query: { $top: 200, $skip: skip, "api-version": ver(v) },
      what: `#${item.id} geçmişi`,
      signal,
    });
    const list = r?.value ?? [];
    for (const u of list) {
      const h = u.fields?.["System.History"]?.newValue;
      if (typeof h !== "string" || !h.trim()) continue;
      const date = u.fields?.["System.ChangedDate"]?.newValue;
      out.push({
        author: identityName(u.revisedBy) ?? "?",
        date: typeof date === "string" ? date : (u.revisedDate ?? ""),
        html: h,
      });
    }
    if (list.length < 200) break;
  }
  return out.slice(-max);
}

/** Eki indirir (anahtarla, yalnızca ayarlardaki koleksiyondan) */
export async function downloadAttachment(
  c: TfsConnection,
  guid: string,
  fileName: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!/^[0-9a-f-]{36}$/i.test(guid)) throw new TfsError("geçersiz ek kimliği");
  const v = await serverVersion(c, signal);
  const url = buildUrl(c, `/_apis/wit/attachments/${guid}`, { fileName, download: "true", "api-version": ver(v) });
  const r = await rawRequest(c, "GET", url, { accept: "*/*", maxBytes, timeoutMs: 120_000, signal });
  if (r.status === 203 || (r.status >= 200 && r.status < 300 && isHtml(r) && !/\.html?$/i.test(fileName))) {
    throw new TfsError("ek yerine oturum açma sayfası geldi — erişim anahtarı geçersiz", r.status, "HTML");
  }
  if (r.status < 200 || r.status >= 300) throw httpError(r, `ek (${fileName})`);
  return r.body;
}

/** Aynı sunucudaki bir adresi anahtarla indirir (metindeki eski biçimli görsel adresleri için).
 *  Adres ayarlardaki koleksiyonun sunucusunda değilse REDDEDİLİR — anahtar başka yere gitmez. */
export async function downloadSameOrigin(
  c: TfsConnection,
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new TfsError("geçersiz adres");
  }
  if (target.origin.toLowerCase() !== new URL(c.url).origin.toLowerCase())
    throw new TfsError(`başka sunucudaki adres indirilmez: ${target.host}`);
  const r = await rawRequest(c, "GET", target.toString(), { accept: "*/*", maxBytes, timeoutMs: 120_000, signal });
  if (r.status === 203 || (r.status >= 200 && r.status < 300 && isHtml(r)))
    throw new TfsError("görsel yerine bir web sayfası geldi", r.status, "HTML");
  if (r.status < 200 || r.status >= 300) throw httpError(r, "görsel");
  return r.body;
}

/** Ekin içerik türü (indirme ucu) — panelde görsel önizleme için */
export async function fetchAttachment(
  c: TfsConnection,
  guid: string,
  fileName: string,
  maxBytes: number,
): Promise<{ data: Buffer; type: string }> {
  const data = await downloadAttachment(c, guid, fileName, maxBytes);
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const IMG: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
  };
  return { data, type: IMG[ext] ?? "application/octet-stream" };
}

// ── Sorgu ─────────────────────────────────────────────────────────────────

const wiqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface TfsListItem {
  id: number;
  type: string;
  title: string;
  state: string;
  assignedTo?: string;
  changedDate?: string;
  /** Durum kategorisi biliniyorsa (Proposed/InProgress/Resolved/Completed/Removed) */
  category?: string;
}

/** WIQL sorgusu → iş öğesi numaraları (sırasıyla) */
async function wiql(c: TfsConnection, where: string, top: number, signal?: AbortSignal): Promise<number[]> {
  const v = await serverVersion(c, signal);
  const query =
    `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = ${wiqlString(c.project)} AND (${where}) ` +
    "ORDER BY [System.ChangedDate] DESC";
  const r = await call<{ workItems?: Array<{ id?: number }> }>(
    c,
    "POST",
    `/${encodeURIComponent(c.project)}/_apis/wit/wiql`,
    {
      query: { "api-version": ver(v), $top: top },
      json: { query },
      what: "sorgu",
      signal,
    },
  );
  return (r?.workItems ?? [])
    .map((w) => w.id)
    .filter((n): n is number => typeof n === "number")
    .slice(0, top);
}

async function listOf(c: TfsConnection, ids: number[], signal?: AbortSignal): Promise<TfsListItem[]> {
  const sum = await getSummaries(c, ids, signal, ["System.AssignedTo", "System.ChangedDate"]);
  const out: TfsListItem[] = [];
  for (const id of ids) {
    const s = sum.get(id);
    if (!s) continue;
    out.push({
      id,
      type: s.type,
      title: s.title,
      state: s.state,
      ...(identityName(s.fields["System.AssignedTo"])
        ? { assignedTo: identityName(s.fields["System.AssignedTo"]) }
        : {}),
      ...(typeof s.fields["System.ChangedDate"] === "string"
        ? { changedDate: s.fields["System.ChangedDate"] as string }
        : {}),
    });
  }
  // Durum kategorileri (tür başına bir kez sorulur) — tamamlananlar ayrılabilsin
  const types = [...new Set(out.map((o) => o.type))];
  const cats = new Map<string, Map<string, string>>();
  for (const t of types)
    cats.set(
      t,
      new Map(
        (await getStates(c, t, signal).catch(() => [])).filter((s) => s.category).map((s) => [s.name, s.category!]),
      ),
    );
  for (const o of out) {
    const cat = cats.get(o.type)?.get(o.state) ?? guessCategory(o.state);
    if (cat) o.category = cat;
  }
  return out;
}

/** Bana atanan iş öğeleri (en son değişen önce). done: tamamlanan/kaldırılanlar da dahil */
export async function myWorkItems(
  c: TfsConnection,
  opts: { done?: boolean; top?: number } = {},
  signal?: AbortSignal,
): Promise<TfsListItem[]> {
  const ids = await wiql(c, "[System.AssignedTo] = @Me", Math.min(opts.top ?? 100, 200), signal);
  const list = await listOf(c, ids, signal);
  return opts.done ? list : list.filter((i) => i.category !== "Completed" && i.category !== "Removed");
}

/** Başlıkta geçen metne göre arama (projede, en son değişen önce) */
export async function searchWorkItems(c: TfsConnection, text: string, signal?: AbortSignal): Promise<TfsListItem[]> {
  const t = text.trim().slice(0, 100);
  if (!t) return [];
  const ids = await wiql(c, `[System.Title] CONTAINS ${wiqlString(t)}`, 40, signal);
  return listOf(c, ids, signal);
}

// ── Durumlar ──────────────────────────────────────────────────────────────

export interface TfsState {
  name: string;
  /** Proposed | InProgress | Resolved | Completed | Removed (eski sunucuda bilinmeyebilir) */
  category?: string;
}

/** Kategori ucu olmayan sunucularda bilinen durum adlarından tahmin (İngilizce ve Türkçe şablonlar) */
export function guessCategory(state: string): string | undefined {
  const s = state.trim().toLowerCase();
  if (["done", "closed", "completed", "bitti", "kapatıldı", "kapalı", "tamamlandı"].includes(s)) return "Completed";
  if (["removed", "kaldırıldı", "silindi"].includes(s)) return "Removed";
  if (["resolved", "çözüldü"].includes(s)) return "Resolved";
  if (
    ["active", "committed", "in progress", "doing", "etkin", "aktif", "üstlenildi", "devam ediyor", "sürüyor"].includes(
      s,
    )
  )
    return "InProgress";
  if (["new", "approved", "proposed", "to do", "yeni", "onaylandı", "önerildi", "yapılacak"].includes(s))
    return "Proposed";
  return undefined;
}

const stateCache = new Map<string, Promise<TfsState[]>>();
/**
 * İş öğesi türünün durumları. Yeni sunucuda kategorileriyle (states ucu); eskisinde tür
 * tanımındaki geçişlerden (kategori tahminle).
 */
export function getStates(c: TfsConnection, type: string, signal?: AbortSignal): Promise<TfsState[]> {
  const key = `${c.url.toLowerCase()}|${c.project.toLowerCase()}|${type}`;
  let p = stateCache.get(key);
  if (!p) {
    p = (async () => {
      const v = await serverVersion(c, signal);
      const base = `/${encodeURIComponent(c.project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}`;
      if (v >= 4.1) {
        try {
          const r = await call<{ value?: Array<{ name?: string; category?: string }> }>(c, "GET", `${base}/states`, {
            query: { "api-version": v >= 7 ? ver(v) : `${ver(v)}-preview.1` },
            what: `"${type}" durumları`,
            signal,
          });
          const list = (r?.value ?? [])
            .filter((s) => s.name)
            .map((s) => ({ name: s.name!, ...(s.category ? { category: s.category } : {}) }));
          if (list.length) return list;
        } catch (e) {
          if (!(e instanceof TfsError) || (e.status !== 400 && e.status !== 404)) throw e;
        }
      }
      // Eski sunucu: tür tanımındaki geçişler ({ "": [{to:"New"}], "New": [{to:"Approved"}] … })
      const t = await call<{
        transitions?: Record<string, Array<{ to?: string }>>;
        states?: Array<{ name?: string; category?: string }>;
      }>(c, "GET", base, { query: { "api-version": ver(v) }, what: `"${type}" türü`, signal });
      if (t?.states?.length)
        return t.states
          .filter((s) => s.name)
          .map((s) => ({
            name: s.name!,
            ...(s.category
              ? { category: s.category }
              : guessCategory(s.name!)
                ? { category: guessCategory(s.name!) }
                : {}),
          }));
      const names: string[] = [];
      for (const [from, tos] of Object.entries(t?.transitions ?? {})) {
        if (from && !names.includes(from)) names.push(from);
        for (const x of tos ?? []) if (x.to && !names.includes(x.to)) names.push(x.to);
      }
      return names.map((name) => ({ name, ...(guessCategory(name) ? { category: guessCategory(name) } : {}) }));
    })();
    stateCache.set(key, p);
    p.catch(() => stateCache.delete(key));
  }
  return p;
}

// ── Yazma ─────────────────────────────────────────────────────────────────

export interface TfsWriteResult {
  rev?: number;
  state?: string;
}

/**
 * İş öğesine bağ ekler (ör. çekme isteği: `vstfs:///Git/PullRequestId/{proje}%2F{depo}%2F{no}`, ad "Pull Request").
 * Eski sunucularda istek açılırken verilen iş öğesi bağı yok sayılabildiği için sonradan eklenir; bağ zaten
 * varsa sunucunun "Relation already exists" hatası sessizce yutulur.
 */
export async function linkArtifact(
  c: TfsConnection,
  id: number,
  url: string,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  const v = await serverVersion(c, signal);
  try {
    await call(c, "PATCH", `/_apis/wit/workitems/${id}`, {
      query: { "api-version": ver(v) },
      json: [{ op: "add", path: "/relations/-", value: { rel: "ArtifactLink", url, attributes: { name } } }],
      patch: true,
      what: `#${id} bağı`,
      signal,
    });
  } catch (e) {
    if (e instanceof TfsError && /already exists|zaten (var|mevcut)/i.test(e.message)) return;
    throw e;
  }
}

/**
 * İş öğesine yorum ekler (tartışma) ve istenirse durumunu değiştirir — tek istekte.
 * Yorum her sürümde System.History'ye ekleme ile yazılır (TFS 2015'ten beri aynı).
 * Durum geçişi kurala takılırsa (geçersiz geçiş, zorunlu alan) sunucunun mesajı döner.
 */
export async function writeWorkItem(
  c: TfsConnection,
  id: number,
  input: { html?: string; state?: string },
  signal?: AbortSignal,
): Promise<TfsWriteResult> {
  const v = await serverVersion(c, signal);
  const ops: Array<{ op: string; path: string; value: unknown }> = [];
  if (input.state) ops.push({ op: "add", path: "/fields/System.State", value: input.state });
  if (input.html) ops.push({ op: "add", path: "/fields/System.History", value: input.html });
  if (!ops.length) return {};
  try {
    const r = await call<RawWorkItem>(c, "PATCH", `/_apis/wit/workitems/${id}`, {
      query: { "api-version": ver(v) },
      json: ops,
      patch: true,
      what: `#${id} güncellemesi`,
      signal,
    });
    const st = r?.fields?.["System.State"];
    return { ...(typeof r?.rev === "number" ? { rev: r.rev } : {}), ...(typeof st === "string" ? { state: st } : {}) };
  } catch (e) {
    if (e instanceof TfsError && e.status === 400 && input.state) {
      throw new TfsError(
        `durum "${input.state}" yapılamadı (geçiş kuralı ya da zorunlu alan) — ${e.message}`,
        400,
        e.code,
      );
    }
    throw e;
  }
}
