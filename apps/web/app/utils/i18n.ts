/**
 * Idiomas de la interfaz: español e inglés. Por defecto, el del navegador (es* → español; el
 * resto → inglés). La elección manual se recuerda en este navegador («pcloud.locale»).
 *
 * Los textos viven en app/i18n/<espacio>.ts (solo `import type` de aquí, para no crear ciclos):
 *   const es = { title: 'Panel' } satisfies MessageTable;
 *   export default { es, en: { title: 'Dashboard' } satisfies Record<keyof typeof es, Message> };
 * Clave completa: «<espacio>.<clave>» (p. ej. «panel.title»). Un valor puede ser un texto con
 * marcadores {nombre} o una función (params) => texto (plurales y frases compuestas).
 *
 * `t()` lee `locale.value`: dentro de plantillas y computed es reactiva al cambiar de idioma.
 */

export type Locale = 'es' | 'en';
export type LocalePreference = 'system' | Locale;
export type MessageParams = Record<string, string | number>;
export type Message = string | ((params: MessageParams) => string);
export type MessageTable = Record<string, Message>;

export const LOCALES: readonly Locale[] = ['es', 'en'];
const KEY = 'pcloud.locale';

const modules = import.meta.glob<{ default: { es: MessageTable; en: MessageTable } }>('../i18n/*.ts', { eager: true });
const TABLES: Record<Locale, Map<string, Message>> = { es: new Map(), en: new Map() };
for (const [file, module] of Object.entries(modules)) {
  const namespace = file.replace(/^.*\/([^/]+)\.ts$/, '$1');
  for (const lang of LOCALES) {
    for (const [key, value] of Object.entries(module.default[lang])) TABLES[lang].set(`${namespace}.${key}`, value);
  }
}

function browserLocale(): Locale {
  if (!import.meta.client) return 'es';
  const list = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of list) {
    const base = (tag ?? '').toLowerCase().split('-')[0];
    if (base === 'es') return 'es';
    if (base === 'en') return 'en';
  }
  return 'en';
}

function readPreference(): LocalePreference {
  try {
    const stored = import.meta.client ? localStorage.getItem(KEY) : null;
    return stored === 'es' || stored === 'en' ? stored : 'system';
  } catch {
    return 'system'; // almacenamiento bloqueado: idioma del navegador
  }
}

export const localePreference = ref<LocalePreference>(readPreference());
export const locale = ref<Locale>(localePreference.value === 'system' ? browserLocale() : localePreference.value);

/** Etiqueta BCP 47 para Intl: la del navegador si es del mismo idioma (es-MX, en-GB...). */
export function intlLocale(): string {
  const lang = locale.value;
  if (import.meta.client) {
    const list = navigator.languages?.length ? navigator.languages : [navigator.language];
    const match = list.find((tag) => (tag ?? '').toLowerCase().split('-')[0] === lang);
    if (match !== undefined) return match;
  }
  return lang === 'es' ? 'es-ES' : 'en-US';
}

function applyDocument(): void {
  if (import.meta.client) document.documentElement.lang = locale.value;
}

export function setLocalePreference(preference: LocalePreference): void {
  localePreference.value = preference;
  locale.value = preference === 'system' ? browserLocale() : preference;
  try {
    if (preference === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, preference);
  } catch {
    // Sin almacenamiento: vale para esta sesión.
  }
  applyDocument();
}

if (import.meta.client) {
  applyDocument();
  window.addEventListener('languagechange', () => {
    if (localePreference.value === 'system') setLocalePreference('system');
  });
}

const warned = new Set<string>();

/** Traduce una clave «espacio.clave». Si falta, cae al español y, si tampoco existe, a la clave. */
export function t(key: string, params: MessageParams = {}): string {
  const message = TABLES[locale.value].get(key) ?? TABLES.es.get(key);
  if (message === undefined) {
    if (import.meta.dev && !warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] falta la clave «${key}»`);
    }
    return key;
  }
  if (typeof message === 'function') return message(params);
  return message.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** ¿Existe la clave? (para textos opcionales, p. ej. errores por código). */
export function hasMessage(key: string): boolean {
  return TABLES[locale.value].has(key) || TABLES.es.has(key);
}

/** Compatibilidad en plantillas: `$t` no hace falta; `t` se importa sola (auto-import de utils). */
export function useI18n() {
  return { t, locale, localePreference, setLocalePreference, intlLocale };
}
