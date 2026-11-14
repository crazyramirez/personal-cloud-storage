/**
 * Guarda de navegación: sin propietario → configuración inicial; sin sesión → inicio de sesión.
 * La autorización real la hace siempre el servidor; esto solo decide qué pantalla mostrar.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const session = useSession();
  if (!session.checked.value) {
    try {
      await session.refresh();
    } catch {
      // Servidor inalcanzable: se deja pasar a la pantalla pedida, que mostrará el error de conexión.
      return to.path === '/entrar' ? undefined : navigateTo({ path: '/entrar', query: to.path === '/' ? {} : { volver: to.fullPath } });
    }
  }
  if (session.needsOwner.value) {
    return to.path === '/configuracion' ? undefined : navigateTo('/configuracion');
  }
  if (session.user.value === null) {
    if (to.path === '/entrar') return;
    return navigateTo({ path: '/entrar', query: to.path === '/' || to.path === '/configuracion' ? {} : { volver: to.fullPath } });
  }
  if (to.path === '/entrar' || to.path === '/configuracion') return navigateTo('/archivos');
});
