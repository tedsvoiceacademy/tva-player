/* The microphone, opened the way a voice tool has to open it.
 *
 * PORTED from ring-meter/src/audio/mic.ts, which calls this the app's single
 * most important technical rule and is right: echo cancellation, noise
 * suppression and automatic gain are all switched OFF. Every one of them is
 * built to make speech on a video call intelligible, and every one of them
 * changes the thing a singing teacher is trying to hear — automatic gain in
 * particular quietly flattens the difference between a soft phrase and a loud
 * one, which is often the whole point of the take.
 *
 * Browsers and audio-interface drivers both ignore that request sometimes, and
 * say nothing. So what actually happened is read back and reported.
 */

export async function listMicrophones() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({
      id: d.deviceId,
      // Before permission has been granted once, browsers hand back blank
      // labels. A number is at least something a person can choose between.
      label: d.label || `Microphone ${i + 1}`,
      labelled: Boolean(d.label),
    }));
}

export async function listOutputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audiooutput')
    .map((d, i) => ({
      id: d.deviceId,
      label: d.label || `Speakers ${i + 1}`,
      labelled: Boolean(d.label),
    }));
}

export async function openMic(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });

  const track = stream.getAudioTracks()[0];
  const got = track?.getSettings?.() ?? {};
  const ignored = [];
  if (got.echoCancellation === true) ignored.push('echo cancellation');
  if (got.noiseSuppression === true) ignored.push('noise reduction');
  if (got.autoGainControl === true) ignored.push('automatic volume');

  return {
    stream,
    label: track?.label ?? 'Microphone',
    sampleRate: got.sampleRate ?? null,
    /* Said in plain words wherever it is shown. Windows can re-apply all three
       beneath the browser, in the sound device's own properties. */
    processingWarning: ignored.length
      ? `Windows is still applying ${ignored.join(' and ')} to this microphone. `
        + 'Turn it off in Sound settings, under this microphone’s properties, '
        + 'or takes will not sound like the voice in the room.'
      : null,
  };
}

/* What the computer itself is playing — a Zoom lesson, a video, anything.
 *
 * Chromium will only offer system audio as part of a screen share, and will not
 * offer it at all unless video is also asked for, so a video track is requested
 * and thrown away immediately. Windows shows its screen-sharing indicator while
 * this runs, which is worth saying out loud so it does not read as a fault. */
export async function openSystemAudio() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  for (const track of stream.getVideoTracks()) track.stop();
  const audio = stream.getAudioTracks()[0];
  if (!audio) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error('Windows did not offer the computer’s sound. In the box that '
      + 'appears, choose a window or screen and tick "Also share system audio".');
  }
  return { stream, label: audio.label || 'This computer' };
}
