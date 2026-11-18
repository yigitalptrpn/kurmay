/**
 * Okunuşa göre eşleştirme: İngilizce yazılmış adlar (depo, branch, sınıf) Türkçe söylendiğinde ses
 * tanıma onları okunduğu gibi yazar ("order-service" → "ordır servis", "PaymentController" →
 * "peymınt kontrolır"). İki taraf da kaba bir ses iskeletine çevrilir (ünlüler atılır, benzer sesler
 * birleştirilir) ve iskeletler karşılaştırılır. Model çağrısı yok, hızlı ve öngörülebilir.
 * Aynı mantığın bir kopyası panelde (ui/index.html `okunus`) — biri değişirse öteki de.
 */
export function okunus(s: string): string {
  let t = s
    .toLocaleLowerCase("tr")
    .replace(/([a-zçğıöşü])(?=[A-Z])/g, "$1 ")
    .replace(/â/g, "a")
    .replace(/î/g, "i")
    .replace(/û/g, "u");
  // İngilizce yazımı Türkçe okunuşa yaklaştır (sıra önemli: uzun kalıplar önce)
  t = t
    .replace(/tion/g, "şın")
    .replace(/sion/g, "jın")
    .replace(/ture/g, "çur")
    .replace(/sh/g, "ş")
    .replace(/ch/g, "ç")
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/ck/g, "k")
    .replace(/qu/g, "kv")
    .replace(/x/g, "ks")
    .replace(/w/g, "v")
    .replace(/c(?=[eiy])/g, "s")
    // İngilizce "c" çoğunlukla k okunur; Türkçe "c" (İngilizce "j" sesi, "cava" = "java") ile ayrımı
    // yapılamadığı için ikisi de k'ye düşer — iki taraf aynı kurala uyduğu için eşleşme bozulmaz
    .replace(/[cjq]/g, "k");
  return t
    .replace(/ğ/g, "")
    .replace(/[aeıioöuüyh]/g, "")
    .replace(/[^a-zçşğ0-9]/g, "")
    .replace(/(.)\1+/g, "$1");
}

function mesafe(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let onceki = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, onceki + (a[i - 1] === b[j - 1] ? 0 : 1));
      onceki = t;
    }
  }
  return d[b.length];
}

/** Söylenene okunuşça en yakın adlar (en yakın önce); eşik dışındakiler yok */
export function okunusSirala(sorgu: string, adlar: string[]): Array<{ ad: string; puan: number }> {
  const q = okunus(sorgu);
  if (q.length < 2) return [];
  return adlar
    .map((ad) => {
      const k = okunus(ad);
      if (!k) return { ad, puan: 1 };
      if (k === q) return { ad, puan: 0 };
      // Adın bir parçası söylendiyse ("ordır" → "order-service")
      if (q.length >= 3 && k.includes(q)) return { ad, puan: 0.2 };
      return { ad, puan: mesafe(q, k) / Math.max(q.length, k.length) };
    })
    .filter((x) => x.puan <= 0.34)
    .sort((a, b) => a.puan - b.puan);
}

/** Tek açık kazanan varsa onu, yakın birden çok aday varsa (en fazla 3) onları döner */
export function okunusBul(sorgu: string, adlar: string[]): { ad?: string; adaylar?: string[] } {
  const s = okunusSirala(sorgu, adlar);
  if (!s.length) return {};
  if (s.length === 1 || s[1].puan - s[0].puan >= 0.1) return { ad: s[0].ad };
  return { adaylar: s.slice(0, 3).map((x) => x.ad) };
}

/**
 * Metinde okunuşça geçen adları bulur ("peymınt kontrolır'a metot ekle" → PaymentController).
 * Metnin 1-3 kelimelik her penceresi adların ses iskeletleriyle karşılaştırılır; yalnızca yakın
 * olanlar döner (en yakın önce, en fazla `max`). Metinde zaten aynen geçen ad dönmez.
 */
export function metindekiAdlar(metin: string, adlar: Array<{ ad: string; k: string }>, max = 12): string[] {
  const kelimeler = metin.split(/\s+/).filter(Boolean);
  const kucuk = metin.toLocaleLowerCase("tr");
  const enIyi = new Map<string, number>();
  for (let i = 0; i < kelimeler.length; i++) {
    for (let n = 1; n <= 3 && i + n <= kelimeler.length; n++) {
      const q = okunus(kelimeler.slice(i, i + n).join(" "));
      if (q.length < 4) continue; // kısa kelimeler her adla benzeşir
      for (const { ad, k } of adlar) {
        if (k.length < 4 || Math.abs(k.length - q.length) > Math.max(2, k.length * 0.3)) continue;
        const puan = k === q ? 0 : mesafe(q, k) / Math.max(q.length, k.length);
        if (puan > 0.25) continue;
        if ((enIyi.get(ad) ?? 1) > puan) enIyi.set(ad, puan);
      }
    }
  }
  return [...enIyi]
    .filter(([ad]) => !kucuk.includes(ad.toLocaleLowerCase("tr")))
    .sort((a, b) => a[1] - b[1])
    .slice(0, max)
    .map(([ad]) => ad);
}
