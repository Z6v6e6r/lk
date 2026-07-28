import summerSubscriptionSportImage from "../../assets/summer-subscription-sport.webp";
import summerSubscriptionRaImage from "../../assets/summer-subscription-ra.webp";
import summerSubscriptionAcademyImage from "../../assets/summer-subscription-academy.webp";
import summerSubscriptionFriendshipImage from "../../assets/summer-subscription-friendship.webp";

const SUMMER_SUBSCRIPTION_GALLERY_ITEMS = [
  {
    alt: "Абонемент Лето.Падел.Спорт за 19 800 ₽",
    src: summerSubscriptionSportImage,
  },
  {
    alt: "Абонемент Лето.Падел.РА за 23 800 ₽",
    src: summerSubscriptionRaImage,
  },
  {
    alt: "Абонемент Лето.Падел.Академия за 23 800 ₽",
    src: summerSubscriptionAcademyImage,
  },
  {
    alt: "Абонемент Лето.Падел.Дружба за 9 800 ₽",
    src: summerSubscriptionFriendshipImage,
  },
] as const;

export function SummerSubscriptionGallery() {
  return (
    <div className="summer-subscription-gallery" aria-label="Варианты летних подписок">
      {SUMMER_SUBSCRIPTION_GALLERY_ITEMS.map((item) => (
        <img
          key={item.alt}
          src={item.src}
          alt={item.alt}
          className="summer-subscription-gallery__image"
          loading="lazy"
          decoding="async"
        />
      ))}
    </div>
  );
}
