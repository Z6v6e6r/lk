import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  GROUP_SCHEDULE_DIRECTION_PRESETS,
  GROUP_SCHEDULE_KIDS_ACADEMY_DIRECTION_IDS,
  parseGroupScheduleDirectionIds,
  resolveGroupScheduleDirectionPreset,
} from "../../src/utils/groupScheduleModel.ts";

const groupSchedulePageSource = fs.readFileSync("src/components/group-schedule/GroupSchedulePage.tsx", "utf8");
const groupScheduleEntrySource = fs.readFileSync("src/group-schedule.tsx", "utf8");

test("resolves the kids academy direction preset", () => {
  assert.deepEqual(GROUP_SCHEDULE_KIDS_ACADEMY_DIRECTION_IDS, [2468, 2975, 3163]);
  assert.equal(resolveGroupScheduleDirectionPreset("kids")?.label, "Детская академия падел");
  assert.equal(resolveGroupScheduleDirectionPreset(" KIDS ")?.label, "Детская академия падел");
  assert.equal(resolveGroupScheduleDirectionPreset("unknown"), null);
  assert.equal(resolveGroupScheduleDirectionPreset(null), null);
  assert.equal(resolveGroupScheduleDirectionPreset(""), null);
  assert.ok(GROUP_SCHEDULE_DIRECTION_PRESETS.kids.directionIds.length > 0);
});

test("parses direction id lists and drops invalid tokens", () => {
  assert.deepEqual(parseGroupScheduleDirectionIds(["2468", "2975", "3163", "2468"]), [2468, 2975, 3163]);
  assert.deepEqual(parseGroupScheduleDirectionIds(["kids", "", "0", "-5", "2.5", "abc"]), []);
});

test("group schedule page applies direction filter from link and keeps it clearable", () => {
  assert.match(groupSchedulePageSource, /initialDirectionIds\?: number\[\] \| null;/);
  assert.match(groupSchedulePageSource, /initialDirectionLabel\?: string \| null;/);
  assert.match(groupSchedulePageSource, /const \[linkDirectionIds, setLinkDirectionIds\] = useState<number\[\]>\(\(\) => normalizeDirectionIds\(initialDirectionIds\)\);/);
  assert.match(groupSchedulePageSource, /const \[linkDirectionLabel, setLinkDirectionLabel\] = useState<string \| null>\(initialDirectionLabel \|\| null\);/);
  assert.match(groupSchedulePageSource, /const isLinkDirectionFilterActive = linkDirectionIdSet\.size > 0;/);
  assert.match(groupSchedulePageSource, /!isLinkDirectionFilterActive \|\| \(item\.directionId != null && linkDirectionIdSet\.has\(item\.directionId\)\)/);
  assert.match(groupSchedulePageSource, /const typeFilterLabel = isLinkDirectionFilterActive/);
  assert.match(groupSchedulePageSource, /const resetLinkDirectionFilter = useCallback\(\(\) => \{/);
  assert.match(groupSchedulePageSource, /onClick=\{\(\) => \{\s*resetLinkDirectionFilter\(\);/);
  assert.match(groupSchedulePageSource, /\{isLinkDirectionFilterActive && \(/);
});

test("group schedule entry passes direction filter from url and mount data", () => {
  assert.match(groupScheduleEntrySource, /directionIds\?: number\[\] \| null;/);
  assert.match(groupScheduleEntrySource, /directionLabel\?: string \| null;/);
  assert.match(groupScheduleEntrySource, /initialDirectionIds=\{data\?\.directionIds \?\? locationData\.directionIds \?\? null\}/);
  assert.match(groupScheduleEntrySource, /initialDirectionLabel=\{data\?\.directionLabel \?\? locationData\.directionLabel \?\? null\}/);
});
