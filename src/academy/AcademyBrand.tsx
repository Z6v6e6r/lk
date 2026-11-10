import rodinaMarkWhite from "./assets/rodina-mark-white.svg";

export function AcademyBrand() {
  return (
    <div className="academy-brand" aria-label="Родина · Академия">
      <img src={rodinaMarkWhite} alt="Герб Родины" width="44" height="58" />
      <div>
        <span className="academy-brand-name">Родина</span>
        <span className="academy-brand-caption">Академия футбола</span>
      </div>
    </div>
  );
}
