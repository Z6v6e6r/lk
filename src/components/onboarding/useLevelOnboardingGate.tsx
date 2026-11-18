import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetchProfile, type UserProfileType } from "../../utils/apiClient";
import { hasLevelRestriction, getEventAllowedLevelLabel } from "../../utils/levelAdmission";
import { readAuthToken } from "../../utils/authTokenStorage";
import { Modal } from "../UI/Modal";
import { OnboardingModal } from "../cabinet/OnboardingModal";

/** Keeps the selected event and payment option on the underlying page. Never books automatically. */
export function useLevelOnboardingGate(targetKey: string | null | undefined) {
  const [prompt, setPrompt] = useState<"required" | "unavailable" | "conflict" | null>(null);
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [checkingLevel, setCheckingLevel] = useState(false);
  const [allowedLevel, setAllowedLevel] = useState<string | null>(null);
  const inFlight = useRef<number | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const levelProfileRef = useRef<UserProfileType | null>(null);
  useEffect(() => {
    generation.current += 1;
    activeRequest.current?.abort(); inFlight.current = null;
    setCheckingLevel(false); setAllowedLevel(null); setPrompt(null); setProfile(null); setOnboardingOpen(false);
    return () => { generation.current += 1; activeRequest.current?.abort(); inFlight.current = null; };
  }, [targetKey]);

  const checkLevel = useCallback(async (event: unknown, expectedClientId?: string | null) => {
    levelProfileRef.current = null;
    if (!hasLevelRestriction(event)) return true;
    if (inFlight.current !== null) return false;
    setAllowedLevel(getEventAllowedLevelLabel(event));
    const started = generation.current;
    inFlight.current = started;
    const controller = new AbortController();
    activeRequest.current = controller;
    setCheckingLevel(true);
    const token = readAuthToken();
    try {
      const result = await apiFetchProfile(controller.signal);
      if (started !== generation.current || token !== readAuthToken()) return false;
      const current = result.data;
      if (!result.error && current && (!expectedClientId || current.id === expectedClientId)
        && current.level?.source === "CUP_CANONICAL" && current.level.status === "CONFLICT") {
        setPrompt("conflict"); return false;
      }
      if (result.error || !current || (expectedClientId && current.id !== expectedClientId)
        || current.level?.source !== "CUP_CANONICAL"
        || !["RATED", "UNRATED"].includes(current.level.status)) {
        setPrompt("unavailable"); return false;
      }
      if (current.level.status === "UNRATED") {
        setProfile(current); setPrompt("required"); return false;
      }
      if (!Number.isFinite(current.level.ratingNumeric) || current.level.ratingNumeric == null || current.level.ratingNumeric < 1 || current.level.ratingNumeric > 7) {
        setPrompt("unavailable"); return false;
      }
      levelProfileRef.current = current;
      setPrompt(null); return true;
    } catch {
      if (started === generation.current) setPrompt("unavailable");
      return false;
    } finally {
      if (inFlight.current === started) {
        inFlight.current = null; activeRequest.current = null; setCheckingLevel(false);
      }
    }
  }, []);

  const levelOnboardingDialog = checkingLevel ? (
    <Modal isOpen title="Проверяем уровень" onClose={() => {
      generation.current += 1; activeRequest.current?.abort(); inFlight.current = null;
      setCheckingLevel(false);
    }}>
      <div className="onboarding-body"><p className="onboarding-text" role="status">Проверяем ваш уровень перед записью…</p></div>
    </Modal>
  ) : onboardingOpen && profile ? (
    <OnboardingModal isOpen returnToEvent onClose={() => setOnboardingOpen(false)} profile={profile}
      gamesLink="#" trainingLink="#" tournamentsLink="#"
      onProfileUpdated={detail => {
        window.dispatchEvent(new CustomEvent("lk-profile-updated", { detail }));
      }} />
  ) : prompt ? (
    <Modal isOpen onClose={() => setPrompt(null)} title={prompt === "required" ? "Сначала определите уровень" : prompt === "conflict" ? "Требуется сверка уровня" : "Не удалось проверить уровень"}>
      <div className="onboarding-body">
        {allowedLevel && <p className="onboarding-text">Допустимый уровень: <strong>{allowedLevel}</strong></p>}
        <p className="onboarding-text" role="status">{prompt === "required"
          ? "У этого события есть ограничение по уровню. Пройдите онбординг: укажите известный уровень или определите его по анкете. После сохранения вернитесь к записи."
          : prompt === "conflict" ? "В данных ЦУП есть расхождение. Обратитесь в поддержку для сверки уровня." : "Уровень ЦУП сейчас недоступен. Закройте это окно и повторите запись для новой проверки."}</p>
        <div className="onboarding-actions">
          <button type="button" className="btn-secondary" onClick={() => setPrompt(null)}>Вернуться к событию</button>
          {prompt === "required" && <button type="button" className="btn-primary" onClick={() => { setPrompt(null); setOnboardingOpen(true); }}>Пройти онбординг</button>}
        </div>
      </div>
    </Modal>
  ) : null;
  return { checkLevel, levelOnboardingDialog, levelProfileRef };
}
