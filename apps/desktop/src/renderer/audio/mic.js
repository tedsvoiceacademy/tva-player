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

/* THE MOST CHANNELS ANY ONE DEVICE IS ASKED FOR.
 *
 * Eight rather than "as many as it has" for two reasons that are both real: a
 * strip of live waveforms stops being readable somewhere past eight lanes, and
 * every extra channel is another file being written for the whole of a lesson.
 * An interface with more inputs than this still works — the first eight are
 * taken and the app says so. */
export const MAX_MIC_CHANNELS = 8;

/* Open a microphone, taking every input it will give rather than one.
 *
 * WINDOWS DECIDES, NOT US. Asking for eight channels from a two-input interface
 * returns two, and asking a class-compliant four-input box for eight may return
 * four or may return two, depending on the driver. So the number that came back
 * is read from the track and reported, and everything downstream is built from
 * THAT number rather than from what was asked for. An interface that only ever
 * offers a stereo pair is not a failure here; it is an answer.
 *
 * The three processing switches stay off for the reason at the top of this
 * file, and there is a second reason now: Chromium's audio processing runs in
 * mono, so leaving any of them on collapses a four-microphone interface to one
 * channel before the app ever sees it.
 */
export async function openMic(deviceId, { channels = MAX_MIC_CHANNELS } = {}) {
  const wanted = Math.max(1, Math.min(MAX_MIC_CHANNELS, channels));
  const base = {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...base, channelCount: { ideal: wanted } },
    });
  } catch {
    /* A driver that refuses a channel count outright rather than narrowing it.
       Falling back to one channel keeps a working microphone, which matters far
       more than the extra inputs. */
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, channelCount: 1 } });
  }

  const track = stream.getAudioTracks()[0];
  const got = track?.getSettings?.() ?? {};
  const ignored = [];
  if (got.echoCancellation === true) ignored.push('echo cancellation');
  if (got.noiseSuppression === true) ignored.push('noise reduction');
  if (got.autoGainControl === true) ignored.push('automatic volume');

  const channelCount = Math.max(1, Math.min(MAX_MIC_CHANNELS, Number(got.channelCount) || 1));

  return {
    stream,
    label: track?.label ?? 'Microphone',
    sampleRate: got.sampleRate ?? null,
    /** How many microphones this device actually handed over. */
    channels: channelCount,
    /** What was asked for, so the difference can be said out loud. */
    asked: wanted,
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
