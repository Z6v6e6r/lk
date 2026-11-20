import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "../../context/AuthContext";
import { readAuthToken } from "../../utils/authTokenStorage";
import { authSessionIdentity } from "../../utils/authSessionIdentity";
import { apiFetchProfile, apiSaveVivaRegistrationName, type UserProfileType } from "../../utils/apiClient";

function VivaRegistrationProfile({
  profile,
  onSaved,
  onLogout,
}: {
  profile: UserProfileType;
  onSaved: (profile: UserProfileType) => void;
  onLogout: () => void;
}) {
  const [firstName, setFirstName] = useState(profile.firstName ?? "");
  const [lastName, setLastName] = useState(profile.lastName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const givenName = firstName.trim();
    const familyName = lastName.trim();
    if (!givenName || !familyName || saving) return;
    setSaving(true);
    setError(null);

    try {
      if (!await apiSaveVivaRegistrationName(profile.id, { firstName: givenName, lastName: familyName })) {
        throw new Error("Profile update failed");
      }
      const { data: verified } = await apiFetchProfile(undefined, { clubLevel: false });
      if (verified?.id !== profile.id || !verified.firstName?.trim() || !verified.lastName?.trim()) {
        throw new Error("Profile names could not be verified");
      }
      onSaved(verified);
    } catch {
      setError("Не удалось сохранить профиль. Попробуйте ещё раз.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="auth-wrapper">
      <form className="auth-card" onSubmit={save} aria-busy={saving}>
        <p className="auth-title">Заполните профиль</p>
        <p className="auth-subtitle">Имя и фамилия нужны для записи в клуб.</p>
        <label>
          Имя
          <input className="auth-input" autoComplete="given-name" maxLength={80} required disabled={saving}
            value={firstName} onChange={(event) => setFirstName(event.target.value)} />
        </label>
        <label>
          Фамилия
          <input className="auth-input" autoComplete="family-name" maxLength={80} required disabled={saving}
            value={lastName} onChange={(event) => setLastName(event.target.value)} />
        </label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="auth-btn" type="submit" disabled={saving || !firstName.trim() || !lastName.trim()}>
          {saving ? "Сохраняем…" : "Продолжить"}
        </button>
        <button className="auth-link auth-link-btn" type="button" disabled={saving} onClick={onLogout}>Выйти</button>
      </form>
    </div>
  );
}

function VerifiedClubProfile({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetchProfile(controller.signal, { clubLevel: false }).then(({ data }) => {
      if (controller.signal.aborted) return;
      if (data?.id) setProfile(data);
      else setFailed(true);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [attempt]);

  if (failed) {
    return (
      <div className="auth-wrapper">
        <div className="auth-card">
          <p className="auth-title">Не удалось открыть профиль клуба</p>
          <button className="auth-btn" type="button" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}>
            Повторить
          </button>
          <button className="auth-link auth-link-btn" type="button" onClick={onLogout}>Выйти</button>
        </div>
      </div>
    );
  }
  if (!profile) return <div className="loading" role="status">Проверяем профиль клуба…</div>;
  if (profile.isNewClient === true && (!profile.firstName?.trim() || !profile.lastName?.trim())) {
    return <VivaRegistrationProfile key={profile.id} profile={profile} onSaved={setProfile} onLogout={onLogout} />;
  }
  return children;
}

function ActiveClubSession({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const [identity, setIdentity] = useState(() => authSessionIdentity(readAuthToken(), "viva"));
  useEffect(() => {
    const sync = () => setIdentity(authSessionIdentity(readAuthToken(), "viva"));
    window.addEventListener("storage", sync);
    window.addEventListener("focus", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("focus", sync);
    };
  }, []);
  return <VerifiedClubProfile key={identity ?? "unknown"} onLogout={onLogout}>{children}</VerifiedClubProfile>;
}

export function VivaRegistrationGate({ children }: { children: ReactNode }) {
  const { isAuthenticated, logout } = useAuth();
  return isAuthenticated ? <ActiveClubSession onLogout={logout}>{children}</ActiveClubSession> : children;
}
