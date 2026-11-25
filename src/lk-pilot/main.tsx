import { createRoot } from "react-dom/client";
import { PilotSession, usePilotComparisonScope } from "./PilotSession";
import { BookingOptions, comparisonCategories, readComparisonQuote } from "./BookingOptions";
import { AppErrorBoundary } from "../components/UI/AppErrorBoundary";
import { OverlayScopeProvider } from "../context/OverlayScopeContext";
import GamesPage from "../components/games/GamesPage";
import FindGamePage from "../components/games/FindGamePage";
import GroupSchedulePage from "../components/group-schedule/GroupSchedulePage";
import TournamentSignupPage from "../components/tournament-signup/TournamentSignupPage";
import { navigateWithinPilot, pilotHref, pilotScreens, readPilotScreen, resolvePilotNavigation, type PilotScreen } from "./routes";
import "../index.css";
import "../MyApp.css";
import "./matrix.css";
import "./lk2-skin.css";
import "./shell.css";

const root = document.getElementById("root");
if (!root || !Object.hasOwn(window, "__LK_PILOT_ASSET_BASE__")) throw new Error("LK pilot bootstrap is required");

const { screen, date, eventId } = readPilotScreen(new URLSearchParams(location.search));
const go = (next: PilotScreen) => navigateWithinPilot(pilotHref(next));
const listForDetail = {
  "game-join": "game-list",
  "training-join": "training-booking",
  "tournament-join": "tournament-booking",
} as const;

function BookingScreen() {
  const scope = usePilotComparisonScope();
  if (screen in listForDetail && !eventId) {
    const list = listForDetail[screen as keyof typeof listForDetail];
    return <section className="matrix-payment"><p>Выберите событие, чтобы открыть его карточку.</p><a href={pilotHref(list)}>{pilotScreens[list]}</a></section>;
  }
  switch (screen) {
    case "game-booking":
      return <GamesPage publicCreateEntry onBack={() => go("game-list")} />;
    case "game-join":
      return <GamesPage openGameId={eventId} onBack={() => go("game-list")} />;
    case "game-list":
      return <FindGamePage onBack={() => go("matrix")} cabinetUrl={pilotHref("game-list")} includeGamePlusTrainer />;
    case "training-booking":
    case "training-join":
      return <GroupSchedulePage initialDate={date} initialExerciseId={eventId} onBack={() => go("training-booking")} />;
    case "tournament-booking":
    case "tournament-join":
      return <TournamentSignupPage initialDate={date} initialTournamentId={eventId} onBack={() => go("tournament-booking")} />;
    case "matrix": {
      const screens = ["game-list", "training-booking", "tournament-booking"] as const;
      return <div className="matrix-comparison"><h1>Способы записи</h1><div>
        {comparisonCategories.map((category, index) => {
          const quote = readComparisonQuote(category, scope);
          return quote
            ? <BookingOptions key={category} title={quote.title} amountMinor={quote.amountMinor} options={quote.options}
              regularLabel={quote.regularLabel} regularDetail={quote.regularDetail}
              terms={quote.terms} explanations={quote.explanations} />
            : <section className="matrix-payment" key={category}>
              <h2>{pilotScreens[screens[index]]}</h2>
              <p>Выберите событие, чтобы получить подтверждённую цену.</p>
              <a href={pilotHref(screens[index])}>Выбрать событие</a>
            </section>;
        })}
      </div></div>;
    }
  }
}

document.documentElement.dataset.previewSkin = "lk2";
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!link || link.getAttribute("href")?.startsWith("#")
    || (link.hasAttribute("data-pilot-exit") && link.href === "https://padlhub.ru/lk_new")) return;
  const href = resolvePilotNavigation(link.href, location.href);
  if (href) link.setAttribute("href", href);
  else {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

createRoot(root).render(
  <AppErrorBoundary module="main"><OverlayScopeProvider value={false}>
    <PilotSession>
      <div className="lk-pilot">
        <header className="lk-pilot-head">
          <p>Тестовый ЛК · запись и оплата отключены</p>
          <a data-pilot-exit href="https://padlhub.ru/lk_new" target="_blank" rel="noopener noreferrer">Обычный ЛК</a>
          <nav aria-label="Окна тестового ЛК">
            {Object.entries(pilotScreens).map(([key, label]) => (
              <a key={key} href={pilotHref(key as PilotScreen)} aria-current={key === screen ? "page" : undefined}>{label}</a>
            ))}
          </nav>
        </header>
        <BookingScreen key={screen + (eventId ?? "")} />
      </div>
    </PilotSession>
  </OverlayScopeProvider></AppErrorBoundary>,
);
