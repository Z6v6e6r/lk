import { useState, useEffect } from "react";
import tgLogo from "../../assets/telegram.svg";
import vkLogo from "../../assets/vk.svg";
import giftLogo from "../../assets/gift-card.png";

export function ButtonModule() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

  useEffect(() => {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    });
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
  );
}
