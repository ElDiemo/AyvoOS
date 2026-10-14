/**
 * Short audible feedback for scanner work (doc 026): one high tone for success, two low tones
 * for a refusal. Always paired with visible text — sound is never the only signal. Silently does
 * nothing where audio is unavailable or blocked.
 */
let context: AudioContext | null = null;

function tone(frequency: number, startAt: number, duration: number) {
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = frequency;
  gain.gain.value = 0.08;
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(context.currentTime + startAt);
  oscillator.stop(context.currentTime + startAt + duration);
}

export function scanFeedback(kind: 'ok' | 'error'): void {
  try {
    context ??= new AudioContext();
    if (kind === 'ok') tone(1046, 0, 0.12);
    else {
      tone(330, 0, 0.15);
      tone(262, 0.2, 0.2);
    }
  } catch {
    // no audio: the visible result is the signal
  }
}
