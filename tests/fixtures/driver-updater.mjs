import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [, , counterPath, startedPath, delayText = "500"] = process.argv;
if (!counterPath || !startedPath) throw new Error("counter and started paths are required");

const previous = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) || 0 : 0;
writeFileSync(counterPath, String(previous + 1));
writeFileSync(startedPath, new Date().toISOString());
await new Promise((resolvePromise) => setTimeout(resolvePromise, Number(delayText) || 500));
process.stdout.write("fixture updater completed\n");
