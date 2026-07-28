import LevelsInfoPage from "./LevelsInfoPage";
import { RatingBreakdownPage } from "./RatingBreakdownPage";
import type { LevelsInfoMountData } from "../../types/levelsInfoOverlay";

interface LevelsInfoOverlayPageProps {
  onBack: () => void;
  data?: LevelsInfoMountData;
}

export function LevelsInfoOverlayPage({
  onBack,
  data,
}: LevelsInfoOverlayPageProps) {
  if (data?.ratingBreakdown) {
    return (
      <RatingBreakdownPage
        onBack={onBack}
        payload={data.ratingBreakdown}
      />
    );
  }

  return (
    <LevelsInfoPage
      onBack={onBack}
      profile={data?.profile}
    />
  );
}
