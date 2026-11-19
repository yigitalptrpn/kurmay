import path from "node:path";
import type { SecurityFinding, SecurityReport, Severity } from "./securityReport.js";
import { countBySeverity } from "./securityReport.js";
import type { NightlyRepo, NightlyRun } from "./nightlyAudit.js";

/**
 * Güvenlik raporunun e-posta hâli — ekibe gönderilecek özet, siber güvenlik operasyon merkezi
 * uyarısı görünümünde: eş aralıklı "//" başlıklar, terminal komut satırı, neon şerit, köşeli
 * etiketler, kayıt satırı gibi dizilmiş bulgular. E-posta istemcileri (Outlook'un Word
 * motoru, Gmail) betik, SVG, CSS değişkeni ve dış yazı tipi çalıştırmaz; bu yüzden düzen
 * tablolarla, biçim satır içi stillerle kurulur, HTML sunucuda üretilir. Önem her yerde
 * renkle birlikte yazıyla da verilir.
 *
 * AÇIK ZEMİN BİLİNÇLİ: ilk sürüm koyu zemin + açık yazıydı; alıcılar BOŞ EKRAN gördü — zemin
 * rengini atan istemci/posta süzgeci açık yazıyı beyaz sayfada bıraktı. Kural: her yazı
 * açık zeminde okunur renkte, zeminler yalnızca süs (atılsa da okunur). Neon renkler
 * (NEON) yalnızca şerit/kenar gibi süslerde, yazıda koyu tonları (R.cyan, R.yesil) kullan.
 *
 * OUTLOOK MASAÜSTÜ (Word motoru) KURALLARI — kullanıcı Outlook 2019'da yapıştırınca şablon
 * bozuluyordu: iç boşluk/kenarlık/kenar boşluğu yalnızca hücrede (<td>) güvenilir, div'de ve
 * tablo kenar boşluğunda yok sayılır → `kutu()` / `bosluk()`; yazı tipi listesinde YALNIZCA ilki
 * dikkate alınır (kurulu değilse Times New Roman) → Windows'ta hep olan yazı tipi başta;
 * "font:" kısaltması ve birimsiz satır yüksekliği güvenilmez → `fontAc()` çıktıda uzun hâle
 * açar; font-size:0 geçersiz (en küçük 1px) → ince şeritler 1px yazı + sabit satır yüksekliği.
 */

// İlk yazı tipi Windows'ta hep kurulu olmalı: Outlook masaüstü listenin yalnızca ilkine bakar
const SANS = "'Segoe UI',Arial,Helvetica,sans-serif";
const MONO = "Consolas,'Cascadia Mono','Courier New',monospace";

/** Renkler — yazılar beyazda okunur (≥ 4,5:1), zeminler açık */
const R = {
  dis: "#e8edf4", // e-postanın dış zemini
  kart: "#ffffff",
  panel: "#f8fafc",
  terminal: "#f1f5f9",
  cizgi: "#d5dde8",
  yazi: "#0f172a",
  govde: "#334155", // uzun metin
  ikincil: "#475569",
  soluk: "#5b6b80",
  cyan: "#0e7490", // yazıda camgöbeği
  yesil: "#047857", // yazıda yeşil
};
/** Neon süs renkleri — yalnızca şerit, kenar, düğme zemini (üstündeki yazı koyu) */
const NEON = { cyan: "#22d3ee", yesil: "#34d399" };

/** Önem: ad + yazı rengi (açık zeminde okunur) / açık zemin / kenar */
const SEV: Record<Severity, { ad: string; renk: string; zemin: string; kenar: string }> = {
  critical: { ad: "Kritik", renk: "#be123c", zemin: "#fff1f2", kenar: "#fecdd3" },
  high: { ad: "Yüksek", renk: "#c2410c", zemin: "#fff7ed", kenar: "#fed7aa" },
  medium: { ad: "Orta", renk: "#a16207", zemin: "#fefce8", kenar: "#fde68a" },
  low: { ad: "Düşük", renk: "#1d4ed8", zemin: "#eff6ff", kenar: "#bfdbfe" },
  info: { ad: "Bilgi", renk: "#475569", zemin: "#f1f5f9", kenar: "#cbd5e1" },
};
const ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const RISK: Record<string, { ad: string; renk: string; zemin: string; kenar: string; n: number; aciklama: string }> = {
  none: {
    ad: "Risk yok",
    renk: "#047857",
    zemin: "#ecfdf5",
    kenar: "#a7f3d0",
    n: 0,
    aciklama: "Denetimde bildirilecek bir güvenlik açığı bulunmadı.",
  },
  low: { ...SEV.low, n: 1, aciklama: "Düşük etkili zayıflıklar var; planlı olarak giderilmeli." },
  medium: {
    ...SEV.medium,
    n: 2,
    aciklama: "Belirli koşullarda istismar edilebilecek zayıflıklar var; yakın zamanda ele alınmalı.",
  },
  high: {
    ...SEV.high,
    n: 3,
    aciklama: "İstismar edilebilir ve önemli etki taşıyan bulgular var; öncelikle giderilmeli.",
  },
  critical: {
    ...SEV.critical,
    n: 4,
    aciklama: "Doğrudan istismar edilebilir, ciddi etkili bulgular var; hemen müdahale edilmeli.",
  },
};
const RISK_ORDER = ["none", "low", "medium", "high", "critical"];
/** E-postada öne çıkarılan bulgu sayısı — tamamı rapordadır */
const TOP_FINDINGS = 5;

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
const kisalt = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const tarih = (iso: string) =>
  new Date(iso).toLocaleString("tr-TR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const yer = (f: SecurityFinding) => (f.file ? `${f.file}${f.line ? ":" + f.line : ""}` : "");
const buyuk = (s: string) => s.toLocaleUpperCase("tr-TR");
// Uzun yol: kelime ortasından değil, / ve \ sonrasından satır kırılsın. Outlook <wbr>'yi tanımaz,
// kırılamayan uzun yol tabloyu 600 px'in dışına iter → uzun yolda sıfır genişlikli boşluk
const yolHtml = (p: string) => esc(p).replace(/([/\\])/g, p.length > 40 ? "$1&#8203;" : "$1");
/** Dikey aralık — Outlook tablo/div kenar boşluğunu yok sayar, aralık boş hücreyle verilir */
const bosluk = (px: number) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td height="${px}" style="height:${px}px;font-size:1px;line-height:${px}px;mso-line-height-rule:exactly">&nbsp;</td></tr></table>`;
/** Tek hücreli tam genişlik kutu — iç boşluk ve kenarlık Outlook'ta yalnızca hücrede çalışır */
const kutu = (stil: string, icerik: string, zemin?: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td${zemin ? ` bgcolor="${zemin}"` : ""} style="${stil}">${icerik}</td></tr></table>`;

export interface ReportEmail {
  subject: string;
  html: string;
  text: string;
}

export interface ReportEmailOptions {
  /** Raporun Kurmay'daki adresi — alıcılar erişebiliyorsa "Raporu aç" düğmesi */
  link?: string;
  /** Raporun PDF'i e-postaya eklendi mi (metin "ayrıntılar ekte" der) */
  pdfAttached?: boolean;
  version?: string;
}

export function renderReportEmail(r: SecurityReport, o: ReportEmailOptions = {}): ReportEmail {
  const c = countBySeverity(r.findings);
  const toplam = r.findings.length;
  const hamMetin = r.rawText !== undefined && !toplam; // şema gelmedi — sayılar bilinmiyor
  const rk = r.risk ? RISK[r.risk] : undefined;
  const proje = path.basename(r.targetDir) || r.targetDir;
  const kod = (i: number) => `B-${String(i + 1).padStart(2, "0")}`;

  const sayimMetni = hamMetin
    ? "yapılandırılmış rapor gelmedi"
    : toplam
      ? ORDER.filter((s) => c[s])
          .map((s) => `${c[s]} ${SEV[s].ad.toLocaleLowerCase("tr-TR")}`)
          .join(", ")
      : "bulgu yok";
  const subject = `[Kurmay] Güvenlik denetimi: ${r.standalone ? proje : kisalt(r.task, 60)} — Risk: ${rk ? rk.ad : "belirlenemedi"} (${sayimMetni})`;
  const onIzleme = `${rk ? `Risk düzeyi ${rk.ad.toLocaleLowerCase("tr-TR")}` : "Risk belirlenemedi"} · ${sayimMetni} · ${r.summary ? kisalt(r.summary, 120) : r.task}`;

  // — Terminal komut satırı: hangi hedefin, hangi kapsamda tarandığı —
  const komut = `kurmay denetim --hedef ${proje.replace(/\s+/g, "-")} --kapsam ${r.standalone ? "tum-kod" : "degisen-dosyalar"}`;
  const terminal = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td bgcolor="${R.terminal}" style="background:${R.terminal};border:1px solid ${R.cizgi};border-left:3px solid ${NEON.cyan};border-radius:8px;padding:10px 14px;font:12.5px/1.7 ${MONO};color:${R.ikincil};overflow-wrap:anywhere">
        <span style="color:${R.yesil}">kurmay@denetim</span><span style="color:${R.soluk}">:~$</span> <span style="color:${R.yazi}">${esc(komut)}</span><br>
        <span style="color:${R.soluk}">[${esc(tarih(r.createdAt))}]</span> <span style="color:${R.yesil}">■ tarama tamamlandı</span> <span style="color:${R.soluk}">·</span>
        ${r.files.length} dosya ${r.standalone ? "incelendi" : "denetlendi"} <span style="color:${R.soluk}">·</span> ${hamMetin ? "yapılandırılmış rapor yok" : `${toplam} bulgu`}
      </td></tr></table>${bosluk(18)}`;

  // — Risk düzeyi bandı ve ölçek —
  const renk = rk ? rk.renk : R.ikincil;
  const olcek = RISK_ORDER.map((k, i) => {
    const dolu = rk && i <= rk.n;
    return `<td width="20%" valign="top" style="padding:0 2px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td height="1" style="height:1px;font-size:1px;line-height:1px;mso-line-height-rule:exactly;border-top:8px solid ${dolu ? renk : R.cizgi}">&nbsp;</td></tr>
      <tr><td style="padding-top:4px;font:${r.risk === k ? "700" : "400"} 9.5px/1.6 ${MONO};letter-spacing:.5px;color:${r.risk === k ? renk : R.soluk}">${buyuk(RISK[k].ad)}</td></tr></table></td>`;
  }).join("");
  const riskBandi = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate"><tr>
      <td bgcolor="${rk ? rk.zemin : R.panel}" style="background:${rk ? rk.zemin : R.panel};border:1px solid ${rk ? rk.kenar : R.cizgi};border-left:4px solid ${renk};border-radius:8px;padding:16px 18px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="middle" style="font:600 11px/1.4 ${MONO};letter-spacing:2px;color:${R.ikincil}">// RİSK DÜZEYİ</td>
          <td align="right" valign="middle">
            <table role="presentation" cellpadding="0" cellspacing="0" align="right"><tr><td style="border:1px solid ${renk};border-radius:4px;padding:4px 10px;font:700 12px/1.3 ${MONO};letter-spacing:2px;color:${renk}">[ ${buyuk(rk ? rk.ad : "Belirlenemedi")} ]</td></tr></table>
          </td></tr></table>
        ${kutu(`padding:8px 0 12px;font:700 30px/1.25 ${MONO};letter-spacing:1px;color:${renk}`, buyuk(rk ? rk.ad : "Belirlenemedi"))}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${olcek}</tr></table>
        ${kutu(`padding-top:12px;font:13.5px/1.55 ${SANS};color:${R.yazi}`, `<span style="font-family:${MONO};color:${renk}">&gt;</span> ${esc(rk ? rk.aciklama : "Denetçi yapılandırılmış rapor üretmediği için risk düzeyi belirlenemedi.")}`)}
      </td></tr></table>`;

  // — Bulgu matrisi: 5 kutu —
  const matris = hamMetin
    ? ""
    : `${baslik("Bulgu matrisi")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${ORDER.map(
        (s, i) => `
      <td width="20%" valign="top" style="padding:0 ${i === ORDER.length - 1 ? 0 : 4}px 0 ${i === 0 ? 0 : 4}px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td bgcolor="${R.panel}" style="background:${R.panel};border:1px solid ${R.cizgi};border-top:2px solid ${SEV[s].renk};border-radius:6px;padding:9px 10px">
            <div style="font:600 9.5px/1.4 ${MONO};letter-spacing:1px;color:${R.ikincil}">${buyuk(SEV[s].ad)}</div>
            <div style="font:700 24px/1.2 ${MONO};color:${c[s] ? SEV[s].renk : R.soluk}">${String(c[s]).padStart(2, "0")}</div>
          </td></tr></table>
      </td>`,
      ).join("")}</tr></table>`;

  const ozet = r.summary
    ? `${baslik("Durum raporu")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td bgcolor="${R.terminal}" style="background:${R.terminal};border:1px solid ${R.cizgi};border-left:3px solid ${NEON.cyan};border-radius:8px;padding:12px 14px">
          ${kutu(`padding-bottom:4px;font:12px/1.6 ${MONO};color:${R.yesil}`, "$ cat ozet.txt")}
          <div style="font:14px/1.65 ${SANS};color:${R.govde};overflow-wrap:anywhere">${esc(r.summary)}</div>
        </td></tr></table>`
    : "";

  // — Tespit edilen açıklar: kayıt satırı düzeni —
  let bulgular: string;
  if (hamMetin) {
    bulgular = `${baslik("Denetçinin notu")}<div style="font:13.5px/1.6 ${SANS};color:${R.govde}">Denetçi yapılandırılmış rapor üretmedi; yazdığı metin ${
      o.pdfAttached ? "ekteki PDF raporda" : "raporda"
    } yer alıyor.</div>`;
  } else if (!toplam) {
    bulgular = `${bosluk(22)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td bgcolor="${RISK.none.zemin}" style="background:${RISK.none.zemin};border:1px solid ${RISK.none.kenar};border-radius:8px;padding:14px 16px;font:14px/1.5 ${SANS};color:${R.yazi}">
        <span style="font:700 12px ${MONO};letter-spacing:1px;color:${RISK.none.renk}">[ TEMİZ ]</span>&nbsp; Güvenlik açığı bulunmadı — ${r.standalone ? "denetlenen kod tabanında" : "denetlenen değişikliklerde"} bildirilecek bir sorun yok.</td></tr></table>`;
  } else {
    const ust = r.findings.slice(0, TOP_FINDINGS);
    bulgular =
      baslik(
        toplam > TOP_FINDINGS
          ? `Tespit edilen açıklar · ${TOP_FINDINGS}/${toplam}`
          : `Tespit edilen açıklar · ${toplam}`,
      ) +
      ust
        .map((f, i) => {
          const s = SEV[f.severity] ?? SEV.info;
          return `${i ? bosluk(10) : ""}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate"><tr>
          <td bgcolor="${R.panel}" style="background:${R.panel};border:1px solid ${R.cizgi};border-left:3px solid ${s.renk};border-radius:6px;padding:12px 14px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td valign="middle">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                  <td bgcolor="${s.zemin}" style="background:${s.zemin};border:1px solid ${s.kenar};border-radius:4px;padding:2px 7px;font:700 10px/1.5 ${MONO};letter-spacing:1px;color:${s.renk};white-space:nowrap">${buyuk(s.ad)}</td>
                  <td style="padding-left:2px;font:600 11.5px/1.5 ${MONO};color:${R.soluk}">&nbsp;${kod(i)}</td>
                </tr></table>
              </td>
              <td align="right" valign="middle" style="font:11.5px/1.5 ${MONO};color:${R.ikincil}">${esc(f.cwe ?? "")}</td>
            </tr></table>
            ${kutu(`padding-top:7px;font:600 14.5px/1.4 ${SANS};color:${R.yazi};overflow-wrap:anywhere`, esc(f.title))}
            ${yer(f) ? `<div style="font:12px/1.6 ${MONO};color:${R.cyan};overflow-wrap:anywhere"><span style="color:${R.soluk}">└─</span> ${yolHtml(yer(f))}</div>` : ""}
            ${f.category ? `<div style="font:12px/1.5 ${SANS};color:${R.ikincil}">${esc(f.category)}</div>` : ""}
            ${f.recommendation ? kutu(`padding-top:6px;font:13px/1.55 ${SANS};color:${R.govde};overflow-wrap:anywhere;word-break:break-word`, `<span style="font:700 11px ${MONO};letter-spacing:1px;color:${R.yesil}">»&nbsp;DÜZELTME</span>&nbsp; ${esc(kisalt(f.recommendation, 260))}`) : ""}
          </td></tr></table>`;
        })
        .join("") +
      (toplam > TOP_FINDINGS
        ? bosluk(8) +
          kutu(
            `font:12.5px/1.5 ${MONO};color:${R.ikincil}`,
            `+ ${toplam - TOP_FINDINGS} bulgu daha — tamamı ${o.pdfAttached ? "ekteki PDF raporda" : "raporda"}`,
          )
        : "");
  }

  const kunye = [
    ["kapsam", r.standalone ? "Bağımsız denetim — kod tabanının tamamı" : "Akış içi denetim — değişen dosyalar"],
    ["hedef_dizin", r.targetDir, "mono"],
    r.model ? ["model", r.model, "mono"] : null,
    r.sessionName ? ["oturum", r.sessionName] : null,
    [r.standalone ? "incelenen_dosya" : "denetlenen_dosya", String(r.files.length), "mono"],
    ["rapor_no", r.id, "mono"],
  ]
    .filter((x): x is string[] => !!x)
    .map(
      ([
        k,
        v,
        m,
      ]) => `<tr><td width="150" valign="top" style="padding:5px 12px 5px 0;border-top:1px solid ${R.cizgi};font:12.5px/1.5 ${MONO};color:${R.ikincil}">${k}</td>
      <td valign="top" style="padding:5px 0;border-top:1px solid ${R.cizgi};font:13px/1.5 ${m ? MONO : SANS};color:${R.yazi};overflow-wrap:anywhere">${m ? yolHtml(v) : esc(v)}</td></tr>`,
    )
    .join("");

  const ekNotu = o.pdfAttached
    ? `${bosluk(20)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td bgcolor="#ecfeff" style="background:#ecfeff;border:1px solid #a5f3fc;border-radius:8px;padding:12px 14px;font:13.5px/1.5 ${SANS};color:#155e75">
        <span style="font:700 11px ${MONO};letter-spacing:1px;color:${R.cyan}">[ EK ]</span>&nbsp; Raporun tamamı PDF olarak ekte: tüm bulgular, kanıt satırları ve düzeltme önerileri.</td></tr></table>`
    : "";
  const dugme = o.link
    ? `${bosluk(20)}<table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td bgcolor="${NEON.cyan}" style="background:${NEON.cyan};border:1px solid ${R.cyan};border-radius:6px;padding:12px 22px;font:700 13px/1.2 ${MONO};letter-spacing:1.5px">
          <a href="${esc(o.link)}" target="_blank" style="font:700 13px/1.2 ${MONO};letter-spacing:1.5px;color:#083344;text-decoration:none">RAPORU AÇ&nbsp;&rarr;</a>
        </td></tr></table>`
    : "";

  const html = kabuk({
    subject,
    onIzleme,
    renk,
    altBaslik: "SİBER GÜVENLİK DENETİMİ",
    hap: "●&nbsp;TARAMA&nbsp;TAMAMLANDI",
    govde: `
      <div style="font:600 11px/1.4 ${MONO};letter-spacing:2px;color:${R.cyan}">${r.standalone ? "// KOD TABANI DENETİMİ" : "// GÖREV DENETİMİ"}</div>
      ${kutu(`padding:6px 0 16px;font:700 22px/1.3 ${SANS};color:${R.yazi};overflow-wrap:anywhere`, esc(r.task))}
      ${terminal}
      ${riskBandi}
      ${matris}
      ${ozet}
      ${bulgular}
      ${ekNotu}
      ${dugme}
      ${baslik("Hedef bilgileri")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${kunye}</table>`,
    alt: `// Kurmay Güvenlik Denetçisi tarafından otomatik üretildi${o.version ? ` · v${esc(o.version)}` : ""}<br>
        // Denetçi kodu yalnızca okur; bulgular otomatik analiz sonucudur ve uygulanmadan önce bir geliştirici tarafından doğrulanmalıdır.`,
  });

  // Düz metin hâli: HTML göstermeyen istemciler ve önizleme için
  const satirlar = [
    `KURMAY // SİBER GÜVENLİK DENETİMİ`,
    ``,
    r.task,
    `$ ${komut}`,
    `${tarih(r.createdAt)} · ${r.targetDir}`,
    ``,
    `RİSK DÜZEYİ: ${buyuk(rk ? rk.ad : "Belirlenemedi")}${rk ? ` — ${rk.aciklama}` : ""}`,
    hamMetin
      ? `BULGULAR: yapılandırılmış rapor gelmedi`
      : `BULGU MATRİSİ: ${ORDER.map((s) => `${SEV[s].ad} ${c[s]}`).join(" · ")}`,
    ...(r.summary ? [``, `DURUM RAPORU`, r.summary] : []),
    ...(toplam
      ? [
          ``,
          toplam > TOP_FINDINGS
            ? `TESPİT EDİLEN AÇIKLAR (${TOP_FINDINGS}/${toplam})`
            : `TESPİT EDİLEN AÇIKLAR (${toplam})`,
          ...r.findings
            .slice(0, TOP_FINDINGS)
            .flatMap((f, i) => [
              `[${buyuk((SEV[f.severity] ?? SEV.info).ad)}] ${kod(i)} ${f.title}${f.cwe ? ` (${f.cwe})` : ""}`,
              ...(yer(f) ? [`  └─ ${yer(f)}`] : []),
              ...(f.recommendation ? [`  » Düzeltme: ${kisalt(f.recommendation, 260)}`] : []),
            ]),
          ...(toplam > TOP_FINDINGS ? [`+ ${toplam - TOP_FINDINGS} bulgu daha`] : []),
        ]
      : []),
    ...(o.pdfAttached ? [``, `[EK] Raporun tamamı PDF olarak ekte.`] : []),
    ...(o.link ? [``, `Rapor: ${o.link}`] : []),
    ``,
    `rapor_no: ${r.id}`,
    `// Bulgular otomatik analiz sonucudur; uygulanmadan önce doğrulanmalıdır.`,
  ];
  return { subject, html, text: satirlar.join("\n") };
}

/** Gece özetinde gösterilen en fazla kritik/yüksek bulgu */
const NIGHT_TOP = 15;

const DURUM_ADI: Record<NightlyRepo["status"], string> = {
  waiting: "Bekliyor",
  preparing: "Hazırlanıyor",
  running: "Denetleniyor",
  done: "Denetlendi",
  failed: "Düştü",
  timeout: "Süre doldu",
  cancelled: "Durduruldu",
};

/**
 * Gece güvenlik denetiminin sabah özeti (e-posta): tüm depoların risk ve bulgu tablosu, yeni
 * kritik/yüksek bulgular ve açılan TFS iş öğeleri, sorunlar. Rapor e-postasıyla aynı kabuk ve
 * Outlook kuralları (açık zemin, hücre içi boşluk, uzun yazı tipi bildirimleri).
 */
export function renderNightlyEmail(run: NightlyRun, o: { panelUrl?: string; version?: string } = {}): ReportEmail {
  const repos = run.repos;
  const done = repos.filter((r) => r.status === "done");
  const top: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const r of done) for (const s of ORDER) top[s] += r.counts?.[s] ?? 0;
  const toplam = ORDER.reduce((a, s) => a + top[s], 0);
  const yeni = done.reduce((a, r) => a + (r.newFindings ?? 0), 0);
  const enKotu = RISK_ORDER.slice()
    .reverse()
    .find((k) => done.some((r) => r.risk === k));
  const rk = enKotu ? RISK[enKotu] : undefined;
  const renk = rk ? rk.renk : R.ikincil;
  const gun = new Date(run.startedAt).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
  const saat = (iso?: string) =>
    iso ? new Date(iso).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "—";
  const sayim = toplam
    ? ORDER.filter((s) => top[s] && s !== "info")
        .map((s) => `${top[s]} ${SEV[s].ad.toLocaleLowerCase("tr-TR")}`)
        .join(", ") || `${top.info} bilgi`
    : "bulgu yok";
  const subject =
    run.status === "failed" && !done.length
      ? `[Kurmay] Gece güvenlik denetimi yapılamadı — ${gun}`
      : `[Kurmay] Gece güvenlik denetimi — ${gun}: ${sayim} (${done.length}/${repos.length} depo)`;
  const onIzleme = `${done.length}/${repos.length} depo denetlendi · ${sayim}${yeni ? ` · ${yeni} yeni bulgu` : ""}${run.workItems?.created ? ` · ${run.workItems.created} yeni iş öğesi` : ""}`;
  const kalan = repos.filter((r) => r.status === "timeout").length;
  const dusen = repos.filter((r) => r.status === "failed").length;
  const hap =
    run.status === "failed" && !done.length
      ? { metin: "●&nbsp;YAPILAMADI", renk: { kenar: SEV.critical.kenar, yazi: SEV.critical.renk } }
      : kalan || dusen || run.status === "cancelled"
        ? {
            metin: `●&nbsp;${done.length}/${repos.length}&nbsp;DEPO`,
            renk: { kenar: SEV.medium.kenar, yazi: SEV.medium.renk },
          }
        : { metin: `●&nbsp;${done.length}&nbsp;DEPO&nbsp;DENETLENDİ`, renk: undefined };

  const terminal = kutu(
    `background:${R.terminal};border:1px solid ${R.cizgi};border-left:3px solid ${NEON.cyan};border-radius:8px;padding:10px 14px;font:12.5px/1.7 ${MONO};color:${R.ikincil};overflow-wrap:anywhere`,
    `<span style="color:${R.yesil}">kurmay@denetim</span><span style="color:${R.soluk}">:~$</span> <span style="color:${R.yazi}">kurmay gece-denetimi --kok ${yolHtml(run.root)}</span><br>
      <span style="color:${R.soluk}">[${saat(run.startedAt)} → ${saat(run.finishedAt)}]</span> <span style="color:${R.yesil}">■ ${done.length}/${repos.length} depo denetlendi</span>` +
      (kalan ? ` <span style="color:${R.soluk}">·</span> ${kalan} depo süre dolduğu için kaldı` : "") +
      (dusen ? ` <span style="color:${R.soluk}">·</span> ${dusen} depo düştü` : ""),
    R.terminal,
  );

  const riskBandi = rk
    ? bosluk(18) +
      kutu(
        `background:${rk.zemin};border:1px solid ${rk.kenar};border-left:4px solid ${renk};border-radius:8px;padding:14px 18px`,
        kutu(`font:600 11px/1.4 ${MONO};letter-spacing:2px;color:${R.ikincil}`, "// EN YÜKSEK RİSK") +
          kutu(`padding:6px 0 4px;font:700 26px/1.25 ${MONO};letter-spacing:1px;color:${renk}`, buyuk(rk.ad)) +
          kutu(
            `font:13.5px/1.55 ${SANS};color:${R.yazi}`,
            `<span style="font-family:${MONO};color:${renk}">&gt;</span> ${esc(
              enKotu === "none"
                ? "Denetlenen depoların hiçbirinde bildirilecek açık bulunmadı."
                : `${done.filter((r) => r.risk === enKotu).length} depoda risk düzeyi ${rk.ad.toLocaleLowerCase("tr-TR")}. ${rk.aciklama}`,
            )}`,
          ),
        rk.zemin,
      )
    : "";

  const matris = done.length
    ? `${baslik("Bulgu matrisi — tüm depolar")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${ORDER.map(
        (s, i) => `
      <td width="20%" valign="top" style="padding:0 ${i === ORDER.length - 1 ? 0 : 4}px 0 ${i === 0 ? 0 : 4}px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td bgcolor="${R.panel}" style="background:${R.panel};border:1px solid ${R.cizgi};border-top:2px solid ${SEV[s].renk};border-radius:6px;padding:9px 10px">
            <div style="font:600 9.5px/1.4 ${MONO};letter-spacing:1px;color:${R.ikincil}">${buyuk(SEV[s].ad)}</div>
            <div style="font:700 24px/1.2 ${MONO};color:${top[s] ? SEV[s].renk : R.soluk}">${String(top[s]).padStart(2, "0")}</div>
          </td></tr></table>
      </td>`,
      ).join("")}</tr></table>` +
      bosluk(10) +
      kutu(
        `font:13px/1.55 ${SANS};color:${R.govde}`,
        [
          done.some((r) => !r.firstAudit)
            ? `Dünden bu yana <b>${yeni}</b> yeni bulgu`
            : "İlk gece denetimi — karşılaştırma yarından itibaren",
          run.workItems
            ? `TFS: <b>${run.workItems.created}</b> yeni iş öğesi açıldı, ${run.workItems.existing} bulgunun iş öğesi zaten açık`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
      )
    : "";

  // — Depolar tablosu —
  const satir = (r: NightlyRepo) => {
    const rr = r.risk ? RISK[r.risk] : undefined;
    const risk =
      r.status !== "done"
        ? `<span style="font:700 11px/1.4 ${MONO};letter-spacing:1px;color:${r.status === "failed" ? SEV.critical.renk : R.ikincil}">${buyuk(DURUM_ADI[r.status])}</span>`
        : rr
          ? `<span style="font:700 11px/1.4 ${MONO};letter-spacing:1px;color:${rr.renk}">${buyuk(rr.ad)}</span>`
          : `<span style="font:11px/1.4 ${MONO};color:${R.soluk}">—</span>`;
    const c = r.counts;
    const bulgu = c
      ? (["critical", "high", "medium", "low"] as const)
          .map((s) => `<span style="color:${c[s] ? SEV[s].renk : R.soluk}">${c[s]}</span>`)
          .join(`<span style="color:${R.soluk}"> · </span>`)
      : `<span style="color:${R.soluk}">—</span>`;
    const yeniH =
      r.status === "done" && !r.firstAudit
        ? r.newFindings
          ? `<span style="font-weight:700;color:${SEV.high.renk}">+${r.newFindings}</span>`
          : `<span style="color:${R.soluk}">0</span>`
        : `<span style="color:${R.soluk}">—</span>`;
    const alt = [
      r.ref ? `${esc(r.ref)}${r.commit ? ` @ ${esc(r.commit)}` : ""}` : "",
      r.fetchError ? `<span style="color:${SEV.medium.renk}">güncellenemedi — eldeki son hâl</span>` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const td = `padding:7px 6px 7px 0;border-top:1px solid ${R.cizgi};vertical-align:top`;
    return `<tr>
      <td width="44%" style="${td};font:600 12.5px/1.45 ${MONO};color:${R.yazi};overflow-wrap:anywhere">${yolHtml(r.name)}${alt ? `<div style="font:11px/1.5 ${MONO};color:${R.soluk}">${alt}</div>` : ""}</td>
      <td width="20%" style="${td}">${risk}</td>
      <td width="24%" style="${td};font:600 12.5px/1.45 ${MONO}">${bulgu}</td>
      <td width="12%" style="${td};font:12.5px/1.45 ${MONO};text-align:right">${yeniH}</td></tr>`;
  };
  const th = `padding:0 6px 6px 0;font:600 10px/1.4 ${MONO};letter-spacing:1px;color:${R.ikincil}`;
  const tablo = repos.length
    ? `${baslik(`Depolar · ${repos.length}`)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="${th}">DEPO</td><td style="${th}">RİSK</td><td style="${th}">K · Y · O · D</td><td style="${th};text-align:right">YENİ</td></tr>
      ${repos.map(satir).join("")}</table>` +
      (run.excluded?.length
        ? bosluk(8) +
          kutu(`font:12px/1.5 ${SANS};color:${R.soluk}`, `Hariç tutulan: ${run.excluded.map((x) => esc(x)).join(", ")}`)
        : "")
    : "";

  // — Kritik ve yüksek bulgular (yeniler önce) —
  const vurgular = done
    .flatMap((r) => (r.highlights ?? []).map((h) => ({ r, h })))
    .sort(
      (a, b) => Number(!!b.h.isNew) - Number(!!a.h.isNew) || ORDER.indexOf(a.h.severity) - ORDER.indexOf(b.h.severity),
    );
  const kart = ({ r, h }: (typeof vurgular)[number], i: number) => {
    const sv = SEV[h.severity];
    const etiket = (metin: string, renk: { renk: string; zemin: string; kenar: string }) =>
      `<td bgcolor="${renk.zemin}" style="background:${renk.zemin};border:1px solid ${renk.kenar};border-radius:4px;padding:2px 7px;font:700 10px/1.5 ${MONO};letter-spacing:1px;color:${renk.renk};white-space:nowrap">${metin}</td>`;
    const yerH = h.file ? `${h.file}${h.line ? `:${h.line}` : ""}` : "";
    const wi = h.workItem
      ? h.workItem.url && /^https?:\/\//.test(h.workItem.url)
        ? `<a href="${esc(h.workItem.url)}" style="color:${R.cyan};text-decoration:underline">TFS #${h.workItem.id}</a>`
        : `TFS #${h.workItem.id}`
      : "";
    return `${i ? bosluk(8) : ""}${kutu(
      `background:${R.panel};border:1px solid ${R.cizgi};border-left:3px solid ${sv.renk};border-radius:6px;padding:10px 14px`,
      `<table role="presentation" cellpadding="0" cellspacing="0"><tr>${etiket(buyuk(sv.ad), sv)}${
        h.isNew ? `<td style="padding-left:4px"></td>${etiket("YENİ", SEV.low)}` : ""
      }<td style="padding-left:2px;font:600 11.5px/1.5 ${MONO};color:${R.soluk}">&nbsp;${yolHtml(r.name)}</td></tr></table>` +
        kutu(`padding-top:6px;font:600 14px/1.4 ${SANS};color:${R.yazi};overflow-wrap:anywhere`, esc(h.title)) +
        (yerH
          ? kutu(
              `font:12px/1.6 ${MONO};color:${R.cyan};overflow-wrap:anywhere`,
              `<span style="color:${R.soluk}">└─</span> ${yolHtml(yerH)}${h.cwe ? ` <span style="color:${R.ikincil}">· ${esc(h.cwe)}</span>` : ""}`,
            )
          : "") +
        (wi
          ? kutu(
              `padding-top:4px;font:12px/1.5 ${SANS};color:${R.govde}`,
              `${wi} — ${h.workItem!.existing ? "iş öğesi zaten açık" : "bu gece açıldı"}`,
            )
          : ""),
      R.panel,
    )}`;
  };
  const bulgular = vurgular.length
    ? `${baslik(`Kritik ve yüksek bulgular · ${vurgular.length}`)}${vurgular.slice(0, NIGHT_TOP).map(kart).join("")}` +
      (vurgular.length > NIGHT_TOP
        ? bosluk(8) +
          kutu(
            `font:12.5px/1.5 ${MONO};color:${R.ikincil}`,
            `+ ${vurgular.length - NIGHT_TOP} bulgu daha — tamamı depo raporlarında`,
          )
        : "")
    : done.length
      ? bosluk(22) +
        kutu(
          `background:${RISK.none.zemin};border:1px solid ${RISK.none.kenar};border-radius:8px;padding:12px 16px;font:14px/1.5 ${SANS};color:${R.yazi}`,
          `<span style="font:700 12px ${MONO};letter-spacing:1px;color:${RISK.none.renk}">[ TEMİZ ]</span>&nbsp; Kritik ya da yüksek önemli bulgu yok.`,
          RISK.none.zemin,
        )
      : "";

  // — Sorunlar —
  const sorun: string[] = [];
  if (run.error) sorun.push(`Koşu: ${esc(run.error)}`);
  for (const r of repos) {
    if (r.status === "failed")
      sorun.push(`<b>${esc(r.name)}</b> denetlenemedi: ${esc(kisalt(r.error ?? "bilinmeyen hata", 300))}`);
    if (r.fetchError)
      sorun.push(
        `<b>${esc(r.name)}</b> sunucudan güncellenemedi, eldeki son hâl denetlendi: ${esc(kisalt(r.fetchError, 200))}`,
      );
    if (r.workItemError)
      sorun.push(`<b>${esc(r.name)}</b> için TFS iş öğesi açılamadı: ${esc(kisalt(r.workItemError, 300))}`);
  }
  if (kalan)
    sorun.push(
      `${kalan} depo bitiş saatine kadar sıra gelmediği için denetlenmedi: ${repos
        .filter((r) => r.status === "timeout")
        .map((r) => esc(r.name))
        .join(", ")}`,
    );
  const sorunlar = sorun.length
    ? `${baslik("Dikkat edilecekler")}${kutu(
        `background:${SEV.medium.zemin};border:1px solid ${SEV.medium.kenar};border-radius:8px;padding:10px 14px;font:13px/1.6 ${SANS};color:${R.yazi}`,
        sorun.map((x) => `<div>• ${x}</div>`).join(""),
        SEV.medium.zemin,
      )}`
    : "";

  const link = o.panelUrl ? `${o.panelUrl.replace(/\/+$/, "")}/guvenlik#${encodeURIComponent(run.id)}` : "";
  const dugme = link
    ? `${bosluk(20)}<table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td bgcolor="${NEON.cyan}" style="background:${NEON.cyan};border:1px solid ${R.cyan};border-radius:6px;padding:12px 22px;font:700 13px/1.2 ${MONO};letter-spacing:1.5px">
          <a href="${esc(link)}" target="_blank" style="font:700 13px/1.2 ${MONO};letter-spacing:1.5px;color:#083344;text-decoration:none">SABAH ÖZETİNİ AÇ&nbsp;&rarr;</a>
        </td></tr></table>`
    : "";

  const html = kabuk({
    subject,
    onIzleme,
    renk,
    altBaslik: "GECE GÜVENLİK DENETİMİ",
    hap: hap.metin,
    ...(hap.renk ? { hapRenk: hap.renk } : {}),
    govde: `
      <div style="font:600 11px/1.4 ${MONO};letter-spacing:2px;color:${R.cyan}">// SABAH ÖZETİ</div>
      ${kutu(`padding:6px 0 16px;font:700 22px/1.3 ${SANS};color:${R.yazi}`, `Gece güvenlik denetimi — ${esc(gun)}`)}
      ${terminal}
      ${riskBandi}
      ${matris}
      ${bulgular}
      ${tablo}
      ${sorunlar}
      ${dugme}`,
    alt: `// Kurmay gece güvenlik denetimi — her gece kök klasördeki depoların ana dalı denetlenir${o.version ? ` · v${esc(o.version)}` : ""}<br>
        // Bulgular yapay zekâ incelemesine dayanır; düzeltmeden önce bir geliştirici tarafından doğrulanmalıdır.`,
  });

  const T: string[] = [
    "KURMAY // GECE GÜVENLİK DENETİMİ",
    "",
    `Sabah özeti — ${gun}`,
    `${done.length}/${repos.length} depo denetlendi (${saat(run.startedAt)} → ${saat(run.finishedAt)}) · kök: ${run.root}`,
    "",
    rk ? `EN YÜKSEK RİSK: ${buyuk(rk.ad)}` : "",
    done.length ? `BULGULAR: ${ORDER.map((s) => `${SEV[s].ad} ${top[s]}`).join(" · ")}` : "",
    done.some((r) => !r.firstAudit) ? `Dünden bu yana ${yeni} yeni bulgu` : "",
    run.workItems ? `TFS: ${run.workItems.created} yeni iş öğesi, ${run.workItems.existing} zaten açık` : "",
  ].filter((x, i) => x || i < 5);
  if (vurgular.length) {
    T.push("", `KRİTİK VE YÜKSEK BULGULAR (${vurgular.length})`);
    for (const { r, h } of vurgular.slice(0, NIGHT_TOP))
      T.push(
        `[${buyuk(SEV[h.severity].ad)}]${h.isNew ? " [YENİ]" : ""} ${r.name}: ${h.title}`,
        ...(h.file ? [`  └─ ${h.file}${h.line ? `:${h.line}` : ""}${h.cwe ? ` · ${h.cwe}` : ""}`] : []),
        ...(h.workItem
          ? [`  TFS #${h.workItem.id}${h.workItem.existing ? " (zaten açık)" : " (bu gece açıldı)"}`]
          : []),
      );
    if (vurgular.length > NIGHT_TOP) T.push(`+ ${vurgular.length - NIGHT_TOP} bulgu daha`);
  }
  if (repos.length) {
    T.push("", "DEPOLAR (kritik · yüksek · orta · düşük)");
    for (const r of repos)
      T.push(
        `- ${r.name}: ${r.status === "done" ? `${r.risk ? (RISK[r.risk]?.ad ?? r.risk) : "—"} · ${(["critical", "high", "medium", "low"] as const).map((s) => r.counts?.[s] ?? 0).join(" · ")}${!r.firstAudit && r.newFindings ? ` · +${r.newFindings} yeni` : ""}` : DURUM_ADI[r.status]}`,
      );
  }
  if (sorun.length) T.push("", "DİKKAT EDİLECEKLER", ...sorun.map((x) => `- ${x.replace(/<[^>]+>/g, "")}`));
  if (link) T.push("", `Sabah özeti: ${link}`);
  T.push("", "// Bulgular yapay zekâ incelemesine dayanır; düzeltmeden önce doğrulanmalıdır.");
  return { subject, html, text: T.join("\n") };
}

/**
 * E-postanın kabuğu (rapor ve gece özeti ortak): 600 px kart, neon şerit, ">_ KURMAY" başlığı ve
 * sağda durum hapı, içerik hücresi, alt yazı. Çıktı fontAc'den geçer (Outlook).
 */
function kabuk(o: {
  subject: string;
  onIzleme: string;
  /** Şeridin son rengi (risk düzeyi) */
  renk: string;
  altBaslik: string;
  /** Sağdaki hap (HTML; boşluklar &nbsp;) */
  hap: string;
  /** Hapın kenar ve yazı rengi (varsayılan yeşil) */
  hapRenk?: { kenar: string; yazi: string };
  govde: string;
  alt: string;
}): string {
  const hap = o.hapRenk ?? { kenar: "#a7f3d0", yazi: R.yesil };
  return fontAc(`<!doctype html>
<html lang="tr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(o.subject)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<style>table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}</style><![endif]-->
<style>
  :root { color-scheme:light; supported-color-schemes:light; }
  @media (max-width:620px) {
    .kap { width:100% !important; }
    .ic { padding-left:16px !important; padding-right:16px !important; }
  }
</style>
</head>
<body bgcolor="${R.dis}" style="margin:0;padding:0;background:${R.dis};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(o.onIzleme)}${"&zwnj;&nbsp;".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${R.dis}" style="background:${R.dis};background-image:linear-gradient(rgba(14,116,144,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(14,116,144,.06) 1px,transparent 1px);background-size:28px 28px">
<tr><td align="center" style="padding:24px 12px">
  <table role="presentation" class="kap" width="600" cellpadding="0" cellspacing="0" bgcolor="${R.kart}" style="width:600px;max-width:600px;background:${R.kart};border:1px solid ${R.cizgi};border-radius:12px;border-collapse:separate;overflow:hidden">
    <tr><td height="4" bgcolor="${NEON.cyan}" style="height:4px;font-size:1px;line-height:4px;mso-line-height-rule:exactly;background:${NEON.cyan};background-image:linear-gradient(90deg,${NEON.cyan},${NEON.yesil} 60%,${o.renk})">&nbsp;</td></tr>
    <tr><td class="ic" bgcolor="${R.kart}" style="background:${R.kart};padding:18px 28px;border-bottom:1px solid ${R.cizgi}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="middle">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td width="36" height="36" align="center" valign="middle" bgcolor="#ecfeff" style="background:#ecfeff;border:1px solid ${NEON.cyan};border-radius:8px;font:700 15px/36px ${MONO};color:${R.cyan}">&gt;_</td>
            <td style="padding-left:12px;font:700 15px/1.2 ${MONO};letter-spacing:3px;color:${R.yazi}">KURMAY
              <div style="font:500 10px/1.7 ${MONO};letter-spacing:2px;color:${R.cyan}">${esc(o.altBaslik)}</div></td>
          </tr></table>
        </td>
        <td align="right" valign="middle">
          <table role="presentation" cellpadding="0" cellspacing="0" align="right"><tr>
            <td style="border:1px solid ${hap.kenar};border-radius:999px;padding:4px 11px;font:600 10.5px/1.4 ${MONO};letter-spacing:1px;color:${hap.yazi};white-space:nowrap">${o.hap}</td>
          </tr></table>
        </td>
      </tr></table>
    </td></tr>
    <tr><td class="ic" style="padding:24px 28px 8px">
${o.govde}
    </td></tr>
    <tr><td class="ic" style="padding:18px 28px 24px">
      ${kutu(`border-top:1px solid ${R.cizgi};padding-top:14px;font:11.5px/1.7 ${MONO};color:${R.soluk}`, o.alt)}
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`);
}

/** Bölüm başlığı (e-posta içi): eş aralıklı, "//" önekli, ince camgöbeği çizgi */
function baslik(ad: string): string {
  return (
    kutu(
      `padding:26px 0 8px;border-bottom:1px solid ${R.cizgi};font:700 11.5px/1.4 ${MONO};letter-spacing:2px;color:${R.yazi}`,
      `<span style="color:${R.cyan}">//</span> ${esc(buyuk(ad))}`,
    ) + bosluk(12)
  );
}

/**
 * "font:" kısaltmasını uzun hâllere açar, birimsiz satır yüksekliğini piksele çevirir — Outlook
 * masaüstü kısaltmayı güvenilir işlemez (yazı Times New Roman'a, varsayılan boyuta düşer). Şablon
 * kısa ve okunur kalsın diye kısaltmayla yazılır, açma burada, çıktının tamamında yapılır.
 */
function fontAc(html: string): string {
  return html.replace(
    /font:\s*(?:(\d{3})\s+)?([\d.]+)px(?:\/([\d.]+)(px)?)?\s+([^;"]+)/g,
    (
      _m,
      kalinlik: string | undefined,
      boyut: string,
      satir: string | undefined,
      pikselSatir: string | undefined,
      aile: string,
    ) => {
      const parcalar = [`font-family:${aile.trim()}`, `font-size:${boyut}px`, `font-weight:${kalinlik ?? 400}`];
      if (satir) {
        const px = pikselSatir ? Number(satir) : Math.round(Number(boyut) * Number(satir));
        parcalar.push(`line-height:${px}px`, "mso-line-height-rule:exactly");
      }
      return parcalar.join(";");
    },
  );
}

/**
 * Gönderilmemiş taslak olarak .eml (RFC 5322 + MIME): Outlook "X-Unsent: 1" görünce iletiyi
 * yeni, düzenlenebilir taslak olarak açar — alıcıyı yazıp gönderirsin. Gövde HTML + düz metin,
 * varsa PDF ek. Satır sonları CRLF, içerikler base64 (Türkçe karakterler bozulmasın).
 */
export function buildEml(mail: ReportEmail, attachment?: { name: string; data: Buffer }): Buffer {
  const CRLF = "\r\n";
  const b64 = (buf: Buffer | string) =>
    (Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8")).toString("base64").replace(/.{1,76}/g, "$&" + CRLF);
  // RFC 2047: kodlanmış sözcük en fazla 75 karakter — uzun konu birden çok sözcüğe bölünüp katlanır
  // (≤ 42 bayt → 56 karakter base64, "Subject: " ile 78'i aşmaz; harf ortasından bölünmez)
  const word = (s: string) => {
    const parcalar: string[] = [];
    let cur = "";
    for (const ch of s) {
      if (cur && Buffer.byteLength(cur + ch, "utf8") > 42) {
        parcalar.push(cur);
        cur = "";
      }
      cur += ch;
    }
    if (cur) parcalar.push(cur);
    return parcalar.map((p) => `=?UTF-8?B?${Buffer.from(p, "utf8").toString("base64")}?=`).join(CRLF + " ");
  };
  const sinir = `kurmay-${Math.random().toString(36).slice(2, 12)}`;
  const alt = `${sinir}-alt`;
  const govde = [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    ``,
    `--${alt}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64(mail.text),
    `--${alt}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64(mail.html),
    `--${alt}--`,
  ];
  const basliklar = [`X-Unsent: 1`, `Subject: ${word(mail.subject)}`, `MIME-Version: 1.0`, `X-Mailer: Kurmay`];
  if (!attachment) return Buffer.from([...basliklar, ...govde, ``].join(CRLF), "utf8");
  const ascii = attachment.name
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "_");
  const parcalar = [
    ...basliklar,
    `Content-Type: multipart/mixed; boundary="${sinir}"`,
    ``,
    `--${sinir}`,
    ...govde,
    `--${sinir}`,
    `Content-Type: application/pdf; name="${ascii}"`,
    `Content-Disposition: attachment; filename="${ascii}";`,
    ` filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64(attachment.data),
    `--${sinir}--`,
    ``,
  ];
  return Buffer.from(parcalar.join(CRLF), "utf8");
}
