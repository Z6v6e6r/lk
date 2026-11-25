import react from "@vitejs/plugin-react";
import ts from "typescript";
import { defineConfig, type Plugin } from "vite";
import cssInjectedByJs from "vite-plugin-css-injected-by-js";

const replacements: Record<string, Record<string, string>> = {
  "GamesPage.tsx": {
    "details-action-row details-join-action-row": `<BookingOptions category="game" title="Запись на игру"
      amountMinor={minorFromRubles(detailsSplitShareAmount)} regularLabel="Разовое участие"
      regularDetail={isDetailsSplitPaymentGame ? \`Моя доля 1/\${detailsSplitShareCount} стоимости\` : undefined}
      {...gameBookingOptions(detailsSplitSubscriptionOptions, detailsJoinPricePreview.bySubscriptionId, detailsDurationMinutes)}
      loading={detailsSplitSubscriptionsLoading} />`,
    "game-payment-stack": `<BookingOptions category="game" title="Создание игры"
      amountMinor={minorFromRubles(basePaymentAmount, splitPaymentSelected ? splitShareCount : 1)}
      regularLabel={splitPaymentSelected ? "Разовое участие" : "Полная оплата корта"}
      regularDetail={splitPaymentSelected ? \`Моя доля 1/\${splitShareCount} стоимости\` : "Оплата всего корта без применения льгот"}
      terms={splitPaymentSelected ? undefined : "Стоимость оплачивается полностью за всех игроков. Льготы не расходуются."}
      {...(splitPaymentSelected ? gameBookingOptions(splitSubscriptionPaymentOptions, publicSplitPricePreview.bySubscriptionId, duration) : {})}
      loading={splitPaymentSelected && (splitSubscriptionsLoading || publicSplitPricePreview.state === "checking")}
      onRefresh={splitPaymentSelected && splitHasSubscriptionPaymentOptions && publicSplitPricePreview.state === "unavailable"
        ? publicSplitPricePreview.refresh : undefined} />`,
    "team-card game-create-payment-method-card": "<></>",
  },
  "GroupSchedulePage.tsx": {
    "tournament-signup-registration group-schedule-registration group-schedule-registration--trainer":
      '<BookingOptions category="training" key={selectedTraining.id} title={selectedTraining.title} amountMinor={null} {...eventBookingOptions(checkout?.oneTimes ?? [], currentDiscountQuotes)} loading={discountPending} />',
  },
  "TournamentSignupPage.tsx": {
    "tournament-signup-register-stack":
      '<BookingOptions category="tournament" key={selectedExerciseId} title={selectedTournament?.title ?? "Запись на турнир"} amountMinor={null} {...eventBookingOptions(checkout?.oneTimes ?? [], currentDiscountQuotes)} loading={discountPending} />',
  },
};

export function isolateBookingPilot(): Plugin {
  return {
    name: "lk1-pilot-booking-slots",
    enforce: "pre",
    transform(source, id) {
      const normalized = id.split("?")[0].replaceAll("\\", "/");
      if (!normalized.includes("/src/") || !/\.tsx?$/.test(normalized)
        || normalized.includes("/src/lk-pilot/")) return;
      const filename = normalized.split("/").at(-1)!;
      const slots = replacements[filename] ?? {};
      const detail = filename === "GroupSchedulePage.tsx"
        ? ["setSelectedId(training.id)", "training-join", "training"]
        : filename === "TournamentSignupPage.tsx"
          ? ["setSelectedId(tournament.id)", "tournament-join", "tournament"] : null;
      const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
      const edits: { start: number; end: number; text: string }[] = [];
      const seen = new Map<string, number>();

      function add(node: ts.Node, text: string) {
        edits.push({ start: node.getStart(sourceFile), end: node.end, text });
      }

      function visit(node: ts.Node) {
        if (detail && ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "onOpen"
          && node.initializer?.getText(sourceFile).includes(detail[0])) {
          seen.set("onOpen", (seen.get("onOpen") ?? 0) + 1);
          add(node, `onOpen={() => navigateWithinPilot(pilotHref("${detail[1]}", new URLSearchParams({ eventId: ${detail[2]}.id, date: ${detail[2]}.date })))}`);
          return;
        }
        if (ts.isJsxElement(node)) {
          const attr = node.openingElement.attributes.properties.find(
            (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === "className",
          );
          const name = attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isStringLiteral(attr.initializer)
            ? attr.initializer.text : null;
          if (name && Object.hasOwn(slots, name)) {
            seen.set(name, (seen.get(name) ?? 0) + 1);
            add(node, slots[name]);
            return;
          }
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && /^(?:(?:window|window\.top)\.)?location\.href$/.test(node.left.getText(sourceFile))) {
          add(node, `navigateWithinPilot(${node.right.getText(sourceFile)})`);
          return;
        }
        if (ts.isCallExpression(node) && /^(?:(?:window|window\.top)\.)?location\.(?:assign|replace)$/.test(node.expression.getText(sourceFile))) {
          const method = node.expression.getText(sourceFile);
          add(node, `navigateWithinPilot(${node.arguments[0]?.getText(sourceFile) ?? "undefined"}, ${method.endsWith(".replace")})`);
          return;
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
      for (const name of [...Object.keys(slots), ...(detail ? ["onOpen"] : [])]) {
        if (seen.get(name) !== 1) throw new Error(`LK pilot checkout slot changed: ${filename} (${name})`);
      }
      if (!edits.length) return;

      const apply = edits.sort((a, b) => b.start - a.start).reduce(
        (text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source,
      );
      const prelude = [
        'import { navigateWithinPilot, pilotHref } from "/src/lk-pilot/routes.ts";',
        ...seen.size ? ['import { BookingOptions } from "/src/lk-pilot/BookingOptions.tsx";\nimport { minorFromRubles, gameBookingOptions, eventBookingOptions } from "/src/lk-pilot/bookingOptionPresentation.ts";'] : [],
      ].join("\n");
      return prelude + "\n" + apply;
    },
  };
}

export default defineConfig({
  plugins: [isolateBookingPilot(), react(), cssInjectedByJs()],
  resolve: { dedupe: ["react", "react-dom"] },
  publicDir: false,
  define: {
    "process.env": {},
    "process.env.NODE_ENV": JSON.stringify("production"),
    // Shared controls import the published exhibition identifiers even when no exhibition is mounted.
    __PADLHUB_EXHIBITION_WIDGET_URL__: JSON.stringify(""),
    __PADLHUB_JUMP_WIDGET_URL__: JSON.stringify(""),
  },
  build: {
    cssCodeSplit: false,
    lib: { entry: "src/lk-pilot/main.tsx", name: "LKBookingPilot", formats: ["iife"], fileName: () => "booking.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
