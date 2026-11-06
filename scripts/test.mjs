// Runs every lib/**/*.test.ts with Node's built-in test runner.
//
// TypeScript and the "@/" alias are handled by jiti, the same loader the
// toolchain already uses, so tests need no build step and no extra runner.
// Tests cover pure logic only: nothing here may touch the database, the
// network or a paid service.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });

function find(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(path).isDirectory() ? find(path) : name.endsWith(".test.ts") ? [path] : [];
  });
}

// `npm test` runs everything; `node scripts/test.mjs lib/news/spot.test.ts` runs one file.
const args = process.argv.slice(2);
const files = args.length ? args.map((a) => join(root, a)) : find(join(root, "lib"));
if (!files.length) {
  console.log("No tests found under lib/.");
  process.exit(0);
}
for (const file of files) {
  console.log(`# ${relative(root, file)}`);
  await jiti.import(file);
}
