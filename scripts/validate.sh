#!/usr/bin/env bash
# =============================================================================
# validate.sh — comprobación completa del framework, de instalación a análisis.
#
#   bash scripts/validate.sh
#
# Ejecuta once pasos en orden. Si uno falla, se detiene ahí y muestra el final
# del log correspondiente, que es lo único que hace falta para diagnosticar.
# Los logs completos quedan en logs/.
#
# Opciones:
#   --skip-install     no reinstala dependencias (útil al reintentar)
#   --quick            usa 6 meses de datos sintéticos en vez de 4 años
# =============================================================================

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

SKIP_INSTALL=0
FROM="2022-01-01"
TO="2025-12-31"
TRAIN_TO="2025-01-01"
VAL_FROM="2025-01-10"
VAL_TO="2026-01-01"

for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --quick)
      FROM="2024-01-01"; TO="2024-12-31"
      TRAIN_TO="2024-10-01"; VAL_FROM="2024-10-10"; VAL_TO="2025-01-01"
      ;;
  esac
done

CSV="$ROOT/data/imports/nas100-synthetic-${FROM}_${TO}.csv"

# Se invoca el CLI por `pnpm exec` en vez de por `pnpm trf` para que los flags
# (--from, --where…) lleguen íntegros al script y no los interprete pnpm.
TRF=(pnpm exec tsx apps/cli/src/main.ts)

# --- Presentación ------------------------------------------------------------

STEP_NUM=0
FAILED=""

banner() {
  printf '\n\033[1m%s\033[0m\n' "$1"
  printf '%s\n' "$(printf '=%.0s' $(seq 1 ${#1}))"
}

# run <nombre> <fichero-log> <comando...>
run() {
  STEP_NUM=$((STEP_NUM + 1))
  local name="$1"; shift
  local logfile="$LOG_DIR/$1.log"; shift

  printf '\n[%02d] %-46s' "$STEP_NUM" "$name"
  if "$@" >"$logfile" 2>&1; then
    printf '\033[32mOK\033[0m\n'
    return 0
  fi

  printf '\033[31mFALLO\033[0m\n'
  FAILED="$name"
  printf '\n--- últimas 60 líneas de %s ---\n' "$logfile"
  tail -n 60 "$logfile"
  printf -- '--- fin del log ---\n'
  return 1
}

# --- 0. Entorno --------------------------------------------------------------

banner "Entorno"
printf 'directorio : %s\n' "$ROOT"
printf 'node       : %s\n' "$(node -v 2>/dev/null || echo 'NO INSTALADO')"
printf 'pnpm       : %s\n' "$(pnpm -v 2>/dev/null || echo 'NO INSTALADO')"
printf 'sistema    : %s %s\n' "$(uname -s)" "$(uname -m)"

if ! command -v node >/dev/null 2>&1; then
  printf '\n✖ Falta Node.js (>= 20.11). Instálalo con: brew install node\n'
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  printf '\n✖ Falta pnpm. Actívalo con:  corepack enable pnpm\n'
  printf '  (corepack viene con Node; si no lo tienes: npm install -g pnpm)\n'
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  printf '\n✖ Node %s es demasiado antiguo. Hace falta >= 20.11.\n' "$(node -v)"
  exit 1
fi

banner "Validación"

# --- 1-3. Instalación, tipos y pruebas --------------------------------------

if [ "$SKIP_INSTALL" -eq 0 ]; then
  run "Instalar dependencias" "01-install" pnpm install || exit 1
else
  STEP_NUM=$((STEP_NUM + 1))
  printf '\n[%02d] %-46s\033[33mOMITIDO\033[0m\n' "$STEP_NUM" "Instalar dependencias"
fi

run "Comprobar tipos (TypeScript estricto)" "02-typecheck" pnpm typecheck || exit 1
run "Pruebas unitarias" "03-test" pnpm test || exit 1

# Resumen de las pruebas, que es lo interesante del log.
printf '\n'
grep -E "Test Files|Tests  |Duration" "$LOG_DIR/03-test.log" | sed 's/^/     /'

# --- 4. Base de datos --------------------------------------------------------

run "Crear la base de datos" "04-db-init" "${TRF[@]}" db:init || exit 1
sed -n '1,4p' "$LOG_DIR/04-db-init.log" | sed 's/^/     /'

# --- 5-6. Datos --------------------------------------------------------------

run "Generar velas sintéticas ($FROM → $TO)" "05-generate" \
  "${TRF[@]}" data:generate --from "$FROM" --to "$TO" --seed 20240101 --inject-pattern || exit 1
grep -E "velas escritas" "$LOG_DIR/05-generate.log" | sed 's/^/     /'

if [ ! -f "$CSV" ]; then
  CSV="$(ls -t "$ROOT"/data/imports/*.csv 2>/dev/null | head -1)"
fi

run "Importar el CSV a SQLite" "06-import" \
  "${TRF[@]}" data:import --file "$CSV" --tz America/New_York --yes || exit 1
grep -E "Filas leídas|Aceptadas|Insertadas|Rechazadas|Rango" "$LOG_DIR/06-import.log" | sed 's/^/     /'

run "Inspeccionar cobertura y huecos" "07-status" "${TRF[@]}" data:status || exit 1
sed -n '1,12p' "$LOG_DIR/07-status.log" | sed 's/^/     /'

# --- 8. Plugins --------------------------------------------------------------

run "Cargar y ordenar los plugins" "08-plugins" "${TRF[@]}" plugins:list || exit 1
cat "$LOG_DIR/08-plugins.log" | sed 's/^/     /'

# --- 9. Corrida de investigación --------------------------------------------

run "Generar operaciones y variables" "09-run" "${TRF[@]}" run || exit 1
grep -E "Velas procesadas|Señales|Operaciones|Reglas|Tiempo|Huella" "$LOG_DIR/09-run.log" | sed 's/^/     /'

run "Catálogo de variables" "10-variables" "${TRF[@]}" variables:list || exit 1
printf '     variables registradas: %s\n' "$(grep -cE '^[a-z]+\.' "$LOG_DIR/10-variables.log")"

# --- 11. Estadísticas --------------------------------------------------------

STEP_NUM=$((STEP_NUM + 1))
printf '\n[%02d] %-46s' "$STEP_NUM" "Crear splits de entrenamiento y validación"
{
  "${TRF[@]}" splits:create --name train --role training   --from "$FROM"     --to "$TRAIN_TO" --embargo 5
  "${TRF[@]}" splits:create --name val   --role validation --from "$VAL_FROM" --to "$VAL_TO"
  "${TRF[@]}" splits:list
} >"$LOG_DIR/11-splits.log" 2>&1
if grep -q "train" "$LOG_DIR/11-splits.log"; then
  printf '\033[32mOK\033[0m\n'
  sed -n '/Splits de/,$p' "$LOG_DIR/11-splits.log" | sed 's/^/     /'
else
  printf '\033[31mFALLO\033[0m\n'
  tail -n 40 "$LOG_DIR/11-splits.log"
  exit 1
fi

run "Análisis marginal" "12-marginal" \
  "${TRF[@]}" analyze:marginal --split train --top 10 --min-count 50 || exit 1
sed -n '/Variables con más señal/,/^$/p' "$LOG_DIR/12-marginal.log" | sed 's/^/     /'

run "Cohorte de ejemplo (impulso alcista de apertura)" "13-cohort" \
  "${TRF[@]}" analyze:cohort --split train \
    --where "nas100.impulseDirection == 1 and nas100.openingRangeComplete == 1" || exit 1
sed -n '/Operaciones  /,/t \/ p-valor/p' "$LOG_DIR/13-cohort.log" | sed 's/^/     /'

# --- 14. La prueba que de verdad importa ------------------------------------

STEP_NUM=$((STEP_NUM + 1))
printf '\n[%02d] %-46s' "$STEP_NUM" "Guarda anti-lookahead (debe RECHAZAR)"
if "${TRF[@]}" analyze:cohort --split train --where "time.minuteOfDay == 570 and mae < 25" \
     >"$LOG_DIR/14-lookahead.log" 2>&1; then
  printf '\033[31mFALLO\033[0m\n'
  printf '     El motor ACEPTÓ un filtro por MAE. La guarda no está funcionando.\n'
  FAILED="guarda anti-lookahead"
else
  if grep -q "E_LOOKAHEAD" "$LOG_DIR/14-lookahead.log"; then
    printf '\033[32mOK\033[0m\n'
    grep -A3 "E_LOOKAHEAD" "$LOG_DIR/14-lookahead.log" | head -5 | sed 's/^/     /'
  else
    printf '\033[31mFALLO\033[0m\n'
    printf '     Falló, pero no por lookahead:\n'
    tail -n 20 "$LOG_DIR/14-lookahead.log" | sed 's/^/     /'
    FAILED="guarda anti-lookahead"
  fi
fi

# --- Resumen -----------------------------------------------------------------

banner "Resultado"
if [ -z "$FAILED" ]; then
  printf '\033[32mTodo correcto.\033[0m El framework está validado de punta a punta.\n\n'
  printf 'Siguiente paso: importar tu CSV real de MT5.\n'
  printf '  pnpm trf data:import --file /ruta/a/tu/NAS100_M1.csv --tz Europe/Riga\n'
  printf '  pnpm trf run\n\n'
  printf 'Logs completos en: %s\n' "$LOG_DIR"
else
  printf '\033[31mFalló:\033[0m %s\n' "$FAILED"
  printf 'Log completo en %s\n' "$LOG_DIR"
  exit 1
fi
