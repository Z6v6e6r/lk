import { useEffect, useState } from "react";
import { toDataURL } from "qrcode";

interface ResidencyPassQrProps {
  value: string | null;
  size?: number;
  alt?: string;
}

/**
 * Renders the one-time resident pass as a QR image.
 *
 * Only the short-lived pass token travels inside the QR. The image is generated in the browser
 * and never uploaded; when rendering fails the caller shows the pass state instead of a blank
 * area.
 */
export function ResidencyPassQr({ value, size = 248, alt = "QR-код пропуска резидента" }: ResidencyPassQrProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!value) {
      setDataUrl(null);
      setFailed(false);
      return undefined;
    }
    toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: size,
      color: { dark: "#0b0b0f", light: "#ffffff" },
    })
      .then((url) => {
        if (cancelled) return;
        setDataUrl(url);
        setFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setDataUrl(null);
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [size, value]);

  if (failed) {
    return (
      <div className="lk-residency-qr-fallback" role="status">
        Не удалось нарисовать QR. Обновите экран.
      </div>
    );
  }

  if (!dataUrl) {
    return <div className="lk-residency-qr-placeholder" aria-hidden="true" style={{ width: size, height: size }} />;
  }

  return (
    <img
      className="lk-residency-qr"
      src={dataUrl}
      width={size}
      height={size}
      alt={alt}
      decoding="async"
    />
  );
}
