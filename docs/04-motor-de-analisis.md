# Motor de análisis

## Lenguaje de hipótesis

```bash
pnpm trf analyze:cohort --split train --where "time.minuteOfDay == 570 and volatility.atr > 18"
```

Gramática:

```
volatility.atr > 18
time.minuteOfDay == 570 and volatility.atr > 18 and market.gapPoints < 10
(nas100.impulseDirection == 1 and nas100.pullbackFraction > 0.5) or time.dayOfWeek in (1, 5)
volatility.atrRegime between 0.9 and 1.4
not vwap.side == -1
market.gapPoints is null
```

Operadores: `> >= < <= == != =`, `and`, `or`, `not`, `between … and …`,
`in (…)`, `is null`. `and` tiene más precedencia que `or`; los paréntesis
mandan.

## Por qué el predicado es un árbol de datos

El texto se compila a un AST serializable, no a una función. Eso permite:

- guardarlo en la base y volver a evaluarlo meses después;
- contar y enumerar el espacio de búsqueda del motor de descubrimiento;
- inspeccionar qué variables usa y bloquear las de resultado;
- editarlo desde una interfaz visual;
- traducirlo a SQL cuando convenga filtrar en la base.

```ts
and(eq("time.minuteOfDay", 570), gt("volatility.atr", 18))
// { type: "and", operands: [
//   { type: "compare", variable: "time.minuteOfDay", op: "==", value: 570 },
//   { type: "compare", variable: "volatility.atr",   op: ">",  value: 18  }]}
```

## Semántica de nulos

Cualquier comparación con `null` es **falsa**, igual que en SQL. Sólo `is null`
los selecciona.

Es importante: una operación en la que la EMA200 aún no había calentado tiene
`trend.ema200 = null`. Si `null` contara como 0, esa operación entraría en la
cohorte "precio muy por encima de la EMA" y contaminaría el resultado. Aquí no
entra en ninguna de las dos ramas, y el análisis marginal le dedica un tramo
propio ("sin valor") para que se vea cuántas son.

## Máscaras de bits

Un predicado se compila a `Uint8Array` recorriendo **columnas enteras**, no
filas. Con 1M de operaciones y tres condiciones: tres bucles sobre arrays
contiguos, en lugar de tres millones de llamadas a función.

Las máscaras se reutilizan: el motor de descubrimiento intersecta máscaras ya
calculadas en vez de reevaluar los predicados hijos.

## Métricas de cohorte

```
Operaciones        1.238   (ganadoras 812 / perdedoras 426)
Win rate           65.6%   IC95% [62.9%, 68.2%]
Profit factor      1.84
Expectancy         6.42 por operación
Payoff             0.97   (media ganadora 18.3 / perdedora 18.9)
Drawdown máximo    412.0   (18.4%, 37 operaciones)
Rachas             11 ganadoras / 7 perdedoras seguidas
Sharpe por op.     0.181   Sortino 0.264
Estabilidad (R²)   0.947   ← equity contra una recta; alto = edge constante
t / p-valor        6.37 / <0.0001
```

Tres números merecen atención especial:

**El intervalo de Wilson**, no el normal. Con win rates extremos (>90%, que es
justo lo que busca el motor de descubrimiento) el intervalo de Wald da límites
absurdos, incluso por encima de 1. Wilson se comporta bien en las colas. La cota
**inferior** es la que hay que mirar: es el peor caso razonable.

**La estabilidad (R²)** de la curva de equity contra una recta. Un edge real
sube de forma constante. Un "edge" que viene de tres operaciones enormes da R²
bajo aunque el Profit Factor sea espectacular. Es uno de los mejores detectores
de sobreajuste que existen y cuesta cuatro sumas.

**El profit factor infinito** (sin operaciones perdedoras) es sospechoso, no
excelente. Casi siempre significa una muestra minúscula o un filtro que mira al
futuro.

## Análisis marginal

```bash
pnpm trf analyze:marginal --split train --detail
```

Divide la población en tramos según cada variable y mide cada uno. Es el paso
previo obligatorio a combinar: antes de buscar conjunciones conviene saber qué
variables tienen señal por sí solas y con qué forma (monótona, en U, un solo
tramo bueno).

Los cortes salen de los datos, no de números redondos elegidos a mano.
"ATR > 18" es un umbral arbitrario; "ATR en el quintil superior" es una pregunta
con sentido estadístico. Las variables categóricas se trocean por valor y las
continuas por cuantiles, salvo que su definición declare cortes explícitos.

La salida incluye un **q-valor** ya corregido por Benjamini-Hochberg sobre el
número de variables examinadas. Si miras 40 variables, dos parecerán
significativas al 5% por puro azar; el q-valor lo tiene en cuenta.

## Estabilidad entre mitades

Cada análisis de cohorte parte el split por la mitad temporal y muestra ambas.

Es la prueba de robustez más barata que existe: si un patrón funciona en la
primera mitad del entrenamiento y desaparece en la segunda, no hace falta gastar
el dataset de validación para descartarlo. El CLI avisa cuando el win rate se
mueve más de diez puntos entre mitades.

## Matriz columnar

`loadFeatureMatrix` lee la base **una vez** proyectando sólo las columnas
pedidas, y las guarda en `Float64Array`. A partir de ahí, evaluar predicados es
recorrer números contiguos.

Coste: 8 bytes por valor. Un millón de operaciones × 30 variables = 240 MB. Por
eso la lista de variables es explícita: se cargan las que se van a usar, no
todas. Eso es lo que significa "no cargar toda la base en memoria" — se carga
una proyección acotada, elegida por el analista.

Los nulos van en un `Uint8Array` aparte y no como `NaN`, porque `NaN` se propaga
en silencio por las comparaciones y acaba contando como "condición falsa" sin
que nadie sepa cuántas filas se perdieron.

## El simulador

Convierte una señal en una operación cerrada recorriendo las velas siguientes
una sola vez, midiendo el recorrido por el camino.

Tres reglas que lo hacen honesto:

1. **Entrada en la apertura de la vela siguiente** a la señal.
2. **Ambigüedad intrabar resuelta en contra.** Si una vela toca el take profit y
   el stop loss, no sabemos en qué orden ocurrió: se asume que saltó el stop. Es
   la hipótesis pesimista, y es la correcta — la alternativa infla los
   resultados justo en las velas volátiles, que son las que más importan.
3. **Costes siempre.** Spread y deslizamiento empeoran la entrada, nunca la
   mejoran; la comisión se resta del resultado. Un backtest intradía sin costes
   no es optimista, es falso.

Variables de recorrido que produce: MAE, MFE, minutos hasta cada uno, velocidad
máxima, pendiente por regresión, número de retrocesos y eficiencia (qué parte
del movimiento favorable disponible se capturó). Todas son `outcome`: sirven
para diseñar stops y objetivos, nunca para filtrar entradas.

## Modo diagnóstico

```bash
pnpm trf analyze:cohort --split train --where "mae < 25" --diagnostic
```

Permite variables de resultado. Es un uso legítimo y distinto: *"¿cómo se
reparte el MAE de las operaciones que ya he seleccionado?"* es la pregunta
correcta para dimensionar un stop loss.

Lo que nunca se permite es que esa respuesta se convierta en una condición de
entrada. Por eso hay que pedirlo explícitamente, y por eso el CLI lo recuerda en
la salida.
