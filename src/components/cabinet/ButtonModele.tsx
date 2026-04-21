import { useState, useEffect } from "react";
import { useAuth } from "../../context/AuthContext";
const tgLogo = "https://padlhub.su/lk/assets/telegram.svg";
const vkLogo = "https://padlhub.su/lk/assets/vk.svg";
const giftLogo = "https://padlhub.su/lk/assets/gift-card.png";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export function ButtonModule() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const { logout } = useAuth();

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstall = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
    } else {
      alert('iOS: нажмите "Поделиться" → "На экран Домой"\nAndroid: меню браузера → "Добавить на главный экран"');
    }
  };

  return (
    <div className="social-section">
      <div className="social-links">
        <a href="https://vk.com/padlhub" target="_blank" rel="noopener noreferrer" className="social-link">
          <img src={vkLogo} alt="ВКонтакте" />
        </a>
        <a href="https://padlhub.ru/giftcard" target="_blank" rel="noopener noreferrer" className="social-link">
          <img src={giftLogo} alt="Подарочная карта" />
        </a>
        <a href="https://t.me/padel_academyF" target="_blank" rel="noopener noreferrer" className="social-link">
          <img src={tgLogo} alt="Telegram" />
        </a>
        <button className="install-btn" onClick={handleInstall} title="Добавить на рабочий стол">
          📲
        </button>
      </div>
      <button className="social-logout" onClick={logout} title="Выйти">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5-5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z" fill="#1A1A1A"/>
        </svg>
      </button>
    </div>
  );
}
