import { useState, type ImgHTMLAttributes } from "react";
import { avatarFallbackUrl } from "./avatarFallback";

type AvatarImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "srcSet" | "onError"> & {
  src?: string | null;
  name?: string | null;
  initials?: string;
};

/** Keep the existing image geometry, including selectors on `img` in overlays. */
export function AvatarImage({ src, ...props }: AvatarImageProps) {
  const normalizedSrc = src?.trim() || "";
  return <AvatarImageSource key={normalizedSrc} {...props} src={normalizedSrc} />;
}

function AvatarImageSource({ src, name, initials, alt = "", ...props }: AvatarImageProps) {
  const [failed, setFailed] = useState(false);
  const fallback = !src || failed;
  return (
    <img
      {...props}
      src={fallback ? avatarFallbackUrl(name ?? alt, initials) : src}
      alt={alt}
      onError={fallback ? undefined : () => setFailed(true)}
    />
  );
}
