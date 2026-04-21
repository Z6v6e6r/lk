import type { HTMLAttributes, ReactNode } from "react";

interface CommunityFeedCardBaseProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  variant: "game" | "tournament" | "news" | "system";
  className?: string;
}

export function CommunityFeedCardBase({
  children,
  variant,
  className,
  ...rest
}: CommunityFeedCardBaseProps) {
  return (
    <article
      className={`community-feed-card community-feed-card--${variant}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </article>
  );
}
