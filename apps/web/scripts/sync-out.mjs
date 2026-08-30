import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const candidates = ["dist/client", "dist", ".output/public", "build/client"];

for (const dir of candidates) {
  const index = join(dir, "index.html");
  const shell = join(dir, "_shell.html");
  if (!existsSync(index) && !existsSync(shell)) continue;

  rmSync("out", { recursive: true, force: true });
  mkdirSync("out", { recursive: true });
  cpSync(dir, "out", { recursive: true });
  if (!existsSync("out/index.html") && existsSync("out/_shell.html")) {
    cpSync("out/_shell.html", "out/index.html");
  }
  console.log(`Copied SPA build from ${dir} to out/`);
  process.exit(0);
}

console.error("Could not find TanStack Start SPA output (looked for index.html or _shell.html).");
process.exit(1);
