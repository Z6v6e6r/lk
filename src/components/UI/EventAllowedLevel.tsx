import { getEventAllowedLevelLabel } from "../../utils/levelAdmission";

export function EventAllowedLevel({ event }: { event: unknown }) {
  const label = getEventAllowedLevelLabel(event);
  return label ? <div className="details-time">Допустимый уровень: <strong>{label}</strong></div> : null;
}
