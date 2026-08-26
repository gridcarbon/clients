import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // ES2022 is the floor shared by Node 18, modern browsers, Workers, Deno and Bun.
  target: "es2022",
  platform: "neutral",
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
});
