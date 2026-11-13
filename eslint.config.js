// ESLint ayarı (düz yapılandırma). Biçim kuralları kapalı: biçimi Prettier yönetir (eslint-config-prettier).
// Kapsam: src/ (TypeScript), bin/, ui/*.js (tarayıcı), .claude/hooks/ (Node). Panelin HTML içi betikleri kapsam dışı.
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", "runs/", ".gizli/", "tanitim/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { globals: globals.node },
    rules: {
      // "_" ile başlayan ad bilinçli olarak kullanılmıyor (ör. ayıklanan alan: { disabled: _, ...rest })
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    files: ["bin/**/*.js", ".claude/hooks/**/*.js", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["ui/**/*.js"],
    languageOptions: { globals: globals.browser, sourceType: "script" },
  },
  prettier,
);
