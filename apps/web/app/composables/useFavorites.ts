import type { FavoriteEntry, FavoriteListResponse } from '@pcloud/contracts';

/**
 * Favoritos (ADR-0027), compartidos por el explorador, el visor, el Panel, la página Favoritos y
 * el acceso rápido de la barra lateral. Una sola copia en memoria por pestaña: se carga al primer
 * uso y cada cambio responde con la lista completa del servidor.
 *
 * Los cambios se ven al instante (la estrella se rellena antes de que conteste el servidor) y se
 * deshacen si falla.
 */
const entries = ref<FavoriteEntry[]>([]);
const loaded = ref(false);
const failed = ref(false);
const max = ref(500);
/** Usuario al que pertenecen los favoritos en memoria (al cambiar de cuenta se vacían). */
let owner: string | null = null;
let inflight: Promise<void> | null = null;
/** Cada cambio incrementa la versión: una respuesta de antes de un cambio posterior se ignora. */
let version = 0;

export interface FavoriteTarget {
  readonly path: string;
  readonly type: 'dir' | 'file';
}

function apply(response: FavoriteListResponse, at: number): void {
  if (at !== version) return;
  entries.value = response.entries;
  max.value = response.max;
  loaded.value = true;
  failed.value = false;
}

async function fetchList(): Promise<void> {
  const at = version;
  try {
    apply(await api<FavoriteListResponse>('/favorites'), at);
  } catch {
    if (at === version && !loaded.value) failed.value = true;
  }
}

const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p: string): string => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')));

export function useFavorites() {
  const session = useSession();
  const paths = computed(() => new Set(entries.value.map((entry) => entry.path)));

  /** Carga la lista si aún no está (o si cambió la cuenta). */
  function ensure(): void {
    const who = session.user.value?.username ?? null;
    if (who !== owner) {
      owner = who;
      version += 1;
      entries.value = [];
      loaded.value = false;
      failed.value = false;
      inflight = null;
    }
    if (who === null || loaded.value || inflight !== null) return;
    inflight = fetchList().finally(() => {
      inflight = null;
    });
  }

  /** Vuelve a pedir la lista (tras renombrar, mover o eliminar: el servidor ya movió las rutas). */
  function refresh(): Promise<void> {
    if (session.user.value === null) return Promise.resolve();
    if (session.user.value.username !== owner) {
      ensure();
      return inflight ?? Promise.resolve();
    }
    return fetchList();
  }

  const isFavorite = (path: string): boolean => paths.value.has(path);

  async function mutate(kind: 'add' | 'remove', targets: readonly FavoriteTarget[], optimistic: FavoriteEntry[]): Promise<boolean> {
    const before = entries.value;
    const at = ++version;
    entries.value = optimistic;
    try {
      const response = await api<FavoriteListResponse>(kind === 'add' ? '/favorites' : '/favorites/remove', {
        method: 'POST',
        body: { paths: targets.map((target) => target.path) },
      });
      apply(response, at);
      return true;
    } catch (error) {
      if (at === version) entries.value = before;
      toast(error instanceof ApiError ? error.message : t('favorites.saveFailed'), { tone: 'danger' });
      void fetchList();
      return false;
    }
  }

  async function add(targets: readonly FavoriteTarget[], options: { quiet?: boolean } = {}): Promise<boolean> {
    const fresh = targets.filter((target) => !isFavorite(target.path));
    if (fresh.length === 0) return true;
    const now = new Date().toISOString();
    const placeholders = fresh.map<FavoriteEntry>((target) => ({
      path: target.path,
      dir: dirOf(target.path),
      name: nameOf(target.path),
      type: target.type,
      size: 0,
      mtime: null,
      addedAt: now,
      exists: true,
    }));
    const ok = await mutate('add', fresh, [...placeholders.reverse(), ...entries.value]);
    if (ok && options.quiet !== true) {
      toast(t('favorites.added', { n: fresh.length, name: nameOf((fresh[0] as FavoriteTarget).path) }), {
        tone: 'ok',
        action: { label: t('favorites.seeAll'), run: () => void navigateTo('/favoritos') },
      });
    }
    return ok;
  }

  async function remove(targets: readonly FavoriteTarget[], options: { quiet?: boolean } = {}): Promise<boolean> {
    const gone = targets.filter((target) => isFavorite(target.path));
    if (gone.length === 0) return true;
    const removing = new Set(gone.map((target) => target.path));
    // Para «Deshacer»: vuelve a añadir los que se pueden añadir (los que siguen existiendo).
    const restorable = entries.value.filter((entry) => removing.has(entry.path) && entry.exists !== false).map((entry) => ({ path: entry.path, type: entry.type }));
    const ok = await mutate('remove', gone, entries.value.filter((entry) => !removing.has(entry.path)));
    if (ok && options.quiet !== true) {
      toast(t('favorites.removed', { n: gone.length, name: nameOf((gone[0] as FavoriteTarget).path) }), {
        tone: 'ok',
        ...(restorable.length > 0 ? { action: { label: t('favorites.undo'), run: () => void add(restorable, { quiet: true }) } } : {}),
      });
    }
    return ok;
  }

  /** Estrella de una selección: si todos son favoritos, los quita; si no, añade los que falten. */
  function toggle(targets: readonly FavoriteTarget[]): Promise<boolean> {
    if (targets.length === 0) return Promise.resolve(true);
    return targets.every((target) => isFavorite(target.path)) ? remove(targets) : add(targets);
  }

  return { entries, loaded, failed, max, paths, ensure, refresh, isFavorite, add, remove, toggle };
}
