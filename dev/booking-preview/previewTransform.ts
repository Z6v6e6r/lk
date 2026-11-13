import ts from 'typescript';

export function transformPreviewNavigation(source: string, filename: string) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const locations = ['location', 'window.location', 'window.top.location'];
  function visit(node: ts.Node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && locations.some(location => node.left.getText(file) === location + '.href')) {
      replacements.push({ start: node.getStart(file), end: node.end, text: `navigatePreview(${node.right.getText(file)})` });
      return;
    }
    if (ts.isCallExpression(node) && (node.expression.getText(file) === 'window.open'
      || locations.some(location => ['assign', 'replace'].some(method => node.expression.getText(file) === `${location}.${method}`)))) {
      replacements.push({ start: node.getStart(file), end: node.end, text: `navigatePreview(${node.arguments[0]?.getText(file) || 'undefined'})` });
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!replacements.length) return source;
  let result = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  return 'import { navigatePreview } from "/dev/booking-preview/previewNavigation.ts";\n' + result;
}

const rules: Record<string, Array<{ className: string; replacement: string }>> = {
  'GamesPage.tsx': [
    { className: 'details-action-row details-join-action-row', replacement: '<MatrixPaymentOptions service="game" eventKey={activeGameRecord?.id || "demo-game"} durationMinutes={activeGameRecord?.booking?.durationMinutes ?? 90} gamePaymentScope="quarter" courtAmount={activeGameRecord?.payment?.amount ?? null} eventDetails={{ date: detailsDateLabel, time: [detailsTimeFrom, detailsTimeTo].filter(Boolean).join("–"), station: detailsStudioName, location: [detailsStudioName, detailsRoomName].filter(Boolean).join(" · ") }} />' },
    { className: 'game-payment-stack', replacement: '<MatrixPaymentOptions key={paymentMode} service="game" eventKey="demo-game-create" gamePaymentScope={paymentMode === "split" ? "quarter" : "court"} courtAmount={basePaymentAmount} durationMinutes={duration} eventDetails={{ date: dateLabel, time: publicCreateSummaryTimeLabel, station: studio?.name, location: [studio?.name, studio?.address, selectedCourt?.name].filter(Boolean).join(" · ") }} disabled={!canProceedToPayment} />' },
    { className: 'team-card game-create-payment-card', replacement: '<GamePayerChoice value={paymentMode} onChange={(next) => { setPaymentMode(next); if (next === "self") setIsPrivate(false); }} courtAmount={basePaymentAmount} durationMinutes={duration} />' },
    { className: 'team-card game-create-payment-method-card', replacement: '<></>' },
  ],
  'GroupSchedulePage.tsx': [
    { className: 'tournament-signup-registration group-schedule-registration group-schedule-registration--trainer', replacement: '<MatrixPaymentOptions key={selectedTraining.id} service="training" eventKey={selectedTraining.id} excludesPrivileges={selectedTraining.raw.previewPrivilegesExcluded === true} durationMinutes={(Date.parse(selectedTraining.timeTo) - Date.parse(selectedTraining.timeFrom)) / 60000} eventDetails={{ date: selectedTraining.date, time: selectedTraining.timeLabel, station: selectedTraining.studioName, location: [selectedTraining.studioName, selectedTraining.studioAddress, selectedTraining.roomName].filter(Boolean).join(" · ") }} />' },
  ],
  'TournamentSignupPage.tsx': [
    { className: 'tournament-signup-register-stack', replacement: '<MatrixPaymentOptions key={selectedExerciseId} service="tournament" eventKey={selectedExerciseId || "demo-tournament"} durationMinutes={selectedTournament?.startsAt && selectedTournament?.endsAt ? (Date.parse(selectedTournament.endsAt) - Date.parse(selectedTournament.startsAt)) / 60000 : 180} eventDetails={{ date: selectedTournament?.date, time: detailTimeLabel, station: detailStationLabel, location: [detailStationLabel, selectedTournament?.address].filter(Boolean).join(" · ") }} />' },
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
