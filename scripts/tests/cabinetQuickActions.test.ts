import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");

test("cabinet group trainings quick action opens standalone group schedule with cabinet return path", () => {
  assert.match(cabinetSource, /const GROUP_TRAININGS_URL = "https:\/\/padlhub\.ru\/group";/);
  assert.match(
    cabinetSource,
    /\{ icon: "👥", label: "Групповые тренировки", href: GROUP_TRAININGS_URL \}/,
  );
  assert.match(cabinetSource, /function resolveGroupTrainingsHref\(value: string\): string/);
  assert.match(cabinetSource, /const resolvedCabinetUrl = resolvePublicGamesCabinetUrl\(current\);/);
  assert.match(cabinetSource, /parsed\.searchParams\.set\("cabinetUrl", resolvedCabinetUrl\);/);
  assert.match(cabinetSource, /return appendCurrentAuthModeToNavigableUrl\(parsed\)\.toString\(\);/);
  assert.match(cabinetSource, /const openGroupTrainings = action\.label === "Групповые тренировки";/);
  assert.match(cabinetSource, /window\.location\.href = resolvedHref;/);
  assert.doesNotMatch(cabinetSource, /#9Rzqf/);
  assert.doesNotMatch(cabinetSource, /GROUP_TRAININGS_HASH/);
});
