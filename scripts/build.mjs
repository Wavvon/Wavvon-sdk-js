// tsc does not copy hand-placed .d.ts files, and the generated schema is one.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
cpSync("src/generated/schema.d.ts", "dist/generated/schema.d.ts");
