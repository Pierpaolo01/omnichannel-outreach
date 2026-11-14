import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Domain modules hold the rules: no I/O, and time and identifiers are passed in. */
const domainClockAndIdentity = [
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "Domain code takes the time as input; do not read the clock." },
  { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: "Domain code takes the time as input; do not read the clock." },
  { selector: "MemberExpression[object.name='performance'][property.name='now']", message: "Domain code takes the time as input; do not read the clock." },
  { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: "Domain code takes identifiers as input; do not generate randomness." },
  { selector: "CallExpression[callee.property.name='randomUUID']", message: "Domain code takes identifiers as input; do not generate them." },
  { selector: "CallExpression[callee.name='setTimeout'], CallExpression[callee.name='setInterval']", message: "Domain code has no timers." },
];

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "test-results/", "playwright-report/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-confusing-void-expression": "off",
      "no-console": ["error", { allow: ["info", "error"] }],
    },
  },
  {
    files: ["src/domain/**/*.ts"],
    ignores: ["src/domain/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...domainClockAndIdentity],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Domain code does no I/O." },
        { name: "process", message: "Domain code does not read the environment." },
        { name: "crypto", message: "Domain code takes identifiers as input." },
      ],
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["node:*", "fs", "path", "http", "https", "crypto", "os", "child_process"], message: "Domain code does no I/O." }, { group: ["**/server/**", "**/web/**"], message: "Domain code depends on nothing outside the domain." }] },
      ],
    },
  },
  {
    // Request bodies refuse unknown fields: every one is declared with requestObject (src/server/request-body.ts).
    files: ["src/server/**/*.ts"],
    ignores: ["src/server/**/*.test.ts", "src/server/request-body.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.object.name='z'][callee.property.name=/^(object|looseObject|passthrough)$/]", message: "Declare a request body with requestObject from src/server/request-body.ts: it refuses unknown fields." },
      ],
    },
  },
  {
    // The SQLite adapter satisfies an asynchronous interface over a synchronous driver.
    files: ["src/server/persistence/sqlite-store.ts", "src/server/persistence/sqlite-engine-store.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    files: ["src/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ["**/*.test.ts", "test/**/*.ts", "e2e/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
      // Vitest's asymmetric matchers (expect.objectContaining) are typed `any`.
      "@typescript-eslint/no-unsafe-assignment": "off",
      // Test harnesses satisfy async interfaces with synchronous fakes.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["e2e/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='fulfill']",
          message: "Fake responses with respond() from e2e/mocks.ts, so they are typed against src/shared/api.ts.",
        },
      ],
    },
  },
  { files: ["eslint.config.js"], ...tseslint.configs.disableTypeChecked },
);
