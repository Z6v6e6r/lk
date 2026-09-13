import { AvatarImage } from "../../UI/AvatarImage";
import { getInitials } from "./feedFormatters";

type AvatarImageOrInitialsProps = {
  src?: string;
  name: string;
  imageClassName: string;
  fallbackClassName?: string;
};

export function AvatarImageOrInitials({
  src,
  name,
  imageClassName,
  fallbackClassName,
}: AvatarImageOrInitialsProps) {
  const normalizedSrc = (src || "").trim();
  const shouldShowImage = Boolean(normalizedSrc);

  if (shouldShowImage) {
    return (
      <AvatarImage
        src={normalizedSrc}
        alt={name}
        className={imageClassName}
      />
    );
  }

  return <span className={fallbackClassName}>{getInitials(name) || "?"}</span>;
}
