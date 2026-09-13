type BookingGameCreationState = {
  gamesLoaded: boolean;
  loading: boolean;
  error: string | null;
  exactLinkState: "loading" | "error" | "none" | "unique" | "ambiguous" | undefined;
  hasLinkedGame: boolean;
};

/** An empty or partial list is not proof that a rental has no published game. */
export function canCreateGameAfterLookup(state: BookingGameCreationState): boolean {
  return state.gamesLoaded
    && !state.loading
    && !state.error
    && state.exactLinkState === "none"
    && !state.hasLinkedGame;
}
