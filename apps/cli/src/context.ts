import {
  NAS100,
  applySchema,
  getInstrument,
  listPluginInstalls,
  openDatabase,
  upsertInstrument,
  upsertPluginInstall,
  type DatabaseConfig,
  type SqliteDatabase,
} from "@trf/database";
import { discoverManifests, loadPlugins, type PluginRegistry } from "@trf/plugin-sdk";
import type { Instrument } from "@trf/shared";

/**
 * Contexto compartido por todos los comandos: base de datos abierta,
 * instrumento activo y registro de plugins sincronizado con el disco.
 */

export interface CliContext {
  readonly db: SqliteDatabase;
  readonly config: DatabaseConfig;
  readonly instrument: Instrument;
}

export function openContext(instrumentId = NAS100.id): CliContext {
  const { db, config } = openDatabase();
  applySchema(db);

  let instrument = getInstrument(db, instrumentId);
  if (instrument === null) {
    // El NAS100 se crea solo: es el instrumento de la primera investigación.
    upsertInstrument(db, NAS100);
    instrument = NAS100;
  }

  return { db, config, instrument };
}

/**
 * Sincroniza `plugins/` con la tabla `plugin_installs` y devuelve el registro
 * cargado. Los plugins nuevos aparecen activados; los que el usuario había
 * desactivado siguen desactivados.
 */
export async function loadRegistry(context: CliContext): Promise<PluginRegistry> {
  for (const discovered of discoverManifests(context.config.pluginsDir)) {
    upsertPluginInstall(context.db, {
      id: discovered.manifest.id,
      version: discovered.manifest.version,
      name: discovered.manifest.name,
      author: discovered.manifest.author,
      description: discovered.manifest.description,
      directory: discovered.directory,
      enabled: discovered.manifest.enabledByDefault,
      config: discovered.manifest.config,
    });
  }

  const overrides = new Map(
    listPluginInstalls(context.db).map((install) => [
      install.id,
      { enabled: install.enabled, config: install.config },
    ]),
  );

  return loadPlugins(context.config.pluginsDir, {
    overrides,
    tolerant: true,
    onError: (pluginId, error) => {
      console.warn(`⚠  El plugin "${pluginId}" no se pudo cargar y se ha omitido:`);
      console.warn(`   ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}
