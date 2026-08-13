/**
 * @trf/analyzer — el laboratorio.
 *
 * Dos mitades:
 *   - GENERACIÓN: `runner` + `simulator` convierten velas y plugins de entrada
 *     en operaciones con variables.
 *   - ANÁLISIS: `feature-matrix` + `predicate` + `cohort` + `marginal`
 *     responden preguntas sobre esas operaciones.
 *
 * El nivel 6 (Pattern Discovery) se construye ENCIMA de esto: buscar patrones
 * es enumerar predicados y evaluar cohortes, y ambas piezas ya están aquí.
 */
export * from "./predicate.js";
export * from "./expression.js";
export * from "./feature-matrix.js";
export * from "./cohort.js";
export * from "./guards.js";
export * from "./marginal.js";
export * from "./discovery.js";
export * from "./hypotheses.js";
export * from "./simulator.js";
export * from "./timeframe.js";
export * from "./runner.js";
export * from "./datasets.js";
