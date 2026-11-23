// Flat config for Chevis's repo contract, row C3: non-Next TS repos carry the
// @typescript-eslint/* rules of the base (typescript-eslint `recommended`).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
  },
);
