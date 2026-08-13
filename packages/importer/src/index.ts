/**
 * @trf/importer — entrada de datos al laboratorio.
 *
 * Flujo: fichero MT5 → parseo tolerante → normalización horaria → lotes →
 * SQLite, con trazabilidad completa en `import_batches`.
 */
export * from "./csv.js";
export * from "./timezone.js";
export * from "./mt5-bars.js";
export * from "./pipeline.js";
export * from "./synthetic.js";
export * from "./sources.js";
