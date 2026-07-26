import { useEffect, useMemo, useState } from "react";
import { Modal } from "../UI/Modal";
import { apiFetchExercisesByVisibleDate, isTournamentExerciseCategory } from "../../utils/apiClient";
import type { Exercise } from "../../utils/apiClient";

interface TournamentsTodayModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(timeStr?: string) {
  return timeStr ? timeStr.slice(11, 16) : "";
}

export function TournamentsTodayModal({ isOpen, onClose }: TournamentsTodayModalProps) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Exercise[]>([]);
  const [error, setError] = useState<string | null>(null);

  const todayStr = useMemo(() => formatDate(new Date()), []);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    apiFetchExercisesByVisibleDate(todayStr, { includePast: true, includeAdjacentDays: true })
      .then((res) => {
        if (res.data) setItems(res.data);
        else setItems([]);
      })
      .catch(() => setError("Не удалось загрузить список турниров"))
      .finally(() => setLoading(false));
  }, [isOpen, todayStr]);

  const tournaments = items.filter((ex) => isTournamentExerciseCategory(ex));

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Турниры на сегодня">
      <div className="tournaments-body">
        {loading && <div className="tournaments-muted">Загрузка...</div>}
        {!loading && error && <div className="tournaments-error">{error}</div>}
        {!loading && !error && tournaments.length === 0 && (
          <div className="tournaments-muted">На сегодня турниров нет</div>
        )}
        {!loading && !error && tournaments.length > 0 && (
          <div className="tournaments-list">
            {tournaments.map((ex) => (
              <div className="tournament-card" key={ex.id}>
                <div className="tournament-title">{ex.direction?.name || ex.type?.name || "Турнир"}</div>
                <div className="tournament-row">
                  <span>{formatTime(ex.timeFrom)} – {formatTime(ex.timeTo)}</span>
                  {ex.studio?.name && <span>{ex.studio.name}</span>}
                </div>
                {ex.studio?.address && (
                  <div className="tournament-address">{ex.studio.address}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
