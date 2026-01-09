/**
 * SignalAnalyzer - Analyze and compare audio signals
 *
 * Verifies that audio data passes through the voice pipeline correctly:
 * - Energy/level measurement
 * - Frequency detection
 * - Signal correlation
 * - Round-trip verification
 */

import { VOICE_SAMPLE_RATE, VOICE_FRAME_SAMPLES } from '../types.js';

/**
 * Signal analysis results
 */
export interface SignalAnalysis {
  rmsLevel: number;           // RMS amplitude (0-32767)
  peakLevel: number;          // Peak amplitude
  dominantFrequency: number;  // Estimated dominant frequency in Hz
  zeroCrossings: number;      // Zero crossing count
  isSilence: boolean;         // True if below noise floor
  energyDb: number;           // Energy in dB
}

/**
 * Comparison results between two signals
 */
export interface SignalComparison {
  correlation: number;        // -1 to 1, correlation coefficient
  levelMatch: number;         // 0 to 1, how close the levels are
  frequencyMatch: number;     // 0 to 1, how close the frequencies are
  overallMatch: number;       // 0 to 1, combined score
  passed: boolean;            // True if signals match within tolerance
}

/**
 * Analyze a single audio frame
 */
export function analyzeFrame(samples: Int16Array): SignalAnalysis {
  if (samples.length === 0) {
    return {
      rmsLevel: 0,
      peakLevel: 0,
      dominantFrequency: 0,
      zeroCrossings: 0,
      isSilence: true,
      energyDb: -100,
    };
  }

  // Calculate RMS level
  let sumSquares = 0;
  let peak = 0;
  let zeroCrossings = 0;
  let prevSample = samples[0];

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    sumSquares += sample * sample;

    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;

    if (i > 0 && ((prevSample >= 0 && sample < 0) || (prevSample < 0 && sample >= 0))) {
      zeroCrossings++;
    }
    prevSample = sample;
  }

  const rmsLevel = Math.sqrt(sumSquares / samples.length);
  const energyDb = rmsLevel > 0 ? 20 * Math.log10(rmsLevel / 32767) : -100;

  // Estimate frequency from zero crossings
  // Each complete cycle has 2 zero crossings
  const durationSec = samples.length / VOICE_SAMPLE_RATE;
  const dominantFrequency = zeroCrossings / (2 * durationSec);

  // Consider silence if below -50dB
  const isSilence = energyDb < -50;

  return {
    rmsLevel,
    peakLevel: peak,
    dominantFrequency,
    zeroCrossings,
    isSilence,
    energyDb,
  };
}

/**
 * Analyze multiple frames and return aggregate statistics
 */
export function analyzeFrames(frames: Int16Array[]): {
  avgRms: number;
  avgFrequency: number;
  peakLevel: number;
  silentFrames: number;
  activeFrames: number;
  avgEnergyDb: number;
} {
  if (frames.length === 0) {
    return { avgRms: 0, avgFrequency: 0, peakLevel: 0, silentFrames: 0, activeFrames: 0, avgEnergyDb: -100 };
  }

  let totalRms = 0;
  let totalFreq = 0;
  let peak = 0;
  let silentFrames = 0;
  let activeFrames = 0;
  let totalEnergyDb = 0;

  for (const frame of frames) {
    const analysis = analyzeFrame(frame);
    totalRms += analysis.rmsLevel;
    totalFreq += analysis.dominantFrequency;
    if (analysis.peakLevel > peak) peak = analysis.peakLevel;
    if (analysis.isSilence) {
      silentFrames++;
    } else {
      activeFrames++;
    }
    totalEnergyDb += analysis.energyDb;
  }

  return {
    avgRms: totalRms / frames.length,
    avgFrequency: totalFreq / frames.length,
    peakLevel: peak,
    silentFrames,
    activeFrames,
    avgEnergyDb: totalEnergyDb / frames.length,
  };
}

/**
 * Compare two signals for similarity
 */
export function compareSignals(
  original: Int16Array,
  received: Int16Array,
  tolerance: { levelDb: number; frequencyHz: number } = { levelDb: 20, frequencyHz: 100 }
): SignalComparison {
  const origAnalysis = analyzeFrame(original);
  const recvAnalysis = analyzeFrame(received);

  // Level match (in dB)
  const levelDiffDb = Math.abs(origAnalysis.energyDb - recvAnalysis.energyDb);
  const levelMatch = Math.max(0, 1 - levelDiffDb / tolerance.levelDb);

  // Frequency match
  const freqDiff = Math.abs(origAnalysis.dominantFrequency - recvAnalysis.dominantFrequency);
  const frequencyMatch = Math.max(0, 1 - freqDiff / tolerance.frequencyHz);

  // Correlation coefficient (simplified - just compare normalized samples)
  let correlation = 0;
  if (!origAnalysis.isSilence && !recvAnalysis.isSilence) {
    const minLen = Math.min(original.length, received.length);
    let sumXY = 0, sumX2 = 0, sumY2 = 0;

    for (let i = 0; i < minLen; i++) {
      const x = original[i] / 32767;
      const y = received[i] / 32767;
      sumXY += x * y;
      sumX2 += x * x;
      sumY2 += y * y;
    }

    const denom = Math.sqrt(sumX2 * sumY2);
    correlation = denom > 0 ? sumXY / denom : 0;
  } else if (origAnalysis.isSilence && recvAnalysis.isSilence) {
    correlation = 1;  // Both silent = match
  }

  // Overall match score
  const overallMatch = (levelMatch * 0.4 + frequencyMatch * 0.4 + Math.abs(correlation) * 0.2);

  // Pass if overall score is above threshold
  const passed = overallMatch > 0.5;

  return {
    correlation,
    levelMatch,
    frequencyMatch,
    overallMatch,
    passed,
  };
}

/**
 * Generate a reference frame for known test signal
 */
export function generateReferenceFrame(
  frequency: number,
  amplitude: number,
  frameIndex: number
): Int16Array {
  const samples = new Int16Array(VOICE_FRAME_SAMPLES);
  const startSample = frameIndex * VOICE_FRAME_SAMPLES;

  for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
    const t = (startSample + i) / VOICE_SAMPLE_RATE;
    samples[i] = Math.round(Math.sin(2 * Math.PI * frequency * t) * amplitude * 32767);
  }

  return samples;
}

/**
 * Verify a received signal matches expected characteristics
 */
export interface SignalVerification {
  passed: boolean;
  expectedFrequency: number;
  measuredFrequency: number;
  frequencyError: number;
  expectedLevelDb: number;
  measuredLevelDb: number;
  levelError: number;
  details: string;
}

export function verifySignal(
  samples: Int16Array,
  expectedFrequency: number,
  expectedAmplitude: number,
  toleranceFreqHz: number = 50,
  toleranceLevelDb: number = 15
): SignalVerification {
  const analysis = analyzeFrame(samples);

  const expectedLevelDb = 20 * Math.log10(expectedAmplitude);
  const frequencyError = Math.abs(analysis.dominantFrequency - expectedFrequency);
  const levelError = Math.abs(analysis.energyDb - expectedLevelDb);

  const frequencyOk = frequencyError <= toleranceFreqHz;
  const levelOk = levelError <= toleranceLevelDb;
  const passed = frequencyOk && levelOk && !analysis.isSilence;

  let details = '';
  if (!passed) {
    if (analysis.isSilence) {
      details = 'Signal is silent';
    } else if (!frequencyOk) {
      details = `Frequency off by ${frequencyError.toFixed(1)}Hz`;
    } else if (!levelOk) {
      details = `Level off by ${levelError.toFixed(1)}dB`;
    }
  } else {
    details = 'Signal matches expected characteristics';
  }

  return {
    passed,
    expectedFrequency,
    measuredFrequency: analysis.dominantFrequency,
    frequencyError,
    expectedLevelDb,
    measuredLevelDb: analysis.energyDb,
    levelError,
    details,
  };
}

/**
 * Print signal analysis in a readable format
 */
export function formatAnalysis(analysis: SignalAnalysis): string {
  return `RMS: ${analysis.rmsLevel.toFixed(0)} (${analysis.energyDb.toFixed(1)}dB), ` +
    `Peak: ${analysis.peakLevel}, Freq: ${analysis.dominantFrequency.toFixed(0)}Hz, ` +
    `Silent: ${analysis.isSilence}`;
}
