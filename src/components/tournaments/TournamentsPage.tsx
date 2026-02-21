import { useState } from "react";
import { TournamentsTodayModal } from "../cabinet/TournamentsTodayModal";

interface TournamentsPageProps {
  onBack: () => void;
}

export default function TournamentsPage({ onBack }: TournamentsPageProps) {
  const [isTodayOpen, setIsTodayOpen] = useState(false);
  return (
    <div className="app-container">
      <div className="page-header">
        <button className="page-back" onClick={onBack} type="button">← Назад</button>
        <div className="page-title">Турниры</div>
      </div>

      <div className="section">
        <div className="section-header">
          <span className="section-title">Турнирный блок</span>
        </div>
        <div className="section-body">
          <p className="section-text">Здесь будет функционал турниров. Блок загружается отдельным скриптом.</p>
          <button className="section-cta" onClick={() => setIsTodayOpen(true)} type="button">
            Провести турнир
          </button>
        </div>
      </div>

      <TournamentsTodayModal
        isOpen={isTodayOpen}
        onClose={() => setIsTodayOpen(false)}
      />
    </div>
  );
}
