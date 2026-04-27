import { useEffect, useState } from "react";
import { getInitials } from "./feedFormatters";

type AvatarImageOrInitialsProps = {
  src?: string;
  name: string;
  imageClassName: string;
};

export function AvatarImageOrInitials({ src, name, imageClassName }: AvatarImageOrInitialsProps) {
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

  return <span>{getInitials(name) || "?"}</span>;
}
