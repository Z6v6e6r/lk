import type { ReactNode } from "react";

interface FeedCardWrapperProps {
  children: ReactNode;
  variant?: "game" | "tournament" | "news" | "system";
}

export function FeedCardWrapper({ children, variant = "news" }: FeedCardWrapperProps) {
  return (
    <article className={`community-feed-card community-feed-card--${variant}`}>
      {children}
    </article>
  );
}
