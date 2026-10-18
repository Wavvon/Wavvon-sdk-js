import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src/generated", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { console: "readonly", process: "readonly", fetch: "readonly", URL: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", atob: "readonly", AbortSignal: "readonly", Request: "readonly", Response: "readonly", Headers: "readonly", TextEncoder: "readonly", TextDecoder: "readonly", WebSocket: "readonly" },
    },
  },
);
