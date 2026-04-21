interface CommunitySectionHeaderProps {
  title: string;
  caption: string;
}

export function CommunitySectionHeader({ title, caption }: CommunitySectionHeaderProps) {
  return (
    <div className="community-feed-section-head">
      <h3 className="community-feed-section-title">{title}</h3>
      <span className="community-feed-section-caption">{caption}</span>
    </div>
  );
}
