import { useEffect, useMemo, useRef, useState } from "react";
import { loadWidget, type WidgetGlobalName, type WidgetModule } from "../../utils/widgetLoader";

interface RemoteWidgetHostProps {
  src?: string;
  globalName: WidgetGlobalName;
  data?: unknown;
  forceReload?: boolean;
  loadingText?: string;
  errorTitle?: string;
  className?: string;
}

function buildTargetId(globalName: WidgetGlobalName) {
  const normalized = globalName.replace(/^LKWidget/, "").toLowerCase();
  return `lk-widget-host-${normalized}-${Math.random().toString(36).slice(2, 10)}`;
}

export function RemoteWidgetHost({
  src,
  globalName,
  data,
  forceReload = false,
  loadingText = "Загрузка...",
  errorTitle = "Не удалось загрузить модуль",
  className,
}: RemoteWidgetHostProps) {
  const targetId = useMemo(() => buildTargetId(globalName), [globalName]);
  const widgetRef = useRef<WidgetModule | null>(null);
  const mountedRef = useRef(false);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setError("URL виджета не настроен");
      setIsReady(false);
      return;
    }

    setIsReady(false);
    setError(null);

    let cancelled = false;

    const mountWidget = async () => {
      try {
        const widget = await loadWidget(src, globalName, { forceReload });
        if (cancelled) return;

        widgetRef.current = widget;
        widget.mount({ targetId, data });
        mountedRef.current = true;
        setError(null);
        setIsReady(true);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Ошибка загрузки";
        setError(message);
        setIsReady(false);
      }
    };

    void mountWidget();

    return () => {
      cancelled = true;
      if (mountedRef.current) {
        widgetRef.current?.unmount?.(targetId);
        mountedRef.current = false;
      }
      widgetRef.current = null;
    };
  }, [forceReload, globalName, src, targetId]);

  useEffect(() => {
    if (!mountedRef.current || !widgetRef.current) return;
    const widget = widgetRef.current;
    if (widget.update) {
      widget.update({ targetId, data });
      return;
    }
    widget.mount({ targetId, data });
  }, [data, targetId]);

  if (error) {
    return (
      <div className={className}>
        <div className="load-error">
          <div className="load-error-title">{errorTitle}</div>
          <div className="load-error-text">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      {!isReady && <div className="loading">{loadingText}</div>}
      <div id={targetId} />
    </div>
  );
}
