import { installPreviewIsolation } from './previewIsolation';
import { readPreviewSkin } from './previewSkin';

try {
  installPreviewIsolation();
  document.documentElement.dataset.previewSkin = readPreviewSkin(new URLSearchParams(location.search));
  void import('./screen');
} catch {
  document.getElementById('root')!.textContent = 'Не удалось изолировать тестовый профиль. Откройте стенд в другом браузере.';
}
