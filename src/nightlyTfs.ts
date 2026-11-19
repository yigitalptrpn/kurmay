import { findingKey, type NightlyRepo, type NightlyRun } from "./nightlyAudit.js";
import type { SecurityFinding, SecurityReport, Severity } from "./securityReport.js";
import { createWorkItem, taggedWorkItems, TfsError, type TfsConnection, type TfsTaggedItem } from "./tfs.js";
import { textToTfsHtml } from "./tfsHtml.js";
import { POSTA_BASLIK } from "./tfsTask.js";
import type { NightlyAuditConfig } from "./types.js";

/**
 * Gece denetiminin kritik/yüksek bulguları için TFS iş öğesi (kullanıcı kararı 2026-11-19:
 * "her bulguya ayrı", "kritik ve yüksek"). Her gece tüm depolar denetlendiği için aynı bulgu
 * her gece yeniden çıkar — TEKRAR AÇILMAZ: iş öğesi `kurmay-guvenlik` ve bulgunun parmak izini
 * taşıyan `kurmay-<iz>` etiketleriyle açılır; o etiketi taşıyan açık (tamamlanmamış/
 * kaldırılmamış) iş öğesi varsa yenisi açılmaz. Eşleşme TFS'teki etiketlerden yapıldığı için
 * Kurmay'ın kendi kaydı silinse ya da başka bilgisayardaki Kurmay çalışsa da tekrar olmaz.
 * Kapatılan iş öğesinin bulgusu yeniden çıkarsa yeni iş öğesi açılır (düzeltme tutmamış).
 */

export const SECURITY_TAG = "kurmay-guvenlik";
const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEV_NAME: Record<Severity, string> = {
  critical: "Kritik",
  high: "Yüksek",
  medium: "Orta",
  low: "Düşük",
  info: "Bilgi",
};
/** Bug türünde açıklama "Yeniden üretme adımları" alanında görünür (Agile/Scrum/CMMI) */
const REPRO = "Microsoft.VSTS.TCM.ReproSteps";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const kirp = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** İş öğesinin açıklaması (TFS HTML'i) — Kurmay'ın TFS'e yazdığı her metin gibi POSTA_BASLIK'la başlar */
export function findingHtml(
  repo: Pick<NightlyRepo, "name" | "ref" | "commit">,
  f: SecurityFinding,
  o: { date: string; reportUrl?: string },
): string {
  const yer = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "";
  const tur = [f.category, f.cwe].filter(Boolean).join(" · ");
  const ust = [
    POSTA_BASLIK,
    `**GÜVENLİK TESPİTİ — ${repo.name}**`,
    "",
    `**Önem:** ${SEV_NAME[f.severity]}`,
    ...(yer ? [`**Yer:** \`${yer}\``] : []),
    ...(tur ? [`**Tür:** ${tur}`] : []),
    "",
    `**Tespit:** ${kirp(f.description.replace(/\s+/g, " "), 3000)}`,
  ];
  const alt = [
    ...(f.recommendation ? [`**Düzeltme önerisi:** ${kirp(f.recommendation.replace(/\s+/g, " "), 2000)}`, ""] : []),
    `**Denetim:** Gece güvenlik denetimi, ${o.date}.` +
      (repo.ref ? ` Denetlenen: ${repo.ref}${repo.commit ? ` (${repo.commit})` : ""}.` : "") +
      (o.reportUrl ? ` [Raporu aç](${o.reportUrl})` : ""),
    "",
    "*Bu kayıt Kurmay'ın gece güvenlik denetimiyle kendiliğinden açıldı. Bulgu yapay zekâ incelemesine dayanır; " +
      "düzeltmeden önce doğrulayın. Bu kayıt açık kaldıkça aynı bulgu için yenisi açılmaz.*",
    "",
    "*Arz ederim. — Kurmay*",
  ];
  const kanit = f.evidence
    ? `<div><br></div><div><b>Kanıt:</b></div><pre>${esc(kirp(f.evidence, 4000))}</pre><div><br></div>`
    : "<div><br></div>";
  return textToTfsHtml(ust.join("\n")) + kanit + textToTfsHtml(alt.join("\n"));
}

const closed = (i: TfsTaggedItem) => i.category === "Completed" || i.category === "Removed";

/**
 * Bir koşunun iş öğesi işleri. Açık Kurmay güvenlik iş öğeleri koşu başında bir kez sorulur;
 * koşu içinde açılanlar da haritaya eklenir (aynı gece iki depoda aynı iz olmaz ama aynı depoda
 * aynı dosya + açık türü iki kez raporlanabilir).
 */
export class NightlyWorkItems {
  private open?: Promise<Map<string, TfsTaggedItem>>;

  constructor(
    private readonly o: {
      conn: TfsConnection;
      settings: NonNullable<NightlyAuditConfig["workItems"]>;
      /** Rapor bağlantısı için Kurmay'ın ağdaki adresi */
      panelUrl?: string;
    },
  ) {}

  private openItems(): Promise<Map<string, TfsTaggedItem>> {
    this.open ??= taggedWorkItems(this.o.conn, SECURITY_TAG).then((list) => {
      const m = new Map<string, TfsTaggedItem>();
      for (const i of list) {
        if (closed(i)) continue;
        for (const t of i.tags)
          if (/^kurmay-[0-9a-f]{12}$/i.test(t) && !m.has(t.toLowerCase())) m.set(t.toLowerCase(), i);
      }
      return m;
    });
    this.open.catch(() => (this.open = undefined));
    return this.open;
  }

  /** Deponun eşiği geçen bulguları için iş öğesi aç (zaten açık olanı atla); sonuç repo.workItems'a */
  async handle(run: NightlyRun, repo: NightlyRepo, report: SecurityReport): Promise<void> {
    const min = RANK[this.o.settings.minSeverity ?? "high"];
    const want = report.findings.filter((f) => RANK[f.severity] <= min);
    if (!want.length || !repo.key) return;
    const open = await this.openItems();
    const type = this.o.settings.type || "Bug";
    const date = new Date(report.createdAt).toLocaleString("tr-TR", { dateStyle: "long", timeStyle: "short" });
    const reportUrl = this.o.panelUrl
      ? `${this.o.panelUrl.replace(/\/+$/, "")}/guvenlik#${encodeURIComponent(report.id)}`
      : undefined;
    repo.workItems = [];
    run.workItems ??= { enabled: true, created: 0, existing: 0 };
    for (const f of want) {
      const key = findingKey(repo.key, f);
      const tag = `kurmay-${key}`;
      const have = open.get(tag);
      if (have) {
        if (!repo.workItems.some((w) => w.id === have.id)) {
          repo.workItems.push({
            id: have.id,
            url: have.url,
            key,
            severity: f.severity,
            title: f.title,
            existing: true,
          });
          run.workItems.existing++;
        }
        continue;
      }
      const title = kirp(`[Güvenlik · ${SEV_NAME[f.severity]}] ${f.title} — ${repo.name}`, 255);
      const html = findingHtml(repo, f, { date, ...(reportUrl ? { reportUrl } : {}) });
      const base: Record<string, string> = {
        "System.Title": title,
        "System.Tags": `${SECURITY_TAG}; ${tag}`,
        ...(this.o.settings.areaPath ? { "System.AreaPath": this.o.settings.areaPath } : {}),
      };
      let made: { id: number; url: string };
      try {
        made = await createWorkItem(this.o.conn, type, {
          ...base,
          [/^bug$/i.test(type) ? REPRO : "System.Description"]: html,
        });
      } catch (e) {
        // Süreç şablonu değiştirilmiş: Bug'da "yeniden üretme adımları" alanı yoksa açıklama alanına yaz
        if (!(e instanceof TfsError) || e.status !== 400 || !/^bug$/i.test(type)) throw e;
        made = await createWorkItem(this.o.conn, type, { ...base, "System.Description": html });
      }
      const item: TfsTaggedItem = { id: made.id, title, state: "", tags: [SECURITY_TAG, tag], url: made.url };
      open.set(tag, item);
      repo.workItems.push({ id: made.id, url: made.url, key, severity: f.severity, title: f.title, existing: false });
      run.workItems.created++;
    }
    // Özetteki kritik/yüksek bulgulara iş öğesini işle
    for (const h of repo.highlights ?? []) {
      const w = repo.workItems.find((x) => x.key === h.key);
      if (w) h.workItem = { id: w.id, url: w.url, existing: w.existing };
    }
  }
}
