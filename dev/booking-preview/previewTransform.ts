import ts from 'typescript';

const rules: Record<string, Array<{ className: string; replacement: string }>> = {
  'GamesPage.tsx': [
    { className: 'details-action-row details-join-action-row', replacement: '<MatrixPaymentOptions service="game" eventKey={activeGameRecord?.id || "demo-game"} durationMinutes={activeGameRecord?.booking?.durationMinutes ?? 90} gamePaymentScope="quarter" courtAmount={activeGameRecord?.payment?.amount ?? null} />' },
    { className: 'game-payment-stack', replacement: '<MatrixPaymentOptions key={paymentMode} service="game" eventKey="demo-game-create" gamePaymentScope={paymentMode === "split" ? "quarter" : "court"} courtAmount={basePaymentAmount} durationMinutes={duration} disabled={!canProceedToPayment} />' },
    { className: 'team-card game-create-payment-card', replacement: '<GamePayerChoice value={paymentMode} onChange={(next) => { setPaymentMode(next); if (next === "self") setIsPrivate(false); }} courtAmount={basePaymentAmount} durationMinutes={duration} />' },
    { className: 'team-card game-create-payment-method-card', replacement: '<></>' },
  ],
  'GroupSchedulePage.tsx': [
    { className: 'tournament-signup-registration group-schedule-registration group-schedule-registration--trainer', replacement: '<MatrixPaymentOptions key={selectedTraining.id} service="training" eventKey={selectedTraining.id} excludesPrivileges={selectedTraining.raw.previewPrivilegesExcluded === true} durationMinutes={(Date.parse(selectedTraining.timeTo) - Date.parse(selectedTraining.timeFrom)) / 60000} />' },
  ],
  'TournamentSignupPage.tsx': [
    { className: 'tournament-signup-register-stack', replacement: '<MatrixPaymentOptions key={selectedExerciseId} service="tournament" eventKey={selectedExerciseId || "demo-tournament"} durationMinutes={selectedTournament?.startsAt && selectedTournament?.endsAt ? (Date.parse(selectedTournament.endsAt) - Date.parse(selectedTournament.startsAt)) / 60000 : 180} />' },
  ],
};

// Replace only checkout regions in the isolated preview build. Keep original
// source files, event details, lists, and the game creation wizard intact.
// Parse JSX instead of matching nested elements with regular expressions.
export function transformPreviewPayments(source: string, filename: string) {
  const selectedRules = rules[filename];
  if (!selectedRules) return null;
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const counts = selectedRules.map(() => 0);
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node)) {
      const classAttribute = node.openingElement.attributes.properties.find(attribute =>
        ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'className');
      if (classAttribute && ts.isJsxAttribute(classAttribute) && classAttribute.initializer && ts.isStringLiteral(classAttribute.initializer)) {
        const value = classAttribute.initializer.text;
        const index = selectedRules.findIndex(rule => rule.className === value);
        if (index >= 0) {
          counts[index] += 1;
          replacements.push({ start: node.getStart(file), end: node.end, text: selectedRules[index].replacement });
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (counts.some(count => count !== 1)) throw new Error(`Booking preview checkout regions changed in ${filename}: ${counts.join(',')}`);
  let result = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return 'import { GamePayerChoice } from "/dev/booking-preview/GamePayerChoice.tsx";\nimport { MatrixPaymentOptions } from "/dev/booking-preview/MatrixPaymentOptions.tsx";\n' + result;
}
