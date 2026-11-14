/**
 * Cola de ejecución en serie para las mutaciones del explorador y los commits de subidas.
 *
 * Elegir un nombre libre («informe (2).pdf») y ocuparlo con rename no es atómico: entre ambos
 * pasos otra operación podría elegir el mismo nombre y rename lo SOBRESCRIBIRÍA. Todas las
 * operaciones que crean, renombran o mueven nombres pasan por una única cola, así que esa
 * comprobación y el rename son atómicos respecto al resto del proceso (único escritor del volumen).
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    // La cola sigue aunque una tarea falle: un error no puede bloquear las siguientes.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
