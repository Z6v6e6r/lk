import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const atlasSource = fs.readFileSync("src/components/games/FindGamePage.tsx", "utf8");
const detailSource = fs.readFileSync("src/components/games/GameJoinPage.tsx", "utf8");
const styles = fs.readFileSync("src/MyApp.css", "utf8");

test("Game Atlas keeps one real paginated games source", () => {
  assert.match(atlasSource, /const PAGE_SIZE = 500;/);
  assert.match(atlasSource, /apiFetchPadelAvailableGames\(\{/);
  assert.match(atlasSource, /limit:\s*PAGE_SIZE/);
  assert.match(atlasSource, /offset:\s*nextOffset/);
  assert.match(atlasSource, /response\.data\?\.hasMore/);
  assert.doesNotMatch(atlasSource, /apiFetchTournamentVivaPublicCheckout/);
});

test("Game Atlas exposes required categories, search and supported filters", () => {
  for (const label of ["Все", "Открытые", "Мои", "Ближайшие"]) {
    assert.match(atlasSource, new RegExp(`label: "${label}"`));
  }
  for (const key of [
    "atlasSearch",
    "atlasDate",
    "atlasStation",
    "atlasLevel",
    "atlasKind",
    "atlasTime",
    "atlasStatus",
    "atlasPlaces",
    "atlasFormat",
    "atlasAudience",
  ]) {
    assert.match(atlasSource, new RegExp(`"${key}"`));
  }
  assert.match(atlasSource, /placeholder="Название, станция, организатор"/);
  assert.match(atlasSource, /Сбросить все фильтры/);
});

test("Game Atlas distinguishes loading, error, empty and no-result states", () => {
  assert.match(atlasSource, /Загружаем игры/);
  assert.match(atlasSource, /Не удалось загрузить игры/);
  assert.match(atlasSource, /Повторить/);
  assert.match(atlasSource, /По запросу ничего не найдено/);
  assert.match(atlasSource, /Игр пока нет/);
});

test("Atlas detail navigation restores same-origin browser history without forwarding the Atlas URL", () => {
  assert.match(atlasSource, /searchParams\.set\("atlasReturn", "1"\)/);
  assert.match(detailSource, /referrer\.origin === window\.location\.origin/);
  assert.match(detailSource, /window\.history\.back\(\)/);
  assert.match(detailSource, /Назад к играм/);
});

test("Game Atlas has explicit mobile and desktop layout guards", () => {
  assert.match(styles, /@media \(max-width: 390px\)[\s\S]*\.find-game-action/);
  assert.match(styles, /@media \(min-width: 768px\)[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.find-game-container\s*\{[\s\S]*overflow-x: hidden/);
});

test("Game Atlas groups advanced filters behind the same toggle on mobile and desktop", () => {
  assert.match(atlasSource, /aria-controls="game-atlas-filters"/);
  assert.match(atlasSource, /find-game-filter-toggle-icon/);
  assert.match(styles, /\.find-game-filterbar\s*\{[\s\S]*display: none/);
  assert.match(styles, /\.find-game-filterbar\.is-open\s*\{\s*display: grid/);
  assert.doesNotMatch(
    styles,
    /@media \(min-width: 768px\)[\s\S]*\.find-game-filter-toggle\s*\{\s*display: none/,
  );
});

test("Game Atlas supports multiple selected values in every advanced filter group", () => {
  assert.match(atlasSource, /function readAtlasMultiValues/);
  assert.match(atlasSource, /toggleAtlasMultiValue/);
  assert.match(atlasSource, /serializeAtlasMultiValues/);
  for (const stateName of [
    "stationFilterValues",
    "levelFilterValues",
    "kindFilters",
    "statusFilterValues",
    "availabilityFilters",
    "formatFilters",
    "audienceFilters",
    "timeOfDayFilters",
  ]) {
    assert.match(atlasSource, new RegExp(`selectedValues=\\{${stateName}\\}`));
  }
  assert.match(atlasSource, /aria-pressed=\{isActive\}/);
  assert.match(styles, /\.find-game-filter-options\s*\{[\s\S]*flex-wrap: wrap/);
  assert.match(styles, /\.find-game-filter-option\.active/);
});
