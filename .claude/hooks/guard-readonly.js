// PreToolUse hook'u: salt-okunur ajanların (ör. analist) dosya değiştirmesini
// ENGELLER. `allowedTools` sert bir sandbox değil — listede olmayan araç yine de
// çalışabiliyor; asıl kapı bu hook.
//
// Sözleşme: hook girdisi stdin'e JSON gelir. `exit 2` = aracı engelle
// (stderr = modele giden gerekçe), `exit 0` = izin ver.
// process.exit() çıktıyı budayabildiği için doğal çıkış + exitCode kullanılıyor.
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let tool;
  let input;
  try {
    const veri = JSON.parse(raw);
    tool = (veri.tool_name || "").toString();
    input = veri.tool_input || {};
  } catch {
    return; // girdi okunamazsa engelleme (exit 0)
  }

  // Doğrudan yazan araçlar
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
    process.stderr.write(
      `${tool} engellendi: bu ajan salt-okunur (plan üretir, kod yazmaz). ` +
        `Değişikliği uygulama; plana yaz, uygulamayı saha timi yapacak.`,
    );
    process.exitCode = 2;
    return;
  }

  // Bash dolaylı yoldan yazabilir (>, tee, sed -i, cp/mv/rm ...) — yazma
  // belirtisi taşıyan komutlar engellenir, okuma/arama komutları serbest kalır
  if (tool === "Bash") {
    const cmd = (input.command || "").toString();
    const yazma =
      /(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|dd|chmod|chown)\b|>>?\s*[^&|\s]|\btee\b|\bsed\b[^|]*\s-i\b|\bgit\s+(add|commit|checkout|restore|apply|reset)\b|\bnpm\s+(i|install|uninstall)\b/i;
    if (yazma.test(cmd)) {
      process.stderr.write(
        `Bash engellendi (yazma belirtisi): ${cmd.slice(0, 200)}\n` +
          `Bu ajan salt-okunur — dosya değiştirme, plana yaz.`,
      );
      process.exitCode = 2;
      return;
    }
  }
  // diğer her şey serbest (exit 0)
});
