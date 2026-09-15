const log = (...a) => console.log(a.join(" "));
const SR = 48000, SECS = 2, F0 = 440, RATE = 0.75, SEMIS = 2;

function pitchHz(buf, sr) {           // plain autocorrelation, enough to identify a sine
  let best = 0, bestLag = 0;
  const lo = Math.floor(sr / 1200), hi = Math.floor(sr / 200), N = Math.min(buf.length, sr);
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0; for (let i = 0; i + lag < N; i++) s += buf[i] * buf[i + lag];
    if (s > best) { best = s; bestLag = lag; }
  }
  return bestLag ? sr / bestLag : 0;
}

try {
  // A known 440 Hz tone, stereo, built in code — no file, no network.
  const inLen = SR * SECS;
  const chans = [new Float32Array(inLen), new Float32Array(inLen)];
  for (let i = 0; i < inLen; i++) {
    const v = Math.sin(2 * Math.PI * F0 * i / SR) * 0.5;
    chans[0][i] = v; chans[1][i] = v;
  }

  const outLen = Math.ceil(inLen / RATE) + SR;   // slower playback => longer output
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: outLen, sampleRate: SR });

  const mod = await import('./node_modules/signalsmith-stretch/SignalsmithStretch.mjs');
  const stretch = await mod.default(ctx, { numberOfInputs: 0, outputChannelCount: [2] });
  log('worklet + wasm loaded under CSP');

  await stretch.addBuffers(chans);
  stretch.connect(ctx.destination);
  stretch.schedule({ active: true, input: 0, rate: RATE, semitones: SEMIS,
                     formantCompensation: true, formantBaseHz: 0 });

  const rendered = await ctx.startRendering();
  const out = rendered.getChannelData(0);

  let peak = 0; for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const mid = out.slice(Math.floor(SR * 0.6), Math.floor(SR * 1.6));
  const hz = pitchHz(mid, SR);
  const want = F0 * Math.pow(2, SEMIS / 12);
  const cents = 1200 * Math.log2(hz / want);

  log(`peak ${peak.toFixed(3)}  pitch ${hz.toFixed(1)} Hz  wanted ${want.toFixed(1)} Hz  (${cents.toFixed(1)} cents off)`);

  const ok = peak > 0.05 && Math.abs(cents) < 50;
  log(`SPIKE-DONE ${ok ? 'PASS' : 'FAIL'}`);
} catch (e) {
  log('SPIKE-DONE FAIL: ' + (e && e.stack || e));
}
