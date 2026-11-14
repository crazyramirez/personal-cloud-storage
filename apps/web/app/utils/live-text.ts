/**
 * Textos «vivos» para estados de error y avisos: guardan un texto o una función que lo produce.
 * Se evalúan al leerlos (en el render), así que siguen al idioma activo si se cambia mientras
 * el mensaje está en pantalla.
 */
import { customRef, type Ref } from 'vue';

export type LiveText = string | (() => string);

/** Ref que se lee como texto y admite asignar un texto o una función que lo produce. */
export function liveText(initial: LiveText = ''): Ref<string, LiveText> {
  let source: LiveText = initial;
  return customRef<string>((track, trigger) => ({
    get() {
      track();
      return typeof source === 'function' ? source() : source;
    },
    set(value: string) {
      source = value as LiveText;
      trigger();
    },
  })) as unknown as Ref<string, LiveText>;
}

/** Mensaje de un error capturado (siempre en el idioma activo), o el texto de reserva. */
export function errorText(error: unknown, fallbackKey: string, params?: MessageParams): () => string {
  return () => (error instanceof Error && error.message !== '' ? error.message : t(fallbackKey, params));
}
