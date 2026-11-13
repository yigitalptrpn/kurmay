import path from "node:path";
import type { SecurityFinding, SecurityReport, Severity } from "./securityReport.js";
import { countBySeverity } from "./securityReport.js";

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
 */

const SANS = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'Cascadia Mono',Consolas,'Courier New',monospace";

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
  soluk: "#64748b",
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
  none: { ad: "Risk yok", renk: "#047857", zemin: "#ecfdf5", kenar: "#a7f3d0", n: 0, aciklama: "Denetimde bildirilecek bir güvenlik açığı bulunmadı." },
  low: { ...SEV.low, n: 1, aciklama: "Düşük etkili zayıflıklar var; planlı olarak giderilmeli." },
  medium: { ...SEV.medium, n: 2, aciklama: "Belirli koşullarda istismar edilebilecek zayıflıklar var; yakın zamanda ele alınmalı." },
  high: { ...SEV.high, n: 3, aciklama: "İstismar edilebilir ve önemli etki taşıyan bulgular var; öncelikle giderilmeli." },
  critical: { ...SEV.critical, n: 4, aciklama: "Doğrudan istismar edilebilir, ciddi etkili bulgular var; hemen müdahale edilmeli." },
};
const RISK_ORDER = ["none", "low", "medium", "high", "critical"];
/** E-postada öne çıkarılan bulgu sayısı — tamamı rapordadır */
const TOP_FINDINGS = 5;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const kisalt = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const tarih = (iso: string) =>
  new Date(iso).toLocaleString("tr-TR", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
const yer = (f: SecurityFinding) => (f.file ? `${f.file}${f.line ? ":" + f.line : ""}` : "");
const buyuk = (s: string) => s.toLocaleUpperCase("tr-TR");
// Uzun yol: kelime ortasından değil, / ve \ sonrasından satır kırılsın (<wbr> desteklenmezse sarılır)
const yolHtml = (p: string) => esc(p).replace(/([\/\\])/g, "$1<wbr>");

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
      ? ORDER.filter((s) => c[s]).map((s) => `${c[s]} ${SEV[s].ad.toLocaleLowerCase("tr-TR")}`).join(", ")
      : "bulgu yok";
  const subject = `[Kurmay] Güvenlik denetimi: ${r.standalone ? proje : kisalt(r.task, 60)} — Risk: ${rk ? rk.ad : "belirlenemedi"} (${sayimMetni})`;
  const onIzleme = `${rk ? `Risk düzeyi ${rk.ad.toLocaleLowerCase("tr-TR")}` : "Risk belirlenemedi"} · ${sayimMetni} · ${r.summary ? kisalt(r.summary, 120) : r.task}`;

  // — Terminal komut satırı: hangi hedefin, hangi kapsamda tarandığı —
  const komut = `kurmay denetim --hedef ${proje.replace(/\s+/g, "-")} --kapsam ${r.standalone ? "tum-kod" : "degisen-dosyalar"}`;
  const terminal = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px"><tr>
      <td bgcolor="${R.terminal}" style="background:${R.terminal};border:1px solid ${R.cizgi};border-left:3px solid ${NEON.cyan};border-radius:8px;padding:10px 14px;font:12.5px/1.7 ${MONO};color:${R.ikincil};overflow-wrap:anywhere">
        <span style="color:${R.yesil}">kurmay@denetim</span><span style="color:${R.soluk}">:~$</span> <span style="color:${R.yazi}">${esc(komut)}</span><br>
        <span style="color:${R.soluk}">[${esc(tarih(r.createdAt))}]</span> <span style="color:${R.yesil}">■ tarama tamamlandı</span> <span style="color:${R.soluk}">·</span>
        ${r.files.length} dosya ${r.standalone ? "incelendi" : "denetlendi"} <span style="color:${R.soluk}">·</span> ${hamMetin ? "yapılandırılmış rapor yok" : `${toplam} bulgu`}
      </td></tr></table>`;

  // — Risk düzeyi bandı ve ölçek —
  const renk = rk ? rk.renk : R.ikincil;
  const olcek = RISK_ORDER.map((k, i) => {
    const dolu = rk && i <= rk.n;
    return `<td width="20%" style="padding:0 2px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td height="8" bgcolor="${dolu ? renk : R.cizgi}" style="height:8px;font-size:0;line-height:0;background:${dolu ? renk : R.cizgi}">&nbsp;</td></tr></table>
      <div style="font:${r.risk === k ? "700" : "400"} 9.5px/1.6 ${MONO};letter-spacing:.5px;color:${r.risk === k ? renk : R.soluk};padding-top:4px">${buyuk(RISK[k].ad)}</div></td>`;
  }).join("");
  const riskBandi = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate"><tr>
      <td bgcolor="${rk ? rk.zemin : R.panel}" style="background:${rk ? rk.zemin : R.panel};border:1px solid ${rk ? rk.kenar : R.cizgi};border-left:4px solid ${renk};border-radius:8px;padding:16px 18px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="middle" style="font:600 11px/1.4 ${MONO};letter-spacing:2px;color:${R.ikincil}">// RİSK DÜZEYİ</td>
          <td align="right" valign="middle">
            <table role="presentation" cellpadding="0" cellspacing="0" align="right"><tr><td style="border:1px solid ${renk};border-radius:4px;padding:4px 10px;font:700 12px/1.3 ${MONO};letter-spacing:2px;color:${renk}">[ ${buyuk(rk ? rk.ad : "Belirlenemedi")} ]</td></tr></table>
          </td></tr></table>
        <div style="font:700 30px/1.25 ${MONO};letter-spacing:1px;color:${renk};padding:8px 0 12px">${buyuk(rk ? rk.ad : "Belirlenemedi")}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${olcek}</tr></table>
        <div style="font:13.5px/1.55 ${SANS};color:${R.yazi};padding-top:12px"><span style="font-family:${MONO};color:${renk}">&gt;</span> ${esc(rk ? rk.aciklama : "Denetçi yapılandırılmış rapor üretmediği için risk düzeyi belirlenemedi.")}</div>
      </td></tr></table>`;

  // — Bulgu matrisi: 5 kutu —
  const matris = hamMetin
    ? ""
    : `${baslik("Bulgu matrisi")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${ORDER.map((s, i) => `
      <td width="20%" valign="top" style="padding:0 ${i === ORDER.length - 1 ? 0 : 4}px 0 ${i === 0 ? 0 : 4}px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td bgcolor="${R.panel}" style="background:${R.panel};border:1px solid ${R.cizgi};border-top:2px solid ${SEV[s].renk};border-radius:6px;padding:9px 10px">
            <div style="font:600 9.5px/1.4 ${MONO};letter-spacing:1px;color:${R.ikincil}">${buyuk(SEV[s].ad)}</div>
            <div style="font:700 24px/1.2 ${MONO};color:${c[s] ? SEV[s].renk : "#94a3b8"}">${String(c[s]).padStart(2, "0")}</div>
          </td></tr></table>
      </td>`).join("")}</tr></table>`;

  const ozet = r.summary
    ? `${baslik("Durum raporu")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td bgcolor="${R.terminal}" style="background:${R.terminal};border:1px solid ${R.cizgi};border-left:3px solid ${NEON.cyan};border-radius:8px;padding:12px 14px">
          <div style="font:12px/1.6 ${MONO};color:${R.yesil};padding-bottom:4px">$ cat ozet.txt</div>
          <div style="font:14px/1.65 ${SANS};color:${R.govde};overflow-wrap:anywhere">${esc(r.summary)}</div>
        </td></tr></table>`
    : "";

  // — Tespit edilen açıklar: kayıt satırı düzeni —
  let bulgular = "";
  if (hamMetin) {
    bulgular = `${baslik("Denetçinin notu")}<div style="font:13.5px/1.6 ${SANS};color:${R.govde}">Denetçi yapılandırılmış rapor üretmedi; yazdığı metin ${
      o.pdfAttached ? "ekteki PDF raporda" : "raporda"} yer alıyor.</div>`;
  } else if (!toplam) {
    bulgular = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px"><tr>
      <td bgcolor="${RISK.none.zemin}" style="background:${RISK.none.zemin};border:1px solid ${RISK.none.kenar};border-radius:8px;padding:14px 16px;font:14px/1.5 ${SANS};color:${R.yazi}">
        <span style="font:700 12px ${MONO};letter-spacing:1px;color:${RISK.none.renk}">[ TEMİZ ]</span>&nbsp; Güvenlik açığı bulunmadı — ${r.standalone ? "denetlenen kod tabanında" : "denetlenen değişikliklerde"} bildirilecek bir sorun yok.</td></tr></table>`;
  } else {
    const ust = r.findings.slice(0, TOP_FINDINGS);
    bulgular =
      baslik(toplam > TOP_FINDINGS ? `Tespit edilen açıklar · ${TOP_FINDINGS}/${toplam}` : `Tespit edilen açıklar · ${toplam}`) +
      ust.map((f, i) => {
        const s = SEV[f.severity] ?? SEV.info;
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;border-collapse:separate"><tr>
          <td bgcolor="${R.panel}" style="background:${R.panel};border:1px solid ${R.cizgi};border-left:3px solid ${s.renk};border-radius:6px;padding:12px 14px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td valign="middle">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                  <td bgcolor="${s.zemin}" style="background:${s.zemin};border:1px solid ${s.kenar};border-radius:4px;padding:2px 7px;font:700 10px/1.5 ${MONO};letter-spacing:1px;color:${s.renk};white-space:nowrap">${buyuk(s.ad)}</td>
                  <td style="padding-left:8px;font:600 11.5px/1.5 ${MONO};color:${R.soluk}">${kod(i)}</td>
                </tr></table>
              </td>
              <td align="right" valign="middle" style="font:11.5px/1.5 ${MONO};color:${R.ikincil}">${esc(f.cwe ?? "")}</td>
            </tr></table>
            <div style="font:600 14.5px/1.4 ${SANS};color:${R.yazi};padding-top:7px;overflow-wrap:anywhere">${esc(f.title)}</div>
            ${yer(f) ? `<div style="font:12px/1.6 ${MONO};color:${R.cyan};overflow-wrap:anywhere"><span style="color:${R.soluk}">└─</span> ${yolHtml(yer(f))}</div>` : ""}
            ${f.category ? `<div style="font:12px/1.5 ${SANS};color:${R.ikincil}">${esc(f.category)}</div>` : ""}
            ${f.recommendation ? `<div style="font:13px/1.55 ${SANS};color:${R.govde};padding-top:6px;overflow-wrap:anywhere;word-break:break-word"><span style="font:700 11px ${MONO};letter-spacing:1px;color:${R.yesil}">» DÜZELTME</span>&nbsp; ${esc(kisalt(f.recommendation, 260))}</div>` : ""}
          </td></tr></table>`;
      }).join("") +
      (toplam > TOP_FINDINGS
        ? `<div style="font:12.5px/1.5 ${MONO};color:${R.ikincil};padding-top:2px">+ ${toplam - TOP_FINDINGS} bulgu daha — tamamı ${o.pdfAttached ? "ekteki PDF raporda" : "raporda"}</div>`
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
    .map(([k, v, m]) => `<tr><td width="150" valign="top" style="padding:5px 12px 5px 0;border-top:1px solid ${R.cizgi};font:12.5px/1.5 ${MONO};color:${R.ikincil}">${k}</td>
      <td valign="top" style="padding:5px 0;border-top:1px solid ${R.cizgi};font:13px/1.5 ${m ? MONO : SANS};color:${R.yazi};overflow-wrap:anywhere">${m ? yolHtml(v) : esc(v)}</td></tr>`)
    .join("");

  const ekNotu = o.pdfAttached
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>
        <td bgcolor="#ecfeff" style="background:#ecfeff;border:1px solid #a5f3fc;border-radius:8px;padding:12px 14px;font:13.5px/1.5 ${SANS};color:#155e75">
        <span style="font:700 11px ${MONO};letter-spacing:1px;color:${R.cyan}">[ EK ]</span>&nbsp; Raporun tamamı PDF olarak ekte: tüm bulgular, kanıt satırları ve düzeltme önerileri.</td></tr></table>`
    : "";
  const dugme = o.link
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>
        <td bgcolor="${NEON.cyan}" style="background:${NEON.cyan};border:1px solid ${R.cyan};border-radius:6px">
          <a href="${esc(o.link)}" target="_blank" style="display:inline-block;padding:12px 22px;font:700 13px/1 ${MONO};letter-spacing:1.5px;color:#083344;text-decoration:none;border-radius:6px">RAPORU AÇ &rarr;</a>
        </td></tr></table>`
    : "";

  const html = `<!doctype html>
<html lang="tr" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
<style>
  :root { color-scheme:light; supported-color-schemes:light; }
  @media (max-width:620px) {
    .kap { width:100% !important; }
    .ic { padding-left:16px !important; padding-right:16px !important; }
  }
</style>
</head>
<body bgcolor="${R.dis}" style="margin:0;padding:0;background:${R.dis};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(onIzleme)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${R.dis}" style="background:${R.dis};background-image:linear-gradient(rgba(14,116,144,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(14,116,144,.06) 1px,transparent 1px);background-size:28px 28px">
<tr><td align="center" style="padding:24px 12px">
  <table role="presentation" class="kap" width="600" cellpadding="0" cellspacing="0" bgcolor="${R.kart}" style="width:600px;max-width:600px;background:${R.kart};border:1px solid ${R.cizgi};border-radius:12px;border-collapse:separate;overflow:hidden">
    <tr><td height="4" bgcolor="${NEON.cyan}" style="height:4px;font-size:0;line-height:0;background:${NEON.cyan};background-image:linear-gradient(90deg,${NEON.cyan},${NEON.yesil} 60%,${renk})">&nbsp;</td></tr>
    <tr><td class="ic" bgcolor="${R.kart}" style="background:${R.kart};padding:18px 28px;border-bottom:1px solid ${R.cizgi}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="middle">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td width="36" height="36" align="center" valign="middle" bgcolor="#ecfeff" style="background:#ecfeff;border:1px solid ${NEON.cyan};border-radius:8px;font:700 15px/36px ${MONO};color:${R.cyan}">&gt;_</td>
            <td style="padding-left:12px;font:700 15px/1.2 ${MONO};letter-spacing:3px;color:${R.yazi}">KURMAY
              <div style="font:500 10px/1.7 ${MONO};letter-spacing:2px;color:${R.cyan}">SİBER GÜVENLİK DENETİMİ</div></td>
          </tr></table>
        </td>
        <td align="right" valign="middle">
          <table role="presentation" cellpadding="0" cellspacing="0" align="right"><tr>
            <td style="border:1px solid #a7f3d0;border-radius:999px;padding:4px 11px;font:600 10.5px/1.4 ${MONO};letter-spacing:1px;color:${R.yesil};white-space:nowrap">● TARAMA TAMAMLANDI</td>
          </tr></table>
        </td>
      </tr></table>
    </td></tr>
    <tr><td class="ic" style="padding:24px 28px 8px">
      <div style="font:600 11px/1.4 ${MONO};letter-spacing:2px;color:${R.cyan}">${r.standalone ? "// KOD TABANI DENETİMİ" : "// GÖREV DENETİMİ"}</div>
      <div style="font:700 22px/1.3 ${SANS};color:${R.yazi};padding:6px 0 16px;overflow-wrap:anywhere">${esc(r.task)}</div>
      ${terminal}
      ${riskBandi}
      ${matris}
      ${ozet}
      ${bulgular}
      ${ekNotu}
      ${dugme}
      ${baslik("Hedef bilgileri")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${kunye}</table>
    </td></tr>
    <tr><td class="ic" style="padding:18px 28px 24px">
      <div style="font:11.5px/1.7 ${MONO};color:${R.soluk};border-top:1px solid ${R.cizgi};padding-top:14px">
        // Kurmay Güvenlik Denetçisi tarafından otomatik üretildi${o.version ? ` · v${esc(o.version)}` : ""}<br>
        // Denetçi kodu yalnızca okur; bulgular otomatik analiz sonucudur ve uygulanmadan önce bir geliştirici tarafından doğrulanmalıdır.
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  // Düz metin hâli: HTML göstermeyen istemciler ve önizleme için
  const satirlar = [
    `KURMAY // SİBER GÜVENLİK DENETİMİ`,
    ``,
    r.task,
    `$ ${komut}`,
    `${tarih(r.createdAt)} · ${r.targetDir}`,
    ``,
    `RİSK DÜZEYİ: ${buyuk(rk ? rk.ad : "Belirlenemedi")}${rk ? ` — ${rk.aciklama}` : ""}`,
    hamMetin ? `BULGULAR: yapılandırılmış rapor gelmedi` : `BULGU MATRİSİ: ${ORDER.map((s) => `${SEV[s].ad} ${c[s]}`).join(" · ")}`,
    ...(r.summary ? [``, `DURUM RAPORU`, r.summary] : []),
    ...(toplam
      ? [
          ``,
          toplam > TOP_FINDINGS ? `TESPİT EDİLEN AÇIKLAR (${TOP_FINDINGS}/${toplam})` : `TESPİT EDİLEN AÇIKLAR (${toplam})`,
          ...r.findings.slice(0, TOP_FINDINGS).flatMap((f, i) => [
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

/** Bölüm başlığı (e-posta içi): eş aralıklı, "//" önekli, ince camgöbeği çizgi */
function baslik(ad: string): string {
  return `<div style="font:700 11.5px/1.4 ${MONO};letter-spacing:2px;color:${R.yazi};padding:26px 0 8px;border-bottom:1px solid ${R.cizgi};margin-bottom:12px"><span style="color:${R.cyan}">//</span> ${esc(buyuk(ad))}</div>`;
}

/**
 * Gönderilmemiş taslak olarak .eml (RFC 5322 + MIME): Outlook "X-Unsent: 1" görünce iletiyi
 * yeni, düzenlenebilir taslak olarak açar — alıcıyı yazıp gönderirsin. Gövde HTML + düz metin,
 * varsa PDF ek. Satır sonları CRLF, içerikler base64 (Türkçe karakterler bozulmasın).
 */
export function buildEml(mail: ReportEmail, attachment?: { name: string; data: Buffer }): Buffer {
  const CRLF = "\r\n";
  const b64 = (buf: Buffer | string) => (Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8")).toString("base64").replace(/.{1,76}/g, "$&" + CRLF);
  const word = (s: string) => `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
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
  const basliklar = [
    `X-Unsent: 1`,
    `Subject: ${word(mail.subject)}`,
    `MIME-Version: 1.0`,
    `X-Mailer: Kurmay`,
  ];
  if (!attachment) return Buffer.from([...basliklar, ...govde, ``].join(CRLF), "utf8");
  const ascii = attachment.name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "_");
  const parcalar = [
    ...basliklar,
    `Content-Type: multipart/mixed; boundary="${sinir}"`,
    ``,
    `--${sinir}`,
    ...govde,
    `--${sinir}`,
    `Content-Type: application/pdf; name="${ascii}"`,
    `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64(attachment.data),
    `--${sinir}--`,
    ``,
  ];
  return Buffer.from(parcalar.join(CRLF), "utf8");
}
