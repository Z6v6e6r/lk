import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  CUSTOM_FIELD_IDS,
  hasTournamentHostingAccess,
} from "../../src/utils/customFields.ts";
import type { CustomField, UserProfileType } from "../../src/utils/apiClient.ts";

function makeProfile(tournamentField: CustomField): UserProfileType {
  return {
    id: "profile-1",
    email: null,
    firstName: "Тест",
    lastName: "Пользователь",
    middleName: "",
    sex: "",
    photo: null,
    phone: "79990000000",
    birthDate: null,
    deposit: 0,
    trialUsed: false,
    withCard: false,
    loyaltyCard: "",
    clientCategory: { id: 1, name: "Клиент" },
    customFields: [tournamentField],
  };
}

test("uses the configured Viva tournament access field", () => {
  assert.equal(
    CUSTOM_FIELD_IDS.tournamentsAccess,
    "e17a32f3-65f7-47c5-bda1-33d79932c884",
  );
});

test("grants tournament hosting access for the literal Viva field value", () => {
  const profile = makeProfile({
    id: CUSTOM_FIELD_IDS.tournamentsAccess,
    name: "Турниры",
    value: ["проводит турниры"],
  });

  assert.equal(hasTournamentHostingAccess(profile), true);
});

test("grants tournament hosting access when Viva stores the selected option id", () => {
  const profile = makeProfile({
    id: CUSTOM_FIELD_IDS.tournamentsAccess,
    name: "Турниры",
    value: ["host-option-id"],
    attributes: {
      options: [
        { id: "host-option-id", name: "Проводит турниры" },
        { id: "player-option-id", name: "Участвует в турнирах" },
      ],
    },
  });

  assert.equal(hasTournamentHostingAccess(profile), true);
});

test("denies tournament hosting access for a non-host Viva option", () => {
  const profile = makeProfile({
    id: CUSTOM_FIELD_IDS.tournamentsAccess,
    name: "Турниры",
    value: ["player-option-id"],
    attributes: {
      options: [
        { id: "host-option-id", name: "Проводит турниры" },
        { id: "player-option-id", name: "Участвует в турнирах" },
      ],
    },
  });

  assert.equal(hasTournamentHostingAccess(profile), false);
});

test("cabinet tournament block depends only on the profile hosting field", () => {
  const cabinetSource = fs.readFileSync(
    "src/components/cabinet/Cabinet.tsx",
    "utf8",
  );

  assert.match(
    cabinetSource,
    /const canHostTournaments = hasTournamentHostingAccess\(profile\);/,
  );
  assert.match(
    cabinetSource,
    /const canOpenTournamentsBlock = canHostTournaments;/,
  );
  assert.doesNotMatch(cabinetSource, /hasAssignedTournamentAccess/);
  assert.doesNotMatch(cabinetSource, /runTournamentAccessScan/);
  assert.doesNotMatch(cabinetSource, /TOURNAMENT_LOOK(?:BACK|AHEAD)_DAYS/);
  assert.doesNotMatch(cabinetSource, /apiFetchTournamentMechanicsSourceList/);
});
