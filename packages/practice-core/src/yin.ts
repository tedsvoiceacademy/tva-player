/**
 * YIN pitch detection — the method voice tools actually use.
 *
 * Picking the tallest peaks out of a spectrum is the wrong tool for a voice.
 * It cannot tell a note from a fan, so it has to be propped up by a loudness
 * gate, and a loudness gate cannot work: a hall's air handling sits where a
 * studio's silence does, and a singer who is already singing when the app opens
 * looks exactly like a noisy room.
 *
 * YIN asks a different question: how *periodic* is this sound? It slides the
 * waveform against itself and finds the delay at which it best repeats. A sung
 * note repeats almost perfectly; a fan, a hiss or a room never does. That gives
 * both the pitch and — from how well it repeated — a confidence that stands on
 * its own, with no reference to how loud anything is.
 *
 * From de Cheveigné & Kawahara (2002), with the standard steps: the difference
 * function, cumulative mean normalisation (which removes the bias toward zero
 * lag that makes plain autocorrelation choose octaves), an absolute threshold,
 * and parabolic interpolation for sub-sample precision.
 *
 * PORTED VERBATIM from the Rehearsal Ring Meter (ring-meter/src/dsp/yin.ts).
 * Nothing about it is specific to that app, and re-deriving pitch detection
 * would only produce a second thing to be wrong.
 */

export interface YinResult {
  hz: number
  /**
   * 0..1, higher is better. This is 1 − aperiodicity: how completely the
   * waveform repeated at the chosen period.
   */
  confidence: number
}

/**
 * How deep a dip must be to count as the period.
 *
 * This is a margin, not a quality bar — whether a sound is a note at all is
 * decided separately, by the confidence. Set too tight it becomes an octave
 * generator: a real sung note whose dip reached 0.158 was rejected against a
 * limit of 0.15, so the search carried on and found the far deeper dip an
 * octave below, reporting a tenor as a bass with total confidence. Vibrato
 * alone is enough to lift a true dip that far.
 */
export const YIN_THRESHOLD = 0.2

export function detectPitchYin(
  samples: Float32Array,
  sampleRate: number,
  minHz = 65,
  maxHz = 1000,
  threshold = YIN_THRESHOLD,
): YinResult | null {
  const maxTau = Math.min(Math.floor(sampleRate / minHz), Math.floor(samples.length / 2))
  const minTau = Math.max(2, Math.floor(sampleRate / maxHz))
  if (maxTau <= minTau) return null

  // Step 1: the difference function. How different is the waveform from itself,
  // delayed by tau? At the true period this collapses towards zero.
  const diff = new Float32Array(maxTau + 1)
  const n = samples.length - maxTau
  if (n <= 0) return null
  // From tau = 1, not from the shortest period we care about: the normalisation
  // below divides by the running mean of everything so far, so starting it late
  // corrupts it — and a corrupted normalisation is exactly what lets a note be
  // reported an octave low, since a wave that repeats every T also repeats
  // every 2T.
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      const d = samples[i] - samples[i + tau]
      sum += d * d
    }
    diff[tau] = sum
  }

  // Step 2: cumulative mean normalisation.
  const cmnd = new Float32Array(maxTau + 1)
  cmnd[0] = 1
  let running = 0
  for (let tau = 1; tau <= maxTau; tau++) {
    running += diff[tau]
    cmnd[tau] = running === 0 ? 1 : (diff[tau] * tau) / running
  }

  // Step 3: the first dip below the threshold, not the deepest — taking the
  // deepest is what produces octave errors, since a period of 2T also repeats.
  // It must be a genuine local minimum, not merely the first sample under the
  // line. Walking downhill from wherever the curve first crosses can slide
  // straight past the true period into the dip an octave below it, and report
  // a tenor as a bass with complete confidence — a wave that repeats every T
  // repeats every 2T just as faithfully.
  let tau = -1
  for (let t = minTau + 1; t < maxTau; t++) {
    if (cmnd[t] < threshold && cmnd[t] <= cmnd[t - 1] && cmnd[t] <= cmnd[t + 1]) {
      tau = t
      break
    }
  }
  if (tau === -1) {
    // Nothing was periodic enough. Report the best on offer so a caller can see
    // how far off it was, but only if it is at least somewhat periodic.
    let best = minTau
    for (let t = minTau; t <= maxTau; t++) if (cmnd[t] < cmnd[best]) best = t
    if (cmnd[best] >= 1) return null
    return { hz: sampleRate / best, confidence: Math.max(0, 1 - cmnd[best]) }
  }

  // Step 4: parabolic interpolation around the dip, for a period between samples.
  const x0 = tau > minTau ? tau - 1 : tau
  const x2 = tau + 1 <= maxTau ? tau + 1 : tau
  let betterTau = tau
  if (x0 !== tau && x2 !== tau) {
    const s0 = cmnd[x0]
    const s1 = cmnd[tau]
    const s2 = cmnd[x2]
    const denom = 2 * (2 * s1 - s2 - s0)
    if (denom !== 0) betterTau = tau + (s2 - s0) / denom
  }

  const hz = sampleRate / betterTau
  if (!(hz > 0) || hz < minHz || hz > maxHz) return null
  return { hz, confidence: Math.max(0, Math.min(1, 1 - cmnd[tau])) }
}
