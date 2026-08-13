# ADR-0002 · Monorepo pnpm con paquetes internos sin build

**Estado:** aceptado · **Fecha:** 2026-08

## Contexto

La estructura pedida inicialmente era plana:

```
/frontend /backend /database /importer /analyzer /plugins /shared /config /docs
```

## Problema

Esas carpetas comparten tipos (`Bar`, `Trade`, `VariableDefinition`),
configuración de TypeScript y utilidades. Como directorios independientes, o se
duplica todo o se importan por rutas relativas frágiles del tipo
`../../../shared/src/types`. Ambas cosas se degradan rápido, y este proyecto
está pensado para durar años.

Añadido: los plugins deben poder importar el SDK por nombre
(`@trf/plugin-sdk`), no por ruta relativa, porque el día que un plugin viva
fuera del repo la ruta deja de existir.

## Decisión

Monorepo con workspaces de pnpm:

```
apps/{cli,api,web}
packages/{shared,database,plugin-sdk,importer,analyzer}
plugins/*
```

Se conservan todos los módulos que pediste; cambian de sitio, no de existencia.

Los paquetes internos se consumen **como código fuente TypeScript**
(`"main": "./src/index.ts"`), sin paso de compilación entre ellos. Se ejecutan
con `tsx` y se comprueban con `tsc --noEmit`.

- ✅ Cero orquestación de builds durante el desarrollo.
- ✅ Ir a la definición lleva al código real, no a un `.d.ts`.
- ✅ Un cambio en `shared` se ve al instante en todos los paquetes.
- ⚠️ Para desplegar fuera del repo habría que compilar. No aplica: esto corre en
  localhost.

## Consecuencias

- Correspondencia con lo que pediste: `/backend` → `apps/api` + `apps/cli`,
  `/frontend` → `apps/web`, `/database` → `packages/database`, `/importer` →
  `packages/importer`, `/analyzer` → `packages/analyzer`, `/shared` →
  `packages/shared`, `/plugins` → `plugins/` (sin cambios), `/config` →
  `tsconfig.base.json` + configuración por paquete.
- `pnpm test` y `pnpm typecheck` cubren todo el repo de una vez.
