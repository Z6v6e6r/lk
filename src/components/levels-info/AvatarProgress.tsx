import { useId, useMemo } from "react";

type AvatarProgressProps = {
  imageUrl?: string | null;
  level: string;
  progress: number;
  segments?: number;
  size?: number;
  initials?: string;
  ringColor?: string;
  labelGradientFrom?: string;
  labelGradientTo?: string;
  onImageError?: () => void;
};

function clamp(min: number, value: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number) {
  const radians = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

export function AvatarProgress({
  imageUrl,
  level,
  progress,
  segments = 4,
  size = 292,
  initials = "?",
  ringColor = "#734CFF",
  labelGradientFrom = "#8F63FF",
  labelGradientTo = "#6E52FF",
  onImageError,
}: AvatarProgressProps) {
  const rawMarkerId = useId();
  const arrowMarkerId = `avatar-progress-arrow-${rawMarkerId.replace(/:/g, "")}`;
  const safeSegments = Math.max(2, Math.floor(segments));
  const safeProgress = clamp(0, Number.isFinite(progress) ? progress : 0, 100);

  const geometry = useMemo(() => {
    const strokeWidth = Math.max(10, Math.round(size * 0.055));
    const radius = size / 2 - strokeWidth / 2;

    // Зазор снизу под плашку уровня + маленькие зазоры между сегментами.
    const labelGapDeg = 62;
    const visibleDeg = 360 - labelGapDeg;
    const sectorDeg = visibleDeg / safeSegments;
    const dividerGapDeg = Math.min(3, Math.max(1.8, sectorDeg * 0.035));
    const segmentDashDeg = Math.max(0.1, sectorDeg - dividerGapDeg);

    // Используем pathLength=360, чтобы dasharray работал в градусах.
    const trackDashArrayParts: string[] = [];
    for (let i = 0; i < safeSegments; i += 1) {
      trackDashArrayParts.push(segmentDashDeg.toFixed(3));
      if (i < safeSegments - 1) {
        trackDashArrayParts.push(dividerGapDeg.toFixed(3));
      } else {
        trackDashArrayParts.push((labelGapDeg + dividerGapDeg).toFixed(3));
      }
    }

    const progressDeg = visibleDeg * (safeProgress / 100);

    // Центр нижнего зазора на 6 часов.
    const startAngleDeg = 90 + labelGapDeg / 2;

    const dividerLines = Array.from({ length: safeSegments - 1 }, (_, index) => {
      // Делитель рисуем по центру маленького зазора между секторами.
      const angle = startAngleDeg + sectorDeg * (index + 1) - dividerGapDeg / 2;
      const inner = polarToCartesian(size / 2, size / 2, radius - strokeWidth / 2 - 1, angle);
      const outer = polarToCartesian(size / 2, size / 2, radius + strokeWidth / 2 + 1, angle);
      return {
        x1: inner.x,
        y1: inner.y,
        x2: outer.x,
        y2: outer.y,
      };
    });

    const progressEndAngle = startAngleDeg + progressDeg;
    const progressArrowOuter = polarToCartesian(
      size / 2,
      size / 2,
      radius + strokeWidth * 1.05,
      progressEndAngle,
    );
    const progressArrowInner = polarToCartesian(
      size / 2,
      size / 2,
      radius + strokeWidth * 0.48,
      progressEndAngle,
    );

    return {
      strokeWidth,
      radius,
      trackDashArray: trackDashArrayParts.join(" "),
      progressDashArray: `${visibleDeg} 360`,
      // Для анимации управляем именно dashoffset.
      progressDashOffset: visibleDeg - progressDeg,
      rotationDeg: startAngleDeg,
      dividerLines,
      progressArrowInner,
      progressArrowOuter,
    };
  }, [safeProgress, safeSegments, size]);

  const hasImage = Boolean(imageUrl);

  return (
    <div
      className="avatar-progress"
      style={{ width: size, height: size + Math.round(size * 0.22) }}
    >
      <svg
        className="avatar-progress-svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        <defs>
          <marker
            id={arrowMarkerId}
            markerWidth="8"
            markerHeight="8"
            refX="6.5"
            refY="4"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,1 L7,4 L0,7 Z" fill={ringColor} />
          </marker>
        </defs>

        <circle
          cx={size / 2}
          cy={size / 2}
          r={geometry.radius}
          pathLength={360}
          fill="none"
          stroke="#EDEAFB"
          strokeWidth={geometry.strokeWidth}
          strokeDasharray={geometry.trackDashArray}
          transform={`rotate(${geometry.rotationDeg} ${size / 2} ${size / 2})`}
        />

        <circle
          className="avatar-progress-fill"
          cx={size / 2}
          cy={size / 2}
          r={geometry.radius}
          pathLength={360}
          fill="none"
          stroke={ringColor}
          strokeWidth={geometry.strokeWidth}
          strokeLinecap="round"
          strokeDasharray={geometry.progressDashArray}
          strokeDashoffset={geometry.progressDashOffset}
          transform={`rotate(${geometry.rotationDeg} ${size / 2} ${size / 2})`}
        />

        {geometry.dividerLines.map((line, index) => (
          <line
            key={`divider-${index + 1}`}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke="#FFFFFF"
            strokeWidth={4}
            strokeLinecap="round"
          />
        ))}

        {safeProgress > 0.1 && (
          <line
            x1={geometry.progressArrowOuter.x}
            y1={geometry.progressArrowOuter.y}
            x2={geometry.progressArrowInner.x}
            y2={geometry.progressArrowInner.y}
            stroke={ringColor}
            strokeWidth={2.4}
            strokeLinecap="round"
            markerEnd={`url(#${arrowMarkerId})`}
          />
        )}
      </svg>

      <div
        className="avatar-progress-image-wrap"
        style={{
          top: geometry.strokeWidth + 2,
          left: geometry.strokeWidth + 2,
          width: size - geometry.strokeWidth * 2 - 4,
          height: size - geometry.strokeWidth * 2 - 4,
        }}
      >
        {hasImage ? (
          <img
            src={imageUrl || undefined}
            alt="Аватар пользователя"
            className="avatar-progress-image"
            onError={() => onImageError?.()}
          />
        ) : (
          <div className="avatar-progress-image avatar-progress-image--fallback">{initials || "?"}</div>
        )}
      </div>

      <div
        className="avatar-progress-level-label"
        style={{
          bottom: Math.max(10, Math.round(size * 0.055)),
          background: `linear-gradient(132deg, ${labelGradientFrom} 0%, ${labelGradientTo} 100%)`,
        }}
      >
        {level || "—"}
      </div>
    </div>
  );
}
