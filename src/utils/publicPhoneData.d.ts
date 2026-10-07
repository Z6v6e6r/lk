export type PublicPhoneProjectionOptions = {
  scope?: string;
  kind?: "generic" | "chat" | "rating" | "tournament" | "game";
  viewer?: { id?: string | null; phone?: string | null } | null;
};
export function createPublicPhoneData(aliasForPhone: (phone: string, scope: string) => string): {
  project<T>(value: T, options?: PublicPhoneProjectionOptions): T;
  restore<T>(command: T, stored: unknown, scope: string): T;
  phoneIdentity(value: unknown): string | null;
  ownIdentity(value: unknown, viewer: PublicPhoneProjectionOptions["viewer"]): boolean;
};
