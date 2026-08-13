import { z } from "zod";
import { ValidationError } from "@trf/shared";

/**
 * MANIFIESTO DE PLUGIN (`plugin.json`).
 *
 * El manifiesto es metadatos PUROS: se puede leer sin ejecutar código. Eso
 * permite que el dashboard liste plugins, muestre qué variables aportan y
 * deje activarlos/desactivarlos sin cargar ni un solo módulo.
 *
 * Las definiciones completas de las variables viven en el código (tipadas);
 * el manifiesto sólo declara sus CLAVES. El cargador comprueba que ambas
 * listas coincidan, así que no pueden desincronizarse en silencio.
 */

/** Versión de la API de plugins. Un plugin declara con cuál es compatible. */
export const PLUGIN_API_VERSION = 1;

export const timeframeSchema = z.enum(["M1", "M5", "M15", "M30", "H1", "H4", "D1"]);

export const pluginKindSchema = z.enum([
  /** Aporta variables a cada operación. */
  "feature",
  /** Genera operaciones (reglas de entrada). */
  "entry",
  /** Aporta análisis o vistas derivadas. */
  "analysis",
]);

export const pluginRequirementsSchema = z
  .object({
    /**
     * Timeframes ADICIONALES a la serie primaria que el plugin necesita ver
     * (vía `market.series("H1")`, por ejemplo). NO incluyas aquí el timeframe
     * primario: el motor lo añade automáticamente sea cual sea (M1, M5...), y
     * declararlo a mano rompe el análisis en cuanto se corre sobre un
     * timeframe distinto de M1. Déjalo vacío si el plugin sólo usa
     * `market.primary`, que es el caso más común.
     */
    timeframes: z.array(timeframeSchema).default([]),
    /**
     * Variables de OTROS plugins que este necesita. El registro ordena los
     * plugins topológicamente a partir de esto.
     */
    features: z.array(z.string()).default([]),
    /**
     * Cuántas velas de historia necesita antes de producir valores válidos.
     * Una EMA200 necesita ≥200; el motor no le pedirá cálculo hasta tenerlas,
     * evitando valores de calentamiento contaminados.
     */
    warmupBars: z.number().int().min(0).default(0),
  })
  .default({ timeframes: [], features: [], warmupBars: 0 });

export const manifestSchema = z.object({
  /** Identificador único, kebab-case. Es también el namespace lógico. */
  id: z
    .string()
    .min(2)
    .regex(/^[a-z][a-z0-9-]*$/, "El id debe ser kebab-case en minúsculas"),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "La versión debe ser semver X.Y.Z"),
  author: z.string().default(""),
  description: z.string().default(""),

  apiVersion: z.number().int().min(1),
  kind: z.array(pluginKindSchema).min(1),

  /** Módulo a importar, relativo al directorio del plugin. */
  entry: z.string().default("./src/index.ts"),

  requires: pluginRequirementsSchema,

  /**
   * Claves de las variables que el plugin produce. Deben coincidir exactamente
   * con las que devuelve el módulo en `provides`.
   */
  provides: z.array(z.string()).default([]),

  /** Configuración por defecto. El usuario la sobreescribe desde la UI/CLI. */
  config: z.record(z.unknown()).default({}),

  /** Si es false, el plugin se carga desactivado. */
  enabledByDefault: z.boolean().default(true),
});

export type PluginManifest = z.infer<typeof manifestSchema>;
export type PluginKind = z.infer<typeof pluginKindSchema>;
export type PluginRequirements = z.infer<typeof pluginRequirementsSchema>;

/** Valida un `plugin.json` ya parseado. */
export function parseManifest(raw: unknown, source: string): PluginManifest {
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`plugin.json inválido en ${source}`, {
      source,
      issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  if (result.data.apiVersion !== PLUGIN_API_VERSION) {
    throw new ValidationError(
      `El plugin "${result.data.id}" declara apiVersion ${result.data.apiVersion}, ` +
        `pero esta versión del framework implementa la ${PLUGIN_API_VERSION}`,
      { source, declared: result.data.apiVersion, supported: PLUGIN_API_VERSION },
    );
  }
  return result.data;
}
