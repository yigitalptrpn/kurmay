import path from "node:path";
import type { SecurityFinding, SecurityReport, Severity } from "./securityReport.js";
import { countBySeverity } from "./securityReport.js";

/**
 * Güvenlik raporunun e-posta hâli — ekibe gönderilecek özet. E-posta istemcileri (Outlook'un
 * Word motoru, Gmail) betik, SVG, CSS değişkeni ve dış yazı tipi çalıştırmaz; bu yüzden düzen
 * tablolarla, biçim satır içi stillerle kurulur ve HTML sunucuda üretilir. Renkler PDF
 * şablonuyla (ui/guvenlik-rapor.html) aynı; önem her yerde renkle birlikte yazıyla da verilir.
 */

const SANS = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "Consolas,'Courier New',monospace";

/** Önem: ad + yazı / zemin / kenar rengi (açık zeminde okunur) */
const SEV: Record<Severity, { ad: string; renk: string; yazi: string; zemin: string; kenar: string }> = {
  critical: { ad: "Kritik", renk: "#c62f37", yazi: "#a51f27", zemin: "#fdecec", kenar: "#f5c2c5" },
  high: { ad: "Yüksek", renk: "#d65a24", yazi: "#b4471b", zemin: "#fdf0e8", kenar: "#f6cdb7" },
  medium: { ad: "Orta", renk: "#b27a00", yazi: "#8a5d00", zemin: "#fdf5e0", kenar: "#f0d798" },
  low: { ad: "Düşük", renk: "#2a74b8", yazi: "#1f5f99", zemin: "#eaf3fb", kenar: "#bcd7ef" },
  info: { ad: "Bilgi", renk: "#64748b", yazi: "#475569", zemin: "#f1f5f9", kenar: "#cbd5e1" },
};
const ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const RISK: Record<string, { ad: string; renk: string; zemin: string; n: number; aciklama: string }> = {
  none: { ad: "Risk yok", renk: "#15803d", zemin: "#eaf7ee", n: 0, aciklama: "Denetimde bildirilecek bir güvenlik açığı bulunmadı." },
  low: { ad: "Düşük", renk: "#2a74b8", zemin: "#eaf3fb", n: 1, aciklama: "Düşük etkili zayıflıklar var; planlı olarak giderilmeli." },
  medium: { ad: "Orta", renk: "#b27a00", zemin: "#fdf5e0", n: 2, aciklama: "Belirli koşullarda istismar edilebilecek zayıflıklar var; yakın zamanda ele alınmalı." },
  high: { ad: "Yüksek", renk: "#d65a24", zemin: "#fdf0e8", n: 3, aciklama: "İstismar edilebilir ve önemli etki taşıyan bulgular var; öncelikle giderilmeli." },
  critical: { ad: "Kritik", renk: "#c62f37", zemin: "#fdecec", n: 4, aciklama: "Doğrudan istismar edilebilir, ciddi etkili bulgular var; hemen müdahale edilmeli." },
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

  const sayimMetni = hamMetin
    ? "yapılandırılmış rapor gelmedi"
    : toplam
      ? ORDER.filter((s) => c[s]).map((s) => `${c[s]} ${SEV[s].ad.toLocaleLowerCase("tr-TR")}`).join(", ")
      : "bulgu yok";
  const subject = `[Kurmay] Güvenlik denetimi: ${r.standalone ? proje : kisalt(r.task, 60)} — Risk: ${rk ? rk.ad : "belirlenemedi"} (${sayimMetni})`;
  const onIzleme = `${rk ? `Genel risk ${rk.ad.toLocaleLowerCase("tr-TR")}` : "Risk belirlenemedi"} · ${sayimMetni} · ${r.summary ? kisalt(r.summary, 120) : r.task}`;

  // — Risk kutusu ve ölçek —
  const olcek = RISK_ORDER.map((k, i) => {
    const dolu = rk && i <= rk.n;
    return `<td width="20%" style="padding:0 2px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td height="6" bgcolor="${dolu ? rk!.renk : "#e2e8f0"}" style="height:6px;font-size:0;line-height:0;border-radius:3px">&nbsp;</td></tr></table>
      <div style="font:${r.risk === k ? "700" : "400"} 10px/1.6 ${SANS};color:${r.risk === k ? "#0f172a" : "#94a3b8"};padding-top:3px">${RISK[k].ad}</div></td>`;
  }).join("");
  const riskKutusu = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate">
      <tr><td bgcolor="${rk ? rk.zemin : "#f1f5f9"}" style="background:${rk ? rk.zemin : "#f1f5f9"};border-left:4px solid ${rk ? rk.renk : "#94a3b8"};border-radius:8px;padding:16px 18px">
        <div style="font:600 11px/1.4 ${SANS};letter-spacing:1.5px;text-transform:uppercase;color:#64748b">Genel risk düzeyi</div>
        <div style="font:700 24px/1.3 ${SANS};color:${rk ? rk.renk : "#475569"};padding:2px 0 10px">${rk ? esc(rk.ad) : "Belirlenemedi"}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:360px"><tr>${olcek}</tr></table>
        <div style="font:14px/1.55 ${SANS};color:#334155;padding-top:10px">${esc(rk ? rk.aciklama : "Denetçi yapılandırılmış rapor üretmediği için risk düzeyi belirlenemedi.")}</div>
      </td></tr>
    </table>`;

  // — Önem dağılımı: 5 kutu —
  const sayilar = hamMetin
    ? ""
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr>${ORDER.map((s, i) => `
      <td width="20%" valign="top" style="padding:0 ${i === ORDER.length - 1 ? 0 : 4}px 0 ${i === 0 ? 0 : 4}px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="border:1px solid #e2e8f0;border-top:3px solid ${SEV[s].renk};border-radius:6px;padding:8px 10px">
            <div style="font:12px/1.4 ${SANS};color:#64748b">${SEV[s].ad}</div>
            <div style="font:700 22px/1.2 ${SANS};color:${c[s] ? "#0f172a" : "#cbd5e1"}">${c[s]}</div>
          </td></tr></table>
      </td>`).join("")}</tr></table>`;

  const ozet = r.summary
    ? `${baslik("Özet")}<div style="font:14.5px/1.65 ${SANS};color:#334155;overflow-wrap:anywhere">${esc(r.summary)}</div>`
    : "";

  // — Öne çıkan bulgular —
  let bulgular = "";
  if (hamMetin) {
    bulgular = `${baslik("Denetçinin notu")}<div style="font:13.5px/1.6 ${SANS};color:#334155">Denetçi yapılandırılmış rapor üretmedi; yazdığı metin ${
      o.pdfAttached ? "ekteki PDF raporda" : "raporda"} yer alıyor.</div>`;
  } else if (!toplam) {
    bulgular = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px"><tr>
      <td bgcolor="#f0fdf4" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 16px;font:14px/1.5 ${SANS};color:#14532d">
        <b>&#10003; Güvenlik açığı bulunmadı.</b> ${r.standalone ? "Denetlenen kod tabanında" : "Denetlenen değişikliklerde"} bildirilecek bir sorun yok.</td></tr></table>`;
  } else {
    const ust = r.findings.slice(0, TOP_FINDINGS);
    bulgular =
      baslik(toplam > TOP_FINDINGS ? `Öne çıkan bulgular (${TOP_FINDINGS} / ${toplam})` : "Bulgular") +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${ust.map((f, i) => {
        const s = SEV[f.severity] ?? SEV.info;
        const etiket = [f.category, f.cwe].filter(Boolean).map((x) => esc(x)).join(" · ");
        return `<tr><td style="padding:12px 0;${i ? "border-top:1px solid #e2e8f0;" : ""}">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td valign="top" width="78" style="padding:2px 12px 0 0">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="${s.zemin}" style="background:${s.zemin};border:1px solid ${s.kenar};border-radius:4px;padding:3px 7px;font:700 10px/1.4 ${SANS};letter-spacing:1px;text-transform:uppercase;color:${s.yazi};white-space:nowrap">${s.ad}</td></tr></table>
            </td>
            <td valign="top">
              <div style="font:600 14.5px/1.4 ${SANS};color:#0f172a;overflow-wrap:anywhere">${esc(f.title)}</div>
              ${yer(f) ? `<div style="font:12px/1.6 ${MONO};color:#0369a1;word-break:break-all">${esc(yer(f))}</div>` : ""}
              ${etiket ? `<div style="font:12px/1.5 ${SANS};color:#64748b">${etiket}</div>` : ""}
              ${f.recommendation ? `<div style="font:13px/1.55 ${SANS};color:#334155;padding-top:5px;overflow-wrap:anywhere;word-break:break-word"><b style="color:#15803d">Öneri:</b> ${esc(kisalt(f.recommendation, 260))}</div>` : ""}
            </td></tr></table>
        </td></tr>`;
      }).join("")}</table>` +
      (toplam > TOP_FINDINGS
        ? `<div style="font:13px/1.5 ${SANS};color:#64748b;padding-top:6px">+ ${toplam - TOP_FINDINGS} bulgu daha — tamamı ${o.pdfAttached ? "ekteki PDF raporda" : "raporda"}.</div>`
        : "");
  }

  const kunye = [
    ["Kapsam", r.standalone ? "Bağımsız denetim — kod tabanının tamamı" : "Akış içi denetim — değişen dosyalar"],
    ["Proje dizini", r.targetDir, "mono"],
    r.model ? ["Model", r.model, "mono"] : null,
    r.sessionName ? ["Oturum", r.sessionName] : null,
    [r.standalone ? "İncelenen dosya" : "Denetlenen dosya", String(r.files.length)],
    ["Rapor no", r.id, "mono"],
  ]
    .filter((x): x is string[] => !!x)
    .map(([k, v, m]) => `<tr><td width="130" valign="top" style="padding:5px 12px 5px 0;border-top:1px solid #f1f5f9;font:13px/1.5 ${SANS};color:#64748b">${k}</td>
      <td valign="top" style="padding:5px 0;border-top:1px solid #f1f5f9;font:13px/1.5 ${m ? MONO : SANS};color:#0f172a;${m ? "word-break:break-all" : "overflow-wrap:anywhere"}">${esc(v)}</td></tr>`)
    .join("");

  const ekNotu = o.pdfAttached
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px"><tr>
        <td bgcolor="#f0f9ff" style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px 14px;font:13.5px/1.5 ${SANS};color:#075985">
        &#128206; <b>Raporun tamamı ekte (PDF):</b> tüm bulgular, kanıt satırları ve düzeltme önerileri.</td></tr></table>`
    : "";
  const dugme = o.link
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px"><tr>
        <td bgcolor="#0369a1" style="background:#0369a1;border-radius:8px">
          <a href="${esc(o.link)}" target="_blank" style="display:inline-block;padding:12px 22px;font:600 14px/1 ${SANS};color:#ffffff;text-decoration:none;border-radius:8px">Raporu Kurmay'da aç &rarr;</a>
        </td></tr></table>`
    : "";

  const html = `<!doctype html>
<html lang="tr" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
<style>
  @media (max-width:620px) {
    .kap { width:100% !important; }
    .ic { padding-left:18px !important; padding-right:18px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#eef2f7;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(onIzleme)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#eef2f7" style="background:#eef2f7">
<tr><td align="center" style="padding:24px 12px">
  <table role="presentation" class="kap" width="600" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;border-collapse:separate;overflow:hidden">
    <tr><td bgcolor="#0f172a" class="ic" style="background:#0f172a;padding:18px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="middle">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td width="34" height="34" bgcolor="#0ea5e9" align="center" valign="middle" style="background:#0ea5e9;border-radius:8px;font:700 16px/34px ${SANS};color:#ffffff">&#10003;</td>
            <td style="padding-left:10px;font:700 15px/1.2 ${SANS};letter-spacing:2px;color:#ffffff">KURMAY
              <div style="font:500 10.5px/1.6 ${SANS};letter-spacing:1.6px;color:#94a3b8">GÜVENLİK DENETİM RAPORU</div></td>
          </tr></table>
        </td>
        <td align="right" valign="middle" style="font:12px/1.5 ${SANS};color:#94a3b8">${esc(tarih(r.createdAt))}</td>
      </tr></table>
    </td></tr>
    <tr><td height="4" bgcolor="#0ea5e9" style="height:4px;font-size:0;line-height:0;background:#0ea5e9;background-image:linear-gradient(90deg,#0369a1,#0ea5e9 55%,#a5f3fc)">&nbsp;</td></tr>
    <tr><td class="ic" style="padding:26px 28px 8px">
      <div style="font:600 11px/1.4 ${SANS};letter-spacing:1.5px;text-transform:uppercase;color:#0369a1">${r.standalone ? "Kod tabanı denetimi" : "Görev denetimi"}</div>
      <div style="font:700 22px/1.3 ${SANS};color:#0f172a;padding:6px 0 18px;overflow-wrap:anywhere">${esc(r.task)}</div>
      ${riskKutusu}
      ${sayilar}
      ${ozet}
      ${bulgular}
      ${ekNotu}
      ${dugme}
      ${baslik("Künye")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${kunye}</table>
    </td></tr>
    <tr><td class="ic" style="padding:18px 28px 24px">
      <div style="font:12px/1.6 ${SANS};color:#64748b;border-top:1px solid #e2e8f0;padding-top:14px">
        Bu e-posta Kurmay'ın Güvenlik Denetçisi tarafından üretilen rapordan hazırlandı${o.version ? ` (Kurmay ${esc(o.version)})` : ""}.
        Denetçi kodu yalnızca okur; bulgular otomatik analiz sonucudur ve uygulanmadan önce bir geliştirici tarafından doğrulanmalıdır.
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  // Düz metin hâli: HTML göstermeyen istemciler ve önizleme için
  const satirlar = [
    `KURMAY · GÜVENLİK DENETİM RAPORU`,
    ``,
    r.task,
    `${tarih(r.createdAt)} · ${r.targetDir}`,
    ``,
    `Genel risk: ${rk ? rk.ad : "belirlenemedi"}${rk ? ` — ${rk.aciklama}` : ""}`,
    hamMetin ? `Bulgular: yapılandırılmış rapor gelmedi` : `Bulgular: ${ORDER.map((s) => `${SEV[s].ad} ${c[s]}`).join(" · ")}`,
    ...(r.summary ? [``, `ÖZET`, r.summary] : []),
    ...(toplam
      ? [
          ``,
          toplam > TOP_FINDINGS ? `ÖNE ÇIKAN BULGULAR (${TOP_FINDINGS} / ${toplam})` : `BULGULAR`,
          ...r.findings.slice(0, TOP_FINDINGS).flatMap((f) => [
            `- [${(SEV[f.severity] ?? SEV.info).ad.toLocaleUpperCase("tr-TR")}] ${f.title}${yer(f) ? ` (${yer(f)})` : ""}`,
            ...(f.recommendation ? [`  Öneri: ${kisalt(f.recommendation, 260)}`] : []),
          ]),
          ...(toplam > TOP_FINDINGS ? [`+ ${toplam - TOP_FINDINGS} bulgu daha`] : []),
        ]
      : []),
    ...(o.pdfAttached ? [``, `Raporun tamamı ekte (PDF).`] : []),
    ...(o.link ? [``, `Rapor: ${o.link}`] : []),
    ``,
    `Rapor no: ${r.id}`,
    `Bulgular otomatik analiz sonucudur; uygulanmadan önce doğrulanmalıdır.`,
  ];
  return { subject, html, text: satirlar.join("\n") };
}

/** Bölüm başlığı (e-posta içi) */
function baslik(ad: string): string {
  return `<div style="font:700 12px/1.4 ${SANS};letter-spacing:1.5px;text-transform:uppercase;color:#0f172a;padding:26px 0 8px;border-bottom:2px solid #0f172a;margin-bottom:10px">${esc(ad)}</div>`;
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
