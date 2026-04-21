interface CommunityVerifiedBadgeProps {
  size?: "sm" | "md" | "lg";
  className?: string;
  label?: string;
  decorative?: boolean;
}

export function CommunityVerifiedBadge({
  size = "md",
  className = "",
  label = "Верифицированное сообщество",
  decorative = false,
}: CommunityVerifiedBadgeProps) {
  const normalizedClassName = [
    "community-verified-badge",
    `community-verified-badge--${size}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={normalizedClassName}
      {...(decorative ? { "aria-hidden": "true" as const } : { role: "img", "aria-label": label })}
    >
      <svg viewBox="0 0 20 20" className="community-verified-badge-icon" aria-hidden="true" focusable="false">
        <path
          d="M8.15 13.52 5.1 10.46l-1.37 1.38 4.42 4.43L16.3 8.1l-1.37-1.37-6.78 6.79Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}
