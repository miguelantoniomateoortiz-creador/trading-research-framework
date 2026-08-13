/**
 * @trf/plugin-sdk — todo lo que necesita un autor de plugins.
 *
 * Un plugin sólo importa de este paquete y de `@trf/shared`. Nunca de la base
 * de datos ni del analizador: así el núcleo puede reescribirse por dentro sin
 * romper plugins de terceros.
 */
export * from "./manifest.js";
export * from "./market-view.js";
export * from "./types.js";
export * from "./indicators.js";
export * from "./registry.js";
export * from "./loader.js";
