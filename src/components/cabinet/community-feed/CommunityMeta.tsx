import { Fragment } from "react";
import { LocationPinIcon } from "./CommunityIcons";

interface CommunityMetaProps {
  items: string[];
}

export function CommunityMeta({ items }: CommunityMetaProps) {
  const visibleItems = items.map((item) => item.trim()).filter(Boolean);

  if (visibleItems.length === 0) return null;

  return (
    <div className="community-header-meta">
      <LocationPinIcon className="community-header-meta-icon" />
      <div className="community-header-meta-list">
        {visibleItems.map((item, index) => (
          <Fragment key={`${item}-${index}`}>
            {index > 0 && <span className="community-header-meta-separator">•</span>}
            <span className="community-header-meta-item">{item}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
