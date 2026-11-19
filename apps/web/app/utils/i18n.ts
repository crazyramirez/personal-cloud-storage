/**
 * Idiomas de la interfaz: español, inglés, francés, alemán, italiano, chino (simplificado) y
 * japonés. Por defecto, el del navegador si es uno de ellos; si no, inglés. La elección manual se
 * recuerda en este navegador («pcloud.locale»).
 *
 * Los textos de referencia viven en app/i18n/<espacio>.ts (solo `import type` de aquí, para no
 * crear ciclos):
 *   const es = { title: 'Panel' } satisfies MessageTable;
 *   export default { es, en: { title: 'Dashboard' } satisfies Record<keyof typeof es, Message> };
 * El resto de idiomas, en app/i18n/<idioma>/<espacio>.ts:
 *   import type source from '../panel';
 *   export default { title: 'Tableau de bord' } satisfies Translation<typeof source>;
 * Clave completa: «<espacio>.<clave>» (p. ej. «panel.title»). Un valor puede ser un texto con
 * marcadores {nombre} o una función (params) => texto (plurales y frases compuestas).
 *
 * `t()` lee `locale.value`: dentro de plantillas y computed es reactiva al cambiar de idioma.
 */

export type Locale = 'es' | 'en' | 'fr' | 'de' | 'it' | 'zh' | 'ja';
export type LocalePreference = 'system' | Locale;
export type MessageParams = Record<string, string | number>;
export type Message = string | ((params: MessageParams) => string);
export type MessageTable = Record<string, Message>;
/** Traducción completa de un espacio a un idioma adicional: las mismas claves que el español. */
export type Translation<T extends { es: MessageTable }> = Record<keyof T['es'], Message>;

export const LOCALES: readonly Locale[] = ['es', 'en', 'fr', 'de', 'it', 'zh', 'ja'];
/** Nombre de cada idioma en su propio idioma (selector de Ajustes). */
export const LOCALE_NAMES: Record<Locale, string> = {
  es: 'Español',
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  zh: '简体中文',
  ja: '日本語',
};
/** Etiqueta BCP 47 por defecto de cada idioma (Intl y atributo lang). */
const DEFAULT_TAGS: Record<Locale, string> = { es: 'es-ES', en: 'en-US', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', zh: 'zh-CN', ja: 'ja-JP' };
const KEY = 'pcloud.locale';

const isLocale = (value: unknown): value is Locale => typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

const TABLES = Object.fromEntries(LOCALES.map((lang) => [lang, new Map<string, Message>()])) as Record<Locale, Map<string, Message>>;
const base = import.meta.glob<{ default: { es: MessageTable; en: MessageTable } }>('../i18n/*.ts', { eager: true });
for (const [file, module] of Object.entries(base)) {
  const namespace = file.replace(/^.*\/([^/]+)\.ts$/, '$1');
  for (const lang of ['es', 'en'] as const) {
    for (const [key, value] of Object.entries(module.default[lang])) TABLES[lang].set(`${namespace}.${key}`, value);
  }
}
// Los ficheros «_*.ts» de cada idioma no son espacios de mensajes (p. ej. _server.ts).
const extra = import.meta.glob<{ default: MessageTable }>(['../i18n/*/*.ts', '!../i18n/*/_*.ts'], { eager: true });
for (const [file, module] of Object.entries(extra)) {
  const match = /\/i18n\/([^/]+)\/([^/_][^/]*)\.ts$/.exec(file);
  if (match === null || !isLocale(match[1])) continue;
  for (const [key, value] of Object.entries(module.default)) TABLES[match[1]].set(`${match[2]}.${key}`, value);
}

// Textos exactos del servidor en los idiomas adicionales: app/i18n/<idioma>/_server.ts
// (español exacto → idioma). Los usa server-text.ts; aquí para que ese fichero siga cargándose en Node.
const SERVER: Partial<Record<Locale, Record<string, string>>> = {};
for (const [file, module] of Object.entries(import.meta.glob<{ default: Record<string, string> }>('../i18n/*/_server.ts', { eager: true }))) {
  const lang = /\/i18n\/([^/]+)\/_server\.ts$/.exec(file)?.[1];
  if (isLocale(lang)) SERVER[lang] = module.default;
}

/** Traducciones exactas de textos del servidor para un idioma adicional (si las hay). */
export function serverTranslations(lang: Locale): Record<string, string> | undefined {
  return SERVER[lang];
}

function browserLocale(): Locale {
  if (!import.meta.client) return 'es';
  const list = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of list) {
    const lang = (tag ?? '').toLowerCase().split('-')[0];
    if (isLocale(lang)) return lang;
  }
  return 'en';
}

function readPreference(): LocalePreference {
  try {
    const stored = import.meta.client ? localStorage.getItem(KEY) : null;
    return isLocale(stored) ? stored : 'system';
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
  return DEFAULT_TAGS[lang];
}

function applyDocument(): void {
  if (import.meta.client) document.documentElement.lang = locale.value === 'zh' ? 'zh-Hans' : locale.value;
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

/** Traduce una clave «espacio.clave». Si falta, cae al inglés, luego al español y, si tampoco existe, a la clave. */
export function t(key: string, params: MessageParams = {}): string {
  const message = TABLES[locale.value].get(key) ?? TABLES.en.get(key) ?? TABLES.es.get(key);
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
  return TABLES[locale.value].has(key) || TABLES.en.has(key) || TABLES.es.has(key);
}

/** Compatibilidad en plantillas: `$t` no hace falta; `t` se importa sola (auto-import de utils). */
export function useI18n() {
  return { t, locale, localePreference, setLocalePreference, intlLocale };
}
