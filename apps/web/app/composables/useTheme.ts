/**
 * Tema: «sistema» (por defecto, sigue al dispositivo en vivo), claro u oscuro. La preferencia se
 * recuerda en este navegador. También ajusta el color de la barra del sistema (app instalada).
 */
type Theme = 'light' | 'dark';
export type ThemePreference = 'system' | Theme;
const KEY = 'pcloud-theme';
const theme = ref<Theme>('light');
const preference = ref<ThemePreference>('system');
let initialized = false;
let media: MediaQueryList | null = null;

function apply(): void {
  const resolved: Theme = preference.value === 'system' ? (media?.matches === true ? 'dark' : 'light') : preference.value;
  theme.value = resolved;
  document.documentElement.dataset.theme = resolved;
  const color = resolved === 'dark' ? '#0f1217' : '#f6f7f9';
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute('content', color));
}

export function useTheme() {
  if (!initialized && import.meta.client) {
    initialized = true;
    media = matchMedia('(prefers-color-scheme: dark)');
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(KEY);
    } catch {
      // Almacenamiento bloqueado: se usa el tema del sistema.
    }
    preference.value = stored === 'dark' || stored === 'light' ? stored : 'system';
    media.addEventListener('change', () => {
      if (preference.value === 'system') apply();
    });
    apply();
  }

  function set(value: ThemePreference): void {
    preference.value = value;
    apply();
    try {
      if (value === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, value);
    } catch {
      // Sin almacenamiento: el cambio vale para esta sesión.
    }
  }

  function toggle(): void {
    set(theme.value === 'dark' ? 'light' : 'dark');
  }

  return { theme, preference, toggle, set };
}
