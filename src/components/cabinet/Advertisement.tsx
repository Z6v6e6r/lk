import { useEffect, useState } from "react";
import {
  apiGetCabinetHomeAdvertisingSettings,
  type CabinetHomeAdvertisingItem,
  type CabinetHomeAdvertisingSettings,
  type UserProfileType,
} from "../../utils/apiClient";

const ADVERTISEMENT_ROTATION_STORAGE_KEY_PREFIX = "padlhub.cabinet.advertisement.lastShown.v1";

type AdvertisementProps = {
  profile: UserProfileType;
};

function getAdvertisementStorageKey(profile: UserProfileType): string {
  const profileKey = String(profile.id || profile.phone || "anonymous").trim() || "anonymous";
  return `${ADVERTISEMENT_ROTATION_STORAGE_KEY_PREFIX}:${profileKey}`;
}

function readLastShownAdvertisementId(storageKey: string): string | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeLastShownAdvertisementId(storageKey: string, advertisementId: string): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(storageKey, advertisementId);
  } catch {
    // ignore localStorage write errors
  }
}

function pickAdvertisementForProfile(
  settings: CabinetHomeAdvertisingSettings | null,
  profile: UserProfileType,
): CabinetHomeAdvertisingItem | null {
  const ads = settings?.ads.filter((item) => Boolean(item.href) && Boolean(item.imgUrl)) ?? [];
  if (!ads.length) return null;

  if (settings?.rotationEnabled !== true || ads.length === 1) {
    return ads[0] ?? null;
  }

  const storageKey = getAdvertisementStorageKey(profile);
  const lastShownId = readLastShownAdvertisementId(storageKey);
  const currentIndex = lastShownId ? ads.findIndex((item) => item.id === lastShownId) : -1;
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % ads.length : 0;
  const nextAd = ads[nextIndex] ?? ads[0] ?? null;

  if (nextAd) {
    writeLastShownAdvertisementId(storageKey, nextAd.id);
  }

  return nextAd;
}

function shouldOpenInNewTab(href: string): boolean {
  const normalizedHref = String(href || "").trim();
  if (!/^https?:\/\//i.test(normalizedHref)) {
    return false;
  }

  if (typeof window === "undefined") {
    return true;
  }

  try {
    return new URL(normalizedHref, window.location.origin).origin !== window.location.origin;
  } catch {
    return true;
  }
}

export function Advertisement({ profile }: AdvertisementProps) {
  const [advertisement, setAdvertisement] = useState<CabinetHomeAdvertisingItem | null>(null);

  useEffect(() => {
    let cancelled = false;

    apiGetCabinetHomeAdvertisingSettings()
      .then((response) => {
        if (cancelled) return;
        setAdvertisement(pickAdvertisementForProfile(response.data, profile));
      })
      .catch(() => {
        if (cancelled) return;
        setAdvertisement(null);
      });

    return () => {
      cancelled = true;
    };
  }, [profile.id, profile.phone]);

  if (!advertisement) return null;

  const openInNewTab = shouldOpenInNewTab(advertisement.href);

  return (
    <div className="section section--ads">
      <div className="section-header">
        <span className="section-title">Спецпредложение</span>
      </div>
      <div className="adv-section">
        <a
          href={advertisement.href}
          target={openInNewTab ? "_blank" : undefined}
          rel={openInNewTab ? "noopener noreferrer" : undefined}
        >
          <img src={advertisement.imgUrl} alt={advertisement.title || "Спецпредложение"} className="adv-img" />
        </a>
      </div>
    </div>
  );
}
