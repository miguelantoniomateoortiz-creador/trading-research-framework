/**
 * Generador pseudoaleatorio determinista.
 *
 * Toda aleatoriedad del framework (bootstrap, permutation tests, generación de
 * datos sintéticos) pasa por aquí con semilla explícita. Un experimento de
 * investigación que no es reproducible no es un experimento.
 */

export interface Rng {
  /** Uniforme en [0, 1). */
  next(): number;
  /** Entero uniforme en [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** Normal estándar (Box-Muller). */
  nextGaussian(): number;
}

/** mulberry32: rápido, periodo 2^32, calidad suficiente para remuestreo. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  let spareGaussian: number | null = null;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    nextInt(maxExclusive: number): number {
      return Math.floor(next() * maxExclusive);
    },
    nextGaussian(): number {
      if (spareGaussian !== null) {
        const value = spareGaussian;
        spareGaussian = null;
        return value;
      }
      let u = 0;
      let v = 0;
      let s = 0;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const factor = Math.sqrt((-2 * Math.log(s)) / s);
      spareGaussian = v * factor;
      return u * factor;
    },
  };
}
