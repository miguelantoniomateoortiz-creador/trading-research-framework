# Importar datos de MetaTrader 5

## Exportar desde el terminal

1. `Herramientas → Datos históricos` (o `Ctrl+U`).
2. Selecciona el símbolo y el periodo **M1**.
3. Pulsa `Exportar barras`.

El fichero resultante es tabulado:

```
<DATE>	<TIME>	<OPEN>	<HIGH>	<LOW>	<CLOSE>	<TICKVOL>	<VOL>	<SPREAD>
2024.01.02	16:30:00	16800.5	16810.0	16795.0	16805.5	1234	0	2
```

El parser es tolerante: acepta tabulador, coma o punto y coma; con o sin
cabecera; fecha y hora juntas o separadas; y `2024.01.02`, `2024-01-02` o
`02/01/2024`. Si faltan las columnas de volumen o spread, se rellenan con cero.

Descarga sólo M1. Los timeframes superiores se agregan al vuelo, y guardar
copias de la misma información es la forma más fácil de que se desincronicen.

## Lo único que de verdad puede arruinarte el análisis

**MT5 exporta en hora del servidor del bróker, que casi nunca es UTC.**

Lo habitual es UTC+2 en invierno y UTC+3 en verano, siguiendo el horario de
verano **europeo**. El NAS100 abre a las 09:30 de Nueva York, que sigue el
horario de verano **estadounidense**. Los dos cambios de hora no coinciden:

- EE. UU. adelanta el segundo domingo de marzo; Europa, el último domingo.
- EE. UU. retrasa el primer domingo de noviembre; Europa, el último de octubre.

Resultado: unas **tres semanas al año** en las que el desfase entre ambos es de
una hora en lugar de las habituales.

Si tratas la hora del bróker como fija, durante esas semanas las velas que
etiquetas como "la apertura" son en realidad las de las 08:30 o las 10:30. Son
quince días de datos mal etiquetados mezclados con los buenos, justo en fechas
de alta volatilidad. No produce ningún error: produce conclusiones equivocadas.

### Cómo se evita aquí

El importador **exige** declarar la zona del origen:

```bash
# Bróker con DST europeo — lo correcto en casi todos los casos
pnpm trf data:import --file NAS100_M1.csv --tz Europe/Riga

# Bróker que de verdad exporta en UTC
pnpm trf data:import --file NAS100_M1.csv --tz UTC

# Desplazamiento fijo, SIN horario de verano
pnpm trf data:import --file NAS100_M1.csv --tz UTC+2
```

Los desplazamientos fijos (`UTC+2`) no aplican DST. Úsalos sólo si estás seguro
de que tu bróker no lo aplica.

### Cómo averiguar la zona de tu bróker

En MT5, la hora del servidor aparece en la ventana `Observación de mercado`.
Compárala con la tuya y con UTC un día de invierno y otro de verano. Si el
desfase cambia una hora entre ambos, tu bróker aplica DST y necesitas una zona
IANA. Los más comunes: `Europe/Riga`, `Europe/Athens`, `Europe/Helsinki` (todos
UTC+2/+3), `Europe/London` (UTC+0/+1).

Comprobación práctica tras importar: ejecuta `trf run` y mira el volumen medio
por minuto del día. El pico de la apertura debe caer limpiamente en
`time.minuteOfDay == 570`. Si aparece repartido entre 510 y 630, la zona está
mal.

## Idempotencia

La clave natural `(instrumento, timeframe, ts)` hace que reimportar sea seguro:

```
Filas leídas:    525.600
Aceptadas:       525.600
Insertadas:      12.400
Duplicadas:      513.200 (ya estaban en la base)
```

Puedes exportar mes a mes con rangos solapados sin preocuparte.

Cada importación deja un `import_batch` con el hash SHA-256 del fichero, los
conteos y los primeros cien errores de parseo. `trf data:status` lo muestra.

## Errores tolerados

Un fichero con tres líneas corruptas al final no debe tirar por tierra cinco
años de datos válidos. El parser acumula los errores y sigue:

- fecha u hora ilegibles;
- valores no numéricos;
- velas incoherentes (`high < low`, `close` fuera del rango).

Al terminar se reportan. Si el número es alto, sospecha del formato antes que
del bróker.

## Huecos

```bash
pnpm trf data:status
```

Lista los huecos de más de 24 horas. Los de fin de semana y festivos son
normales; los de mitad de semana significan datos que faltan.

Esto importa más de lo que parece: si te faltan los tres días más volátiles del
año porque el bróker tuvo una incidencia, tus estadísticas de cola están
sesgadas y no lo verás en ningún número.

## Datos sintéticos

```bash
pnpm trf data:generate --from 2022-01-01 --to 2025-12-31 --seed 42 --inject-pattern
```

Genera velas M1 deterministas con perfil de volatilidad en U, pico en la
apertura, gaps y fines de semana vacíos. Sirve para tres cosas:

1. Probar el pipeline sin datos reales.
2. **Calibrar el motor.** Con `--inject-pattern` se introduce un edge conocido:
   los días de gap grande revierten durante la primera hora. Si el análisis no
   lo encuentra, el motor está roto. Si encuentra edges en datos generados *sin*
   patrón, es que sobreajusta.
3. Medir rendimiento: cuánto tarda importar y analizar N millones de velas.

## Conexión directa con MT5

Todavía no implementada. `packages/importer/src/sources.ts` define la
abstracción `MarketDataSource` que consume el resto del framework, así que
añadirla no tocará ni la base de datos ni el analizador.

Tres opciones evaluadas:

- **A — Expert Advisor + socket local.** Un EA en MQL5 publica velas y ticks por
  TCP en localhost. Tiempo real de verdad; exige mantener código MQL5.
- **B — Servicio Python con la librería oficial `MetaTrader5`.** `copy_rates_range`
  da histórico completo en una llamada. Sólo Windows y con el terminal abierto.
- **C — Vigilar una carpeta donde un EA vuelca CSV.** Cero código nuevo:
  reutiliza `Mt5FileSource` tal cual.

Recomendación: empezar por **C** y pasar a **B** cuando haga falta histórico
bajo demanda.
