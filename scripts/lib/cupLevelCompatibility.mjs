/** Normalize legacy community snapshots without inventing an initial level. */
export function removeImplicitCommunityLevel(source) {
  return source
    .replace(/const normalized = Number\.isFinite\(score\) \? score : 3\.2;/g,
      'if (!Number.isFinite(score) || score < 1 || score > 7) return null; const normalized = score;')
    .replace(/normalized >= 5\.75/g, 'normalized >= 5.5').replace(/normalized >= 5\.25/g, 'normalized >= 4.7')
    .replace(/normalized >= 4\.75/g, 'normalized >= 4').replace(/normalized >= 4\.25/g, 'normalized >= 3.5')
    .replace(/normalized >= 3\.75/g, 'normalized >= 3').replace(/normalized >= 3\.25/g, 'normalized >= 2')
    .replace(/(const levelScore = toNum\(member\.levelScore \?\? member\.ratingNumeric \?\? member\.levelNumeric\) \?\?) 3\.2;/g, '$1 null;')
    .replace(/levelScore: 3\.2,/g, 'levelScore: null,').replace(/levelLabel: buildLevelLabel\(3\.2\),/g, 'levelLabel: null,')
    .replace(/(levelScore:.*\? Number\([^\n]+\) :) 3\.2,/g, '$1 null,')
    .replace(/(levelLabel: (?:ctx\.member\?|communityMember)\.levelLabel \|\|) 'C'/g, '$1 null');
}
