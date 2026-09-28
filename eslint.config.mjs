import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "release/**", "resources/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: Object.fromEntries(
        ["console", "process", "window", "document", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "URL"].map((g) => [g, "readonly"]),
      ),
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { module: "writable", require: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // House style, as on the site: separate metadata with layout, never middot characters.
    files: ["**/*.{ts,mjs,cjs}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...["Literal[value=/\\u00b7/]", "TemplateElement[value.raw=/\\u00b7/]"].map((selector) => ({
          selector,
          message: "Don't use middots; separate items with layout instead.",
        })),
      ],
    },
  },
);
