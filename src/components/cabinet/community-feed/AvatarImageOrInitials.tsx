import { useEffect, useState } from "react";
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
  const [imageFailed, setImageFailed] = useState(false);
  const normalizedSrc = (src || "").trim();
  const shouldShowImage = Boolean(normalizedSrc) && !imageFailed;

  useEffect(() => {
    setImageFailed(false);
  }, [normalizedSrc]);

  if (shouldShowImage) {
    return (
      <img
        src={normalizedSrc}
        alt={name}
        className={imageClassName}
        onError={() => setImageFailed(true)}
      />
    );
  }

  return <span className={fallbackClassName}>{getInitials(name) || "?"}</span>;
}
