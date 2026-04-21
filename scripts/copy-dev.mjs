import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const mappings = [
  { src: "dist-dev/bundle.js", dest: "dist/bundle-dev.js" },
  { src: "dist-dev/games.js", dest: "dist/games-dev.js" },
  { src: "dist-dev/tournaments.js", dest: "dist/tournaments-dev.js" },
  { src: "dist-dev/onboarding.js", dest: "dist/onboarding-dev.js" },
  { src: "dist-dev/communities.js", dest: "dist/communities-dev.js" },
  { src: "dist-dev/release.json", dest: "dist/release-dev.json" },
];

const cwd = process.cwd();

await mkdir(resolve(cwd, "dist"), { recursive: true });

const results = await Promise.allSettled(
  mappings.map(async ({ src, dest }) => {
    const from = resolve(cwd, src);
    const to = resolve(cwd, dest);
    await copyFile(from, to);
    return { from, to };
  }),
);

const failed = results.filter((r) => r.status === "rejected");
if (failed.length > 0) {
  console.error("Не удалось скопировать dev-бандлы:");
  failed.forEach((item, idx) => {
    console.error(idx + 1, item.reason);
  });
  process.exit(1);
}

console.log("Dev-бандлы скопированы в dist с суффиксом -dev.");
