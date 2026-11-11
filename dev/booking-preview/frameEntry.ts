import { installPreviewIsolation } from './previewIsolation';

try {
  installPreviewIsolation();
  void import('./screen');
} catch {
  document.getElementById('root')!.textContent = 'Не удалось изолировать тестовый профиль. Откройте стенд в другом браузере.';
}
