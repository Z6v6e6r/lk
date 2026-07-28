import type { PadelGameRecord } from "../utils/apiClient";

export type GamesCreateFromBookingData = {
  bookingId: string;
  slotId?: string | null;
  exerciseId?: string | null;
  typeId?: number | null;
  typeName?: string | null;
  directionId?: number | null;
  studioId?: string | null;
  studioName?: string | null;
  roomId?: string | null;
  roomName?: string | null;
  date?: string | null;
  timeFrom?: string | null;
  timeTo?: string | null;
  durationMinutes?: number | null;
  amount?: number | null;
  paid?: boolean | null;
  paymentUrl?: string | null;
  directionName?: string | null;
};

export type OpenGamesOptions = {
  gameId?: string | null;
  joinGameId?: string | null;
  openChat?: boolean;
  createFromBooking?: GamesCreateFromBookingData | null;
  initialGameRecord?: PadelGameRecord | null;
  cabinetUrl?: string | null;
};

export type GamesMountData = {
  openGameId?: string | null;
  openChat?: boolean;
  createFromBooking?: GamesCreateFromBookingData | null;
  initialGameRecord?: PadelGameRecord | null;
  publicCreateEntry?: boolean;
  compositeCreateEntry?: boolean;
  publicFindEntry?: boolean;
  includeGamePlusTrainer?: boolean;
  joinGameId?: string | null;
  presetStudioId?: string | null;
  presetStudioName?: string | null;
  cabinetUrl?: string | null;
};
