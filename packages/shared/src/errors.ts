/**
 * Jerarquía de errores del framework.
 *
 * Cada error lleva un `code` estable (útil para logs, métricas y para que la
 * UI decida cómo renderizarlo) y un `context` serializable.
 */

export type ErrorContext = Record<string, unknown>;

export abstract class TrfError extends Error {
  abstract readonly code: string;
  readonly context: ErrorContext;

  constructor(message: string, context: ErrorContext = {}, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    this.context = context;
  }

  toJSON(): { name: string; code: string; message: string; context: ErrorContext } {
    return { name: this.name, code: this.code, message: this.message, context: this.context };
  }
}

/** Datos de entrada malformados (CSV/JSON inválido, columna faltante, etc.). */
export class ValidationError extends TrfError {
  readonly code = "E_VALIDATION";
}

/** Un plugin no cumple el contrato o falla durante el cálculo. */
export class PluginError extends TrfError {
  readonly code = "E_PLUGIN";
}

/** El grafo de dependencias entre plugins no se puede resolver. */
export class DependencyError extends TrfError {
  readonly code = "E_DEPENDENCY";
}

/** Se intenta usar una variable que no existe en el registro. */
export class UnknownVariableError extends TrfError {
  readonly code = "E_UNKNOWN_VARIABLE";
}

/**
 * Se intentó usar una variable de resultado (outcome) como predictor.
 * Este es el error más importante del sistema: evita lookahead bias.
 */
export class LookaheadError extends TrfError {
  readonly code = "E_LOOKAHEAD";
}

/** Problema de persistencia. */
export class StorageError extends TrfError {
  readonly code = "E_STORAGE";
}

/** Configuración inválida o incoherente. */
export class ConfigError extends TrfError {
  readonly code = "E_CONFIG";
}
