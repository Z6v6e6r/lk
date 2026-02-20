import { useEffect, useState } from "react";
import { apiGetAdvertisement } from "../../utils/apiClient";
import type { AdvertisementType } from "../../utils/apiClient";

export function Advertisement() {
  const [advertisement, setAdvertisement] = useState<AdvertisementType | null>(null);

  useEffect(() => {
    apiGetAdvertisement().then((res) => {
      if (res.data) setAdvertisement(res.data);
    });
  }, []);

  if (!advertisement) return null;

  return (
    <div className="adv-section">
      <a href={advertisement.href} target="_blank" rel="noopener noreferrer">
        <img src={advertisement.imgUrl} alt="Реклама" className="adv-img" />
      </a>
    </div>
  );
}
