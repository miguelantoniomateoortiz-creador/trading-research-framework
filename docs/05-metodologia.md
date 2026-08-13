# Metodología: cómo no engañarse

La parte difícil de este oficio no es encontrar patrones. Es distinguir los que
existen de los que has fabricado sin querer. Este documento recoge las cuatro
trampas principales y qué hace la plataforma contra cada una.

---

## 1. Lookahead: usar información que no tendrías

### El caso del enunciado

```
Hora = 9:30 AND ATR > 18 AND MAE < 25
```

Las dos primeras condiciones son legítimas. La tercera no: el MAE es la máxima
excursión adversa y sólo se conoce **cuando la operación ha cerrado**. Filtrar
por él equivale a *"quédate sólo con las operaciones que no se pusieron feas"*.

Ese filtro da un win rate del 95% y es imposible de operar, porque a las 9:30 no
sabes cuál será el MAE.

### Defensas

- Cada variable declara `causality`; el motor lanza `LookaheadError` ante una
  variable de resultado en una hipótesis.
- Los plugins reciben una `MarketView` sellada que sólo devuelve velas ya
  cerradas. La API no expone el dato del futuro, así que el error no se puede
  escribir.
- Las entradas se abren en la apertura de la vela **siguiente** a la señal.
- El motor recorre el histórico en un orden fijo (ver `docs/00-arquitectura.md`).

---

## 2. Multiplicidad: buscar hasta encontrar

Si pruebas 10.000 combinaciones con α = 0,05, unas 500 saldrán "significativas"
por puro azar. Ninguna funcionará en real.

Peor aún: cuantas más variables tengas, más rápido crece el problema. Con 40
variables y 5 cortes cada una hay 200 condiciones simples, 19.900 pares y más de
un millón de tríos. Un motor de descubrimiento que enumere tríos hará más de un
millón de pruebas, y encontrará "patrones" con un win rate del 95% en datos
puramente aleatorios.

### Defensas

- **Benjamini-Hochberg** en `analyze:marginal`: el q-valor ya está corregido por
  el número de variables examinadas.
- **`hypotheses.searchSpaceSize`**: cada hipótesis guarda cuántas combinaciones
  se probaron para encontrarla. Sin ese número, su p-valor no significa nada.
- Cuando llegue el nivel 6, el motor de descubrimiento **debe** reportar el
  tamaño del espacio explorado junto a cada resultado. No es opcional.

### Regla práctica

Antes de mirar un resultado, calcula cuántas cosas has probado. Si son N, exige
un p-valor menor que 0,05/N para emocionarte (Bonferroni), o mira el q-valor
directamente.

---

## 3. Sobreajuste: describir el ruido de tu muestra

Un patrón con 60 operaciones y cuatro condiciones no es un patrón; es una
descripción de esas 60 operaciones.

### Defensas

- **Estabilidad (R²)** de la curva de equity contra una recta. Un edge real sube
  constante; uno que viene de tres operaciones enormes da R² bajo aunque el
  Profit Factor sea espectacular.
- **División por mitades**, automática en cada `analyze:cohort`. Si el win rate
  se mueve más de diez puntos entre la primera y la segunda mitad del
  entrenamiento, el CLI avisa. Descartar aquí no cuesta nada; descartar en
  validación gasta el dataset.
- **Intervalo de Wilson**: mira siempre la cota inferior. Un 94% con 40
  operaciones tiene una cota inferior del 82%; con 4.000, del 93%.

### Reglas prácticas

- Mínimo 300-500 operaciones por cohorte para tomarla en serio. Menos de 100, ni
  mirarla.
- Como mucho 3 condiciones. Cada condición adicional multiplica el espacio de
  búsqueda y divide la muestra.
- Si no puedes explicar **por qué** el patrón debería existir, probablemente no
  existe. Una explicación mecánica (liquidez de apertura, cobertura de opciones,
  rebalanceo de fin de mes) no demuestra nada, pero su ausencia es una señal de
  alarma razonable.

---

## 4. Contaminación del dataset de validación

Si validas veinte hipótesis contra 2025, "pasó la validación" ya sólo significa
"fue la mejor de veinte". El periodo ha dejado de ser fuera de muestra sin que
nadie lo declarara.

### Defensas

- `createSplit` **rechaza** un split de validación que solape con el de
  entrenamiento, incluyendo los días de embargo.
- Cada evaluación incrementa `evaluationCount`. A partir de 10 usos el sistema
  avisa; a partir de 20, dice claramente que el periodo está agotado.
- Los análisis se ejecutan siempre contra un split **con nombre**. Hay que
  escribirlo, así que no se puede mirar la validación sin querer.

### El embargo

```bash
pnpm trf splits:create --name train --role training --from 2022-01-01 --to 2025-01-01 --embargo 5
pnpm trf splits:create --name val --role validation --from 2025-01-10 --to 2026-01-01
```

Cinco días entre ambos periodos. No es un capricho: una EMA200 en M1 arrastra
unos tres días de información, y una operación abierta el 31 de diciembre se
cierra en enero. Sin embargo, la frontera filtra.

### Protocolo

1. Explora **sólo** en entrenamiento. Todo lo que quieras.
2. Cierra la hipótesis por completo: predicado exacto, entrada, salida, costes.
3. Escríbela en `hypotheses` con sus criterios y su `searchSpaceSize`.
4. Ejecuta **una vez** contra validación.
5. Pase lo que pase, esa hipótesis está resuelta. Si no funcionó, no la
   "ajustes un poco" y vuelvas a validar: eso es entrenar sobre validación.

---

## Qué se puede concluir de verdad

Un patrón merece pasar a operativa cuando reúne, **todo a la vez**:

| Criterio | Umbral orientativo |
|---|---|
| Operaciones en entrenamiento | > 500 |
| Condiciones | ≤ 3 |
| Cota inferior del IC de Wilson | por encima del punto de equilibrio |
| Estabilidad R² | > 0,85 |
| Diferencia de win rate entre mitades | < 10 puntos |
| q-valor corregido por el espacio de búsqueda | < 0,05 |
| Rendimiento en validación | dentro del IC del entrenamiento |
| Explicación mecánica | existe y es plausible |

Y aun así, la mayoría fallará en real. Ese es el trabajo: descartar rápido y
barato para que lo poco que sobreviva merezca la pena.

---

## Calibración del instrumento

Antes de confiar en cualquier motor de descubrimiento, hay que comprobar dos
cosas con datos sintéticos:

```bash
# 1. ¿Encuentra un edge que sabemos que está?
pnpm trf data:generate --inject-pattern --seed 1
# ... importar, run, analizar. Debe aparecer.

# 2. ¿Se inventa edges donde no los hay?
pnpm trf data:generate --seed 2          # sin patrón
# ... importar, run, analizar. NO debería aparecer nada con q < 0.05.
```

La segunda prueba es la que casi nadie hace y la que más dice. Un motor que
encuentra patrones espectaculares en ruido puro está midiendo su propia
capacidad de sobreajustar, no el mercado.
