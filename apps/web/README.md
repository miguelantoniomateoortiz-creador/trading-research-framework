# apps/web — dashboard (nivel 8)

Dashboard en Next.js (App Router) sobre `@trf/api`. Construido DESPUÉS de que
el motor de análisis, discovery y validación (niveles 1-7) estuvieran
completos y verificados con datos reales — ver el motivo más abajo.

## Cómo arrancarlo

Dos terminales:

```bash
pnpm api          # API local en http://127.0.0.1:4319
pnpm web          # dashboard en http://localhost:3000
```

La primera vez, `pnpm install` en la raíz del repo instala también las
dependencias de este paquete (Next.js, React, Recharts, TanStack Table,
Tailwind).

## Por qué se construyó al final

El orden de construcción acordado fue: arquitectura → base de datos → plugins →
importador → motor de análisis → descubrimiento → validación → dashboard.

Una interfaz construida antes que el motor acaba dictando la forma del motor.
Se termina con endpoints que existen porque una pantalla los necesitaba, y con
lógica de análisis dentro de componentes de React. En un proyecto pensado para
durar años, eso es exactamente lo que impide cambiar de tecnología de frontend
sin reescribirlo todo.

Con el motor completo, el dashboard sólo tuvo que llamar y pintar: `apps/api`
es una capa finísima sobre `@trf/analyzer` y `@trf/database` (sin lógica de
negocio propia), y este paquete sólo llama a esa API.

## Estructura

```
apps/web/
├── app/
│   ├── layout.tsx                # navegación lateral, modo oscuro fijo
│   ├── page.tsx                  # panel: cobertura de datos y splits
│   ├── variables/page.tsx        # catálogo del registro, causalidad visible
│   ├── explore/page.tsx          # análisis marginal + probador de cohortes
│   ├── discovery/page.tsx        # Pattern Discovery (nivel 6)
│   ├── hypotheses/
│   │   ├── page.tsx              # guardar + listar hipótesis
│   │   └── [id]/page.tsx         # detalle: entrenamiento vs validación
│   └── plugins/page.tsx          # activar/desactivar y configurar plugins
├── components/
│   ├── metrics-card.tsx
│   ├── equity-chart.tsx          # Recharts
│   ├── cohort-table.tsx          # TanStack Table
│   ├── predicate-builder.tsx     # editor visual del AST de predicados
│   ├── split-picker.tsx
│   ├── causality-badge.tsx
│   └── status-badge.tsx
└── lib/
    ├── api.ts                    # cliente tipado de @trf/api
    └── format.ts
```

## Las tres reglas se cumplen así

1. **Cero lógica de análisis en componentes.** `lib/api.ts` sólo tipa y llama;
   todo cálculo vive en `@trf/analyzer` y se expone por `apps/api`. Los tipos
   compartidos (`Predicate`, `CohortMetrics`...) se importan con `import type`,
   así que se borran al compilar y ni una línea de lógica de servidor llega al
   navegador.
2. **La causalidad de cada variable siempre visible.** `causality-badge.tsx`
   marca `outcome` en rojo en el catálogo; `predicate-builder.tsx` sólo ofrece
   variables `predictor` en su selector. El servidor bloquea igual cualquier
   intento de saltárselo (`assertHypothesisSafe`).
3. **El botón de validación duele.** `hypotheses/[id]/page.tsx` exige una
   confirmación explícita en dos pasos: el primer click sólo pide el conteo de
   usos previos del split (`requiresConfirmation`), el segundo — con estilo de
   peligro — ejecuta la validación real, inmutable, sin vuelta atrás salvo
   crear una hipótesis nueva.
