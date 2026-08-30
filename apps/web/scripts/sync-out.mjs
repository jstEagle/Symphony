import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const candidates = ["dist/client", "dist", ".output/public", "build/client"];

for (const dir of candidates) {
  const index = join(dir, "index.html");
  const shell = join(dir, "_shell.html");
  if (!existsSync(index) && !existsSync(shell)) continue;

  mkdirSync("out", { recursive: true });

  // Publish immutable assets before the HTML that references them, and retain
  // prior hashed assets so a tab opened on the previous build can still lazy
  // load a chunk after a local rebuild. Deleting `out/` here created a race in
  // which an already-open Symphony tab crashed on its next dynamic import.
  for (const entry of readdirSync(dir)) {
    if (entry === "index.html" || entry === "_shell.html") continue;
    cpSync(join(dir, entry), join("out", entry), { recursive: true, force: true });
  }

  const publishHtml = (source, name) => {
    const destination = join("out", name);
    const temporary = join("out", `.${name}.${process.pid}.tmp`);
    try {
      cpSync(source, temporary, { force: true });
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
  };

  if (existsSync(shell)) publishHtml(shell, "_shell.html");
  publishHtml(existsSync(index) ? index : shell, "index.html");
  console.log(`Copied SPA build from ${dir} to out/`);
  process.exit(0);
}

console.error("Could not find TanStack Start SPA output (looked for index.html or _shell.html).");
process.exit(1);
