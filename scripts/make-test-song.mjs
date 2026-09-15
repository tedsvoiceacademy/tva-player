/* A song with known contents, so an end-to-end test can check what came out.
   Left side 440 Hz, right side 660 Hz — different on purpose, so the balance
   control and the lead-quieter tail can each be told apart by ear or by maths. */
import { writeFileSync } from 'node:fs';

export function makeSong(path, { seconds = 6, sampleRate = 48000, left = 440, right = 660 } = {}) {
  const frames = seconds * sampleRate;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const l = Math.sin(2 * Math.PI * left * i / sampleRate) * 0.4;
    const r = Math.sin(2 * Math.PI * right * i / sampleRate) * 0.4;
    data.writeInt16LE(Math.round(l * 32767), i * 4);
    data.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28); header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}

if (process.argv[2]) { makeSong(process.argv[2]); console.log('wrote', process.argv[2]); }
