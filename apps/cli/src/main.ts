#!/usr/bin/env tsx
import { TrfError } from "@trf/shared";
import { parseArgs } from "./args.js";
import {
  dataGenerate,
  dataImport,
  dataPeek,
  dataStatus,
  dbInit,
  pluginsConfig,
  pluginsList,
  pluginsToggle,
  run,
  splitsCreate,
  splitsDelete,
  splitsList,
} from "./commands/data.js";
import {
  analyzeCohort,
  analyzeMarginal,
  discover,
  variablesList,
  variablesMaterialize,
} from "./commands/analysis.js";
import { hypothesisList, hypothesisSave, hypothesisValidate } from "./commands/hypotheses.js";

/**
 * `trf` — interfaz de línea de comandos.
 *
 * El CLI es la referencia funcional del framework: todo lo que hará el
 * dashboard (nivel 8) se puede hacer aquí primero. Eso obliga a que la lógica
 * viva en los paquetes y no en la interfaz, que es lo que permite que la
 * plataforma sobreviva a un cambio de tecnología de frontend.
 */

const HELP = `
Trading Research Framework · laboratorio de investigación cuantitativa

USO
  pnpm trf <comando> [opciones]

DATOS
  db:init                        Crea la base de datos y el instrumento por defecto.
  data:generate                  Genera velas M1 sintéticas de NAS100 en formato MT5.
      --from 2022-01-01 --to 2025-12-31 --seed 1 --out <ruta> [--inject-pattern]
  data:peek                      Inspecciona un CSV ANTES de importarlo: formato
                                 detectado y comprobación de la zona horaria.
      --file <ruta> [--tz Europe/Riga] [--sample 20000]
  data:import                    Importa un CSV/TSV exportado desde MT5.
      --file <ruta> [--tf M1] [--tz Europe/Riga]
  data:status                    Cobertura, huecos e historial de importaciones.

INVESTIGACIÓN
  run                            Genera operaciones aplicando los plugins de entrada
                                 y calcula todas las variables.
      [--tf M1] [--from] [--to] [--verbose]
      IMPORTANTE: usa el mismo --tf con el que importaste los datos
      (pnpm trf data:status --tf M5 te dice cuál es si no lo recuerdas).
  splits:create                  Define un periodo de entrenamiento o validación.
      --name train --role training --from 2022-01-01 --to 2025-01-01 [--embargo 5]
  splits:list                    Lista los splits y cuántas veces se han usado.
  splits:delete <nombre>          Borra un split para poder redefinirlo.

ANÁLISIS
  variables:list                 Catálogo de variables. [--causality predictor]
  variables:materialize          Indexa una variable del blob JSON. --key volatility.atr
  analyze:marginal               Qué hace cada variable por separado.
      --split train [--top 12] [--min-count 50] [--detail] [--rule <id>]
  analyze:cohort                 Evalúa una hipótesis concreta.
      --split train --where "time.minuteOfDay == 570 and volatility.atr > 18"
      [--diagnostic] [--rule <id>]
  discover                       Busca automáticamente combinaciones de variables
                                 que cumplan los umbrales dados (nivel 6).
      --split train --min-trades 100 [--min-winrate 0.6] [--min-pf 2]
      [--max-dd-pct 0.05] [--max-conditions 3] [--top 20] [--rule <id>]

  --rule filtra por una regla de entrada concreta (el id que imprime 'run' al
  terminar, p.ej. entry-opening-range-breakout__99cc9205). Sin --rule, el
  análisis mezcla las operaciones de TODAS las reglas activas — normalmente
  no es lo que quieres si tienen direcciones u objetivos distintos.

HIPÓTESIS (nivel 7)
  hypothesis:save                Guarda un predicado + su resultado en entrenamiento.
      --name "reversión confirmada" --where "..." --split train
      [--description "..."] [--search-space <N del 'discover' que lo produjo>]
      [--min-trades] [--min-winrate] [--min-pf] [--max-dd-pct]  (metadatos, informativos)
  hypothesis:list                 Lista hipótesis guardadas. [--status validated]
  hypothesis:validate <id|nombre> Evalúa la hipótesis contra un split NUEVO.
      --split val --yes
      Sin --yes sólo avisa cuántas veces se ha usado el split, no gasta nada.
      Compara contra el INTERVALO DE CONFIANZA de entrenamiento, no el punto.
      Escribe un registro inmutable y marca la hipótesis validated o rejected.
      NO se puede revalidar: si hace falta reintentar, se guarda una hipótesis nueva.

PLUGINS
  plugins:list                   Plugins detectados y orden de ejecución.
  plugins:enable <id>            Activa un plugin.
  plugins:disable <id>           Desactiva un plugin.
  plugins:config <id>            Ve o cambia la configuración de un plugin.
      [--set '{"tradeFade": true}']   Sin --set, sólo muestra la config actual.
      Cambiar la config crea una huella de regla de entrada distinta: las
      operaciones antiguas y nuevas conviven, filtrables con --rule.

LENGUAJE DE HIPÓTESIS (--where)
  volatility.atr > 18
  time.minuteOfDay == 570 and volatility.atr > 18
  (nas100.impulseDirection == 1 and nas100.pullbackFraction > 0.5) or time.dayOfWeek in (1, 5)
  volatility.atrRegime between 0.9 and 1.4 and not vwap.side == -1

FLUJO RECOMENDADO
  1. pnpm trf db:init
  2. pnpm trf data:generate --inject-pattern      (o importa tu CSV real)
  3. pnpm trf data:import --file <ruta> --tz America/New_York
  4. pnpm trf run
  5. pnpm trf splits:create --name train --role training --from 2022-01-01 --to 2025-01-01
     pnpm trf splits:create --name val --role validation --from 2025-01-10 --to 2026-01-01
  6. pnpm trf analyze:marginal --split train --detail
  7. pnpm trf analyze:cohort --split train --where "..."
  8. pnpm trf discover --split train --min-trades 100 --min-pf 1.5
  9. pnpm trf hypothesis:save --name "..." --where "..." --split train --search-space <N>
 10. Sólo cuando la hipótesis esté cerrada:
     pnpm trf hypothesis:validate "..." --split val --yes
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "db:init":
      await dbInit();
      break;
    case "data:generate":
      await dataGenerate(args);
      break;
    case "data:peek":
      await dataPeek(args);
      break;
    case "data:import":
      await dataImport(args);
      break;
    case "data:status":
      await dataStatus(args);
      break;
    case "run":
      await run(args);
      break;
    case "splits:create":
      await splitsCreate(args);
      break;
    case "splits:list":
      await splitsList();
      break;
    case "splits:delete":
      await splitsDelete(args);
      break;
    case "variables:list":
      await variablesList(args);
      break;
    case "variables:materialize":
      await variablesMaterialize(args);
      break;
    case "analyze:marginal":
      await analyzeMarginal(args);
      break;
    case "analyze:cohort":
      await analyzeCohort(args);
      break;
    case "discover":
      await discover(args);
      break;
    case "hypothesis:save":
      await hypothesisSave(args);
      break;
    case "hypothesis:list":
      await hypothesisList(args);
      break;
    case "hypothesis:validate":
      await hypothesisValidate(args);
      break;
    case "plugins:list":
      await pluginsList();
      break;
    case "plugins:enable":
      await pluginsToggle(args, true);
      break;
    case "plugins:disable":
      await pluginsToggle(args, false);
      break;
    case "plugins:config":
      await pluginsConfig(args);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`Comando desconocido: ${args.command}`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof TrfError) {
    console.error(`\n✖ [${error.code}] ${error.message}`);
    if (Object.keys(error.context).length > 0) {
      console.error(`  contexto: ${JSON.stringify(error.context)}`);
    }
  } else {
    console.error(`\n✖ ${error instanceof Error ? error.message : String(error)}`);
    if (process.env["TRF_DEBUG"] === "1" && error instanceof Error) console.error(error.stack);
  }
  process.exitCode = 1;
});
