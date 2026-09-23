import type { Settings, ThemeId, WindowSize } from '../../shared/types';
import { normalizeTheme } from './themes';

export class SettingsController {
  settings = $state<Settings>({
    theme: 'sage', window_size: { width: 400, height: null },
    always_on_top: true, auto_hide: false, hide_on_open: true,
    auto_tab_groups: true, opacity: 1, vault_timeout_minutes: 5,
    global_shortcut: 'Ctrl+Shift+Space', panic_shortcut: 'Ctrl+Alt+L',
  });
  previewTheme = $state<ThemeId | null>(null);
  opacityPreview = $state<number | null>(null);
  dirty = $state(false);
  discardRequest = $state(0);
  confirmBack = $state(false);
  private backTimer: ReturnType<typeof setTimeout> | undefined;

  load(value: Settings) {
    this.settings = {
      ...value,
      theme: normalizeTheme(value.theme),
      auto_tab_groups: value.auto_tab_groups ?? true,
      window_size: value.window_size ?? { width: 400, height: null },
      hide_on_open: value.hide_on_open ?? true,
      opacity: Math.max(0.3, Math.min(1, value.opacity ?? 1)),
    };
  }

  commit(value: Settings) {
    this.settings = value;
    this.previewTheme = null;
    this.opacityPreview = null;
  }

  setWindowSize(value: WindowSize) {
    this.settings = { ...this.settings, window_size: { ...value } };
  }

  requestLeave(isSettings: boolean): { allow: boolean; notice: string | null } {
    if (isSettings && this.dirty && !this.confirmBack) {
      this.confirmBack = true;
      if (this.backTimer) clearTimeout(this.backTimer);
      this.backTimer = setTimeout(() => { this.confirmBack = false; }, 4000);
      return { allow: false, notice: 'Settings have unsaved changes — repeat to discard them.' };
    }
    if (this.backTimer) clearTimeout(this.backTimer);
    this.confirmBack = false;
    if (isSettings && this.dirty) {
      this.discardRequest++;
      return { allow: true, notice: '' };
    }
    return { allow: true, notice: null };
  }

  dispose() {
    if (this.backTimer) clearTimeout(this.backTimer);
  }
}
