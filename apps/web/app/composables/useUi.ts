/**
 * Piezas de interfaz globales: avisos (toasts), diálogos con promesa, menú contextual y
 * portapapeles de archivos (cortar/copiar/pegar dentro de la nube).
 *
 * Una sola instancia de cada una vive en el layout (UiHost.vue); las páginas solo llaman a
 * estas funciones.
 */

import type { IconName } from '~/utils/icons';

// ── Avisos ──────────────────────────────────────────────────────────────────────────────────

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'ok' | 'warn' | 'danger';
  action?: { label: string; run: () => void };
  busy?: boolean;
}

const toasts = ref<Toast[]>([]);
let toastId = 0;

export function toast(message: string, options: { tone?: Toast['tone']; action?: Toast['action']; timeoutMs?: number; busy?: boolean } = {}): number {
  const id = ++toastId;
  // Solo se ve el último aviso: uno nuevo sustituye al anterior (no se apilan).
  toasts.value = [{ id, message, tone: options.tone ?? 'info', action: options.action, busy: options.busy }];
  const timeout = options.timeoutMs ?? (options.busy === true ? 0 : options.action !== undefined ? 8000 : 4500);
  if (timeout > 0) setTimeout(() => dismissToast(id), timeout);
  return id;
}

/** Actualiza un aviso visible (p. ej. el progreso de una descarga). */
export function updateToast(id: number, patch: Partial<Omit<Toast, 'id'>>): void {
  toasts.value = toasts.value.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((item) => item.id !== id);
}

export function useToasts() {
  return { toasts };
}

// ── Diálogos ────────────────────────────────────────────────────────────────────────────────

export interface PromptOptions {
  title: string;
  label: string;
  value?: string;
  confirm: string;
  /** Caracteres a seleccionar al abrir (p. ej. el nombre sin la extensión). */
  selectLength?: number;
  help?: string;
  /** Validación local; el servidor valida igualmente. */
  validate?: (value: string) => string | null;
  /** Se ejecuta al confirmar; si lanza, el error se muestra en el diálogo y no se cierra. */
  submit?: (value: string) => Promise<void>;
  /** «password» para contraseñas (no se muestran ni se autocorrigen). */
  inputType?: 'text' | 'password';
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirm: string;
  danger?: boolean;
}

export interface PickFolderOptions {
  title: string;
  confirm: string;
  start: string;
  /** Rutas que no se pueden elegir (p. ej. la propia carpeta que se mueve). */
  forbidden?: readonly string[];
}

export interface ShareOptions {
  /** Ruta del cliente del archivo o carpeta. */
  path: string;
  name: string;
  kind: 'file' | 'dir';
}

type DialogState =
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void }
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'folder'; options: PickFolderOptions; resolve: (value: string | null) => void }
  | { kind: 'share'; options: ShareOptions; resolve: (value: null) => void };

const dialog = shallowRef<DialogState | null>(null);

export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    dialog.value = { kind: 'prompt', options, resolve };
  });
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    dialog.value = { kind: 'confirm', options, resolve };
  });
}

export function pickFolder(options: PickFolderOptions): Promise<string | null> {
  return new Promise((resolve) => {
    dialog.value = { kind: 'folder', options, resolve };
  });
}

/** Diálogo para crear un enlace de invitado (solo el propietario). */
export function shareDialog(options: ShareOptions): Promise<null> {
  return new Promise((resolve) => {
    dialog.value = { kind: 'share', options, resolve };
  });
}

export function useDialogState() {
  return { dialog };
}

// ── Menú contextual ─────────────────────────────────────────────────────────────────────────

export interface MenuItem {
  label: string;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  /** Motivo mostrado como ayuda cuando está desactivado. */
  hint?: string;
  danger?: boolean;
  checked?: boolean;
  run?: () => void;
  /** Separador antes de este elemento. */
  separator?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
  /** Elemento al que devolver el foco al cerrar. */
  returnFocus: HTMLElement | null;
}

const menu = shallowRef<MenuState | null>(null);

export function openMenu(at: { x: number; y: number }, items: MenuItem[], title?: string): void {
  const visible = items.filter((item) => item.label !== '');
  if (visible.length === 0) return;
  menu.value = { x: at.x, y: at.y, items: visible, title, returnFocus: document.activeElement as HTMLElement | null };
}

/** Abre el menú desde un evento (clic derecho, pulsación larga o botón «⋯»). */
export function openMenuFor(event: MouseEvent | KeyboardEvent | { x: number; y: number }, items: MenuItem[], title?: string): void {
  if ('preventDefault' in event) event.preventDefault();
  if (event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0)) {
    openMenu({ x: event.clientX, y: event.clientY }, items, title);
    return;
  }
  if ('x' in event && !(event instanceof KeyboardEvent) && !(event instanceof MouseEvent)) {
    openMenu(event, items, title);
    return;
  }
  // Teclado (tecla Menú o Mayús+F10): junto al elemento con el foco.
  const target = (event as Event).target as HTMLElement | null;
  const rect = target?.getBoundingClientRect();
  openMenu({ x: rect ? rect.left + 24 : 40, y: rect ? rect.bottom - 4 : 40 }, items, title);
}

export function closeMenu(): void {
  const state = menu.value;
  menu.value = null;
  state?.returnFocus?.focus?.({ preventScroll: true });
}

export function useMenuState() {
  return { menu };
}

// ── Portapapeles de archivos ────────────────────────────────────────────────────────────────

export interface FileClipboard {
  mode: 'cut' | 'copy';
  /** Rutas del cliente de los elementos. */
  paths: string[];
  /** Carpeta de origen (para no pegar «cortar» en la misma carpeta). */
  from: string;
}

const clipboard = ref<FileClipboard | null>(null);

export function useFileClipboard() {
  return { clipboard };
}

// ── Pulsación larga (móvil): abre el menú contextual ───────────────────────────────────────

/**
 * El menú abierto por una pulsación larga aparece bajo el dedo: hasta que ese dedo se levanta
 * (y un instante después, por el «click» sintético), las opciones no reaccionan. Así soltar el
 * dedo nunca elige la opción que quedó debajo.
 */
let holdingFinger = false;
let fingerReleasedAt = 0;
export const menuTouchGuard = (): boolean => holdingFinger || Date.now() - fingerReleasedAt < 450;

/**
 * Devuelve manejadores táctiles que llaman a `onLong` tras ~500 ms sin mover el dedo.
 * iOS Safari no emite «contextmenu»: esto lo sustituye.
 */
export function useLongPress(onLong: (point: { x: number; y: number }) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  // Mientras hay un dedo en pantalla, el «contextmenu» nativo (Android lo emite al mantener
  // pulsado) se anula: el menú lo abre solo esta pulsación larga, una única vez.
  const swallowNative = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  const release = (): void => {
    setTimeout(() => window.removeEventListener('contextmenu', swallowNative, true), 80);
  };
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    onTouchstart(event: TouchEvent): void {
      if (event.touches.length !== 1) return clear();
      const touch = event.touches[0] as Touch;
      start = { x: touch.clientX, y: touch.clientY };
      fired = false;
      clear();
      window.addEventListener('contextmenu', swallowNative, true);
      timer = setTimeout(() => {
        fired = true;
        holdingFinger = true;
        if (start !== null) onLong(start);
        navigator.vibrate?.(12);
      }, 500);
    },
    onTouchcancel(): void {
      clear();
      release();
      if (fired) {
        holdingFinger = false;
        fingerReleasedAt = Date.now();
      }
    },
    /** Un arrastre (iPad) cancela la pulsación larga. */
    cancel(): void {
      clear();
    },
    onTouchmove(event: TouchEvent): void {
      const touch = event.touches[0];
      if (start === null || touch === undefined) return;
      if (Math.abs(touch.clientX - start.x) > 10 || Math.abs(touch.clientY - start.y) > 10) clear();
    },
    onTouchend(event: TouchEvent): void {
      clear();
      release();
      if (fired) {
        holdingFinger = false;
        fingerReleasedAt = Date.now();
      }
      // Tras una pulsación larga, el «click» sintético no debe abrir el elemento.
      if (fired && event.cancelable) event.preventDefault();
    },
    /** true si la última pulsación fue larga (para ignorar el clic que la sigue). */
    wasLong: (): boolean => fired,
  };
}
