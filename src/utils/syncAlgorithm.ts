/**
 * Computes the optimal HTML5 playbackRate to correct temporal drift between two clients.
 * 
 * Algorithm:
 * - If latency > 1.0s: The drift is too large to smooth out. Requires a hard seek.
 * - If latency > 0.1s: The drift is noticeable but correctable. Dynamically alter speed.
 * - If latency <= 0.1s: Imperceptible drift. Maintain normal playback.
 * 
 * @param hostTime The authoritative playback time from the host (in seconds)
 * @param localTime The local client's current playback time (in seconds)
 * @param baseRate The host's current playback rate (usually 1.0)
 * @returns An object containing the recommended `playbackRate` and whether a `hardSeek` is required.
 */
export function calculateDriftCorrection(
  hostTime: number,
  localTime: number,
  baseRate: number = 1.0
): { playbackRate: number; hardSeek: boolean; seekTime?: number } {
  const drift = hostTime - localTime;
  const absDrift = Math.abs(drift);

  if (absDrift > 1.0) {
    // Severe desynchronization
    return { playbackRate: baseRate, hardSeek: true, seekTime: hostTime };
  } else if (absDrift > 0.1) {
    // Smooth correction phase
    return { 
      playbackRate: drift > 0 ? baseRate + 0.02 : baseRate - 0.02, 
      hardSeek: false 
    };
  } else {
    // Locked in sync
    return { playbackRate: baseRate, hardSeek: false };
  }
}
