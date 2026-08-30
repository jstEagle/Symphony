import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: [
      "src/components/assistant-ui/**/*.{ts,tsx}",
      "src/components/ui/dotm-*.tsx",
      "src/hooks/use-attachment-src.ts",
      "src/lib/dotmatrix-*.{ts,tsx}",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-empty": "off",
    },
  },
  globalIgnores([
    "out/**",
    "dist/**",
    ".output/**",
    ".next/**",
    "src/routeTree.gen.ts",
    "scripts/**",
  ]),
]);
