/**
 * Headless SNR test for vocoder quality analysis
 *
 * Tests encode/decode quality and identifies where signal degradation occurs.
 */

import { VOICE_SAMPLE_RATE, VOICE_FRAME_SAMPLES } from '../voice/types.js';

// Test configuration
const TEST_DURATION_MS = 1000;  // 1 second of test signal
const NUM_FRAMES = Math.floor(TEST_DURATION_MS / 20);  // 20ms per frame

// Vocoder parameters to test (matching VocoderDebug)
interface TestParams {
  codecBytes: number;
  lpcOrder: number;
  preEmphasis: number;
  bwExpand: number;
  deEmphasis: number;
}

const HQ_PARAMS: TestParams = {
  codecBytes: 64,
  lpcOrder: 20,
  preEmphasis: 0.97,
  bwExpand: 0.994,
  deEmphasis: 0.97,
};

/**
 * Calculate SNR in dB
 */
function calculateSNR(original: Float32Array, reconstructed: Float32Array): number {
  let signalPower = 0;
  let noisePower = 0;

  const len = Math.min(original.length, reconstructed.length);

  for (let i = 0; i < len; i++) {
    signalPower += original[i] * original[i];
    const error = original[i] - reconstructed[i];
    noisePower += error * error;
  }

  if (noisePower < 1e-10) return 100; // Perfect reconstruction
  if (signalPower < 1e-10) return -100; // No signal

  return 10 * Math.log10(signalPower / noisePower);
}

/**
 * Calculate correlation coefficient
 */
function calculateCorrelation(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);

  let sumA = 0, sumB = 0;
  for (let i = 0; i < len; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / len;
  const meanB = sumB / len;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < len; i++) {
    const dA = a[i] - meanA;
    const dB = b[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }

  if (varA < 1e-10 || varB < 1e-10) return 0;
  return cov / Math.sqrt(varA * varB);
}

/**
 * Generate a test tone (sine wave)
 */
function generateSineWave(freq: number, amplitude: number, numSamples: number): Float32Array {
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = amplitude * Math.sin(2 * Math.PI * freq * i / VOICE_SAMPLE_RATE);
  }
  return samples;
}

/**
 * Generate a vowel-like formant signal (more realistic speech test)
 */
function generateVowelFormants(f0: number, formants: number[], amplitude: number, numSamples: number): Float32Array {
  const samples = new Float32Array(numSamples);

  // Generate glottal pulse train at f0
  const period = Math.round(VOICE_SAMPLE_RATE / f0);

  for (let i = 0; i < numSamples; i++) {
    // Glottal pulse - simple model
    const phaseInPeriod = i % period;
    const phaseNorm = phaseInPeriod / period;

    // Glottal waveform (LF model simplified)
    let glottal = 0;
    if (phaseNorm < 0.4) {
      glottal = Math.sin(phaseNorm * Math.PI / 0.4);
    } else if (phaseNorm < 0.6) {
      glottal = Math.cos((phaseNorm - 0.4) * Math.PI / 0.4);
    }

    samples[i] = glottal * amplitude;
  }

  // Apply formant filters (simple resonators)
  for (const formant of formants) {
    const filtered = new Float32Array(numSamples);
    const bw = formant * 0.1; // 10% bandwidth
    const r = Math.exp(-Math.PI * bw / VOICE_SAMPLE_RATE);
    const theta = 2 * Math.PI * formant / VOICE_SAMPLE_RATE;
    const a1 = -2 * r * Math.cos(theta);
    const a2 = r * r;

    let y1 = 0, y2 = 0;
    for (let i = 0; i < numSamples; i++) {
      const y0 = samples[i] - a1 * y1 - a2 * y2;
      filtered[i] = y0 * (1 - r);
      y2 = y1;
      y1 = y0;
    }
    samples.set(filtered);
  }

  // Normalize
  let maxVal = 0;
  for (let i = 0; i < numSamples; i++) {
    maxVal = Math.max(maxVal, Math.abs(samples[i]));
  }
  if (maxVal > 0) {
    for (let i = 0; i < numSamples; i++) {
      samples[i] = (samples[i] / maxVal) * amplitude;
    }
  }

  return samples;
}

/**
 * Generate white noise
 */
function generateNoise(amplitude: number, numSamples: number): Float32Array {
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = (Math.random() * 2 - 1) * amplitude;
  }
  return samples;
}

/**
 * LPC analysis using Levinson-Durbin
 * Returns both reflection coefficients and prediction coefficients
 */
function lpcAnalysis(samples: Float32Array, order: number, preEmphasis: number, bwExpand: number): {
  reflectionCoeffs: Float32Array;
  lpcCoeffs: Float32Array;
  gain: number;
  residualEnergy: number;
} {
  const N = samples.length;

  // Pre-emphasis
  const emphasized = new Float32Array(N);
  emphasized[0] = samples[0];
  for (let i = 1; i < N; i++) {
    emphasized[i] = samples[i] - preEmphasis * samples[i - 1];
  }

  // Windowing (Hamming)
  const windowed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1));
    windowed[i] = emphasized[i] * w;
  }

  // Autocorrelation
  const r = new Float32Array(order + 1);
  for (let k = 0; k <= order; k++) {
    let sum = 0;
    for (let i = 0; i < N - k; i++) {
      sum += windowed[i] * windowed[i + k];
    }
    r[k] = sum;
  }

  // Bandwidth expansion
  for (let k = 1; k <= order; k++) {
    r[k] *= Math.pow(bwExpand, k);
  }

  // Levinson-Durbin
  const reflectionCoeffs = new Float32Array(order);
  const a = new Float32Array(order + 1);
  a[0] = 1;
  let e = r[0] + 1e-10;

  for (let i = 0; i < order; i++) {
    let lambda = r[i + 1];
    for (let j = 1; j <= i; j++) {
      lambda += a[j] * r[i + 1 - j];
    }

    reflectionCoeffs[i] = -lambda / e;
    reflectionCoeffs[i] = Math.max(-0.99, Math.min(0.99, reflectionCoeffs[i]));

    const aNew = new Float32Array(order + 1);
    aNew[0] = 1;
    for (let j = 1; j <= i; j++) {
      aNew[j] = a[j] + reflectionCoeffs[i] * a[i + 1 - j];
    }
    aNew[i + 1] = reflectionCoeffs[i];
    a.set(aNew);

    e = e * (1 - reflectionCoeffs[i] * reflectionCoeffs[i]);
    if (e < 1e-10) e = 1e-10;
  }

  // Calculate residual energy and gain
  let inputEnergy = 0;
  for (let i = 0; i < N; i++) {
    inputEnergy += windowed[i] * windowed[i];
  }

  const gain = Math.sqrt(e);

  // Compute signal RMS (for output scaling)
  let signalEnergy = 0;
  for (let i = 0; i < N; i++) {
    signalEnergy += samples[i] * samples[i];
  }
  const signalRMS = Math.sqrt(signalEnergy / N);

  return {
    reflectionCoeffs,
    lpcCoeffs: a,
    gain,  // Keep Levinson gain for synthesis
    signalRMS,  // Store signal RMS for output scaling
    residualEnergy: e,
  };
}

/**
 * LPC synthesis using prediction coefficients
 */
function lpcSynthesize(
  excitation: Float32Array,
  lpcCoeffs: Float32Array,
  gain: number,
  deEmphasis: number
): Float32Array {
  const N = excitation.length;
  const order = lpcCoeffs.length - 1;
  const output = new Float32Array(N);

  const state = new Float32Array(order);
  let prevOutput = 0;

  for (let i = 0; i < N; i++) {
    // All-pole filter
    let sample = excitation[i] * gain;
    for (let j = 0; j < order; j++) {
      sample -= lpcCoeffs[j + 1] * state[j];
    }

    // Shift state
    for (let j = order - 1; j > 0; j--) {
      state[j] = state[j - 1];
    }
    state[0] = sample;

    // De-emphasis
    sample = sample + deEmphasis * prevOutput;
    prevOutput = sample;

    output[i] = sample;
  }

  return output;
}

/**
 * Quantize reflection coefficients (arcsine transform)
 */
function quantizeReflectionCoeffs(coeffs: Float32Array, bits: number): Float32Array {
  const quantized = new Float32Array(coeffs.length);
  const levels = Math.pow(2, bits);

  for (let i = 0; i < coeffs.length; i++) {
    const k = Math.max(-0.99, Math.min(0.99, coeffs[i]));
    const arcsin = Math.asin(k);
    const normalized = (arcsin / (Math.PI / 2) + 1) / 2;  // 0 to 1
    const quantValue = Math.round(normalized * (levels - 1));
    const dequantNorm = quantValue / (levels - 1);
    const dequantArcsin = (dequantNorm * 2 - 1) * (Math.PI / 2);
    quantized[i] = Math.sin(dequantArcsin);
  }

  return quantized;
}

/**
 * Convert reflection coefficients to LPC coefficients
 */
function reflectionToLPC(reflectionCoeffs: Float32Array): Float32Array {
  const order = reflectionCoeffs.length;
  const a = new Float32Array(order + 1);
  a[0] = 1;

  for (let i = 0; i < order; i++) {
    const aNew = new Float32Array(order + 1);
    aNew[0] = 1;
    for (let j = 1; j <= i; j++) {
      aNew[j] = a[j] + reflectionCoeffs[i] * a[i + 1 - j];
    }
    aNew[i + 1] = reflectionCoeffs[i];
    a.set(aNew);
  }

  return a;
}

/**
 * Test LPC analysis/synthesis quality with perfect excitation
 * This tests just the coefficient accuracy without pitch/voicing issues
 */
function testLPCQuality(signal: Float32Array, params: TestParams): {
  snr: number;
  correlation: number;
  originalEnergy: number;
  reconstructedEnergy: number;
} {
  const analysis = lpcAnalysis(signal, params.lpcOrder, params.preEmphasis, params.bwExpand);

  // Calculate true residual (excitation) from original signal
  const N = signal.length;
  const preEmphasized = new Float32Array(N);
  preEmphasized[0] = signal[0];
  for (let i = 1; i < N; i++) {
    preEmphasized[i] = signal[i] - params.preEmphasis * signal[i - 1];
  }

  // Inverse filter to get residual
  const residual = new Float32Array(N);
  const order = analysis.lpcCoeffs.length - 1;
  for (let i = 0; i < N; i++) {
    let r = preEmphasized[i];
    for (let j = 1; j <= order && i - j >= 0; j++) {
      r += analysis.lpcCoeffs[j] * preEmphasized[i - j];
    }
    residual[i] = r / analysis.gain;
  }

  // Synthesize using true residual
  const reconstructed = lpcSynthesize(residual, analysis.lpcCoeffs, analysis.gain, params.deEmphasis);

  // Calculate metrics
  let origEnergy = 0, reconEnergy = 0;
  for (let i = 0; i < N; i++) {
    origEnergy += signal[i] * signal[i];
    reconEnergy += reconstructed[i] * reconstructed[i];
  }

  return {
    snr: calculateSNR(signal, reconstructed),
    correlation: calculateCorrelation(signal, reconstructed),
    originalEnergy: origEnergy,
    reconstructedEnergy: reconEnergy,
  };
}

/**
 * Test coefficient quantization impact
 */
function testQuantizationImpact(signal: Float32Array, params: TestParams, bits: number): {
  snr: number;
  correlation: number;
  coeffError: number;
} {
  const analysis = lpcAnalysis(signal, params.lpcOrder, params.preEmphasis, params.bwExpand);

  // Quantize reflection coefficients
  const quantizedReflection = quantizeReflectionCoeffs(analysis.reflectionCoeffs, bits);
  const quantizedLPC = reflectionToLPC(quantizedReflection);

  // Calculate coefficient error
  let coeffError = 0;
  for (let i = 0; i < analysis.reflectionCoeffs.length; i++) {
    const err = analysis.reflectionCoeffs[i] - quantizedReflection[i];
    coeffError += err * err;
  }
  coeffError = Math.sqrt(coeffError / analysis.reflectionCoeffs.length);

  // Calculate true residual
  const N = signal.length;
  const preEmphasized = new Float32Array(N);
  preEmphasized[0] = signal[0];
  for (let i = 1; i < N; i++) {
    preEmphasized[i] = signal[i] - params.preEmphasis * signal[i - 1];
  }

  const residual = new Float32Array(N);
  const order = analysis.lpcCoeffs.length - 1;
  for (let i = 0; i < N; i++) {
    let r = preEmphasized[i];
    for (let j = 1; j <= order && i - j >= 0; j++) {
      r += analysis.lpcCoeffs[j] * preEmphasized[i - j];
    }
    residual[i] = r / analysis.gain;
  }

  // Synthesize with quantized coefficients
  const reconstructed = lpcSynthesize(residual, quantizedLPC, analysis.gain, params.deEmphasis);

  return {
    snr: calculateSNR(signal, reconstructed),
    correlation: calculateCorrelation(signal, reconstructed),
    coeffError,
  };
}

/**
 * Test full encode/decode pipeline (simulating vocoder)
 * Uses proper LPC gain for excitation scaling
 */
function testFullPipeline(signal: Float32Array, params: TestParams): {
  snr: number;
  correlation: number;
  excitationType: string;
} {
  const N = signal.length;
  const analysis = lpcAnalysis(signal, params.lpcOrder, params.preEmphasis, params.bwExpand);

  // Quantize coefficients (using 16-bit as in HQ mode)
  const bytesPerCoeff = Math.floor((params.codecBytes - 4) / params.lpcOrder);
  const bits = bytesPerCoeff >= 2 ? 16 : 8;
  const quantizedReflection = quantizeReflectionCoeffs(analysis.reflectionCoeffs, bits);
  const quantizedLPC = reflectionToLPC(quantizedReflection);

  // Simple pitch detection using autocorrelation
  const preEmphasized = new Float32Array(N);
  preEmphasized[0] = signal[0];
  for (let i = 1; i < N; i++) {
    preEmphasized[i] = signal[i] - params.preEmphasis * signal[i - 1];
  }

  let r0 = 0;
  for (let i = 0; i < N; i++) {
    r0 += preEmphasized[i] * preEmphasized[i];
  }

  let bestPitch = 0;
  let bestCorr = 0;
  for (let lag = 16; lag <= 120; lag++) {
    let corr = 0;
    let e2 = 0;
    for (let i = 0; i < N - lag; i++) {
      corr += preEmphasized[i] * preEmphasized[i + lag];
      e2 += preEmphasized[i + lag] * preEmphasized[i + lag];
    }
    const normalizedCorr = corr / (Math.sqrt(r0 * e2) + 1e-10);
    if (normalizedCorr > bestCorr) {
      bestCorr = normalizedCorr;
      bestPitch = lag;
    }
  }

  const voiced = bestCorr > 0.3;

  // Generate synthetic excitation
  const excitation = new Float32Array(N);

  if (voiced && bestPitch > 0) {
    // Voiced: glottal pulse
    let phase = 0;
    for (let i = 0; i < N; i++) {
      const phaseNorm = phase / bestPitch;
      // Rosenberg-style glottal pulse
      if (phaseNorm < 0.4) {
        excitation[i] = Math.sin(phaseNorm * Math.PI / 0.4);
      } else if (phaseNorm < 0.5) {
        excitation[i] = Math.cos((phaseNorm - 0.4) * Math.PI / 0.2);
      } else {
        excitation[i] = 0;
      }
      phase++;
      if (phase >= bestPitch) phase = 0;
    }
  } else {
    // Unvoiced: white noise
    for (let i = 0; i < N; i++) {
      excitation[i] = Math.random() * 2 - 1;
    }
  }

  // Normalize excitation to unit RMS
  let excEnergy = 0;
  for (let i = 0; i < N; i++) {
    excEnergy += excitation[i] * excitation[i];
  }
  const excRMS = Math.sqrt(excEnergy / N);
  if (excRMS > 0.001) {
    for (let i = 0; i < N; i++) {
      excitation[i] /= excRMS;
    }
  }

  // Synthesize using all-pole filter
  const reconstructed = lpcSynthesize(excitation, quantizedLPC, 1, params.deEmphasis);

  // Scale output to match input signal RMS
  let reconEnergy = 0;
  for (let i = 0; i < N; i++) {
    reconEnergy += reconstructed[i] * reconstructed[i];
  }
  const reconRMS = Math.sqrt(reconEnergy / N);
  if (reconRMS > 0.001 && analysis.signalRMS > 0.001) {
    const outputScale = analysis.signalRMS / reconRMS;
    for (let i = 0; i < N; i++) {
      reconstructed[i] *= outputScale;
    }
  }

  // Calculate energy ratio for verification (should be ~1.0 now)
  let origEnergy = 0;
  reconEnergy = 0;
  for (let i = 0; i < N; i++) {
    origEnergy += signal[i] * signal[i];
    reconEnergy += reconstructed[i] * reconstructed[i];
  }
  const energyRatio = Math.sqrt(reconEnergy / (origEnergy + 1e-10));

  return {
    snr: calculateSNR(signal, reconstructed),
    correlation: calculateCorrelation(signal, reconstructed),
    excitationType: voiced ? 'voiced' : 'unvoiced',
    energyRatio,  // Should be ~1.0 if gain is correct
  };
}

/**
 * Test using TRUE residual but quantized coefficients
 * This isolates coefficient accuracy from excitation modeling
 */
function testWithTrueResidual(signal: Float32Array, params: TestParams): {
  snr: number;
  correlation: number;
} {
  const N = signal.length;
  const analysis = lpcAnalysis(signal, params.lpcOrder, params.preEmphasis, params.bwExpand);

  // Quantize coefficients
  const bytesPerCoeff = Math.floor((params.codecBytes - 4) / params.lpcOrder);
  const bits = bytesPerCoeff >= 2 ? 16 : 8;
  const quantizedReflection = quantizeReflectionCoeffs(analysis.reflectionCoeffs, bits);
  const quantizedLPC = reflectionToLPC(quantizedReflection);

  // Get TRUE residual (not synthetic)
  const preEmphasized = new Float32Array(N);
  preEmphasized[0] = signal[0];
  for (let i = 1; i < N; i++) {
    preEmphasized[i] = signal[i] - params.preEmphasis * signal[i - 1];
  }

  // Inverse filter to get residual using ORIGINAL (unquantized) coefficients
  const residual = new Float32Array(N);
  const order = analysis.lpcCoeffs.length - 1;
  for (let i = 0; i < N; i++) {
    let r = preEmphasized[i];
    for (let j = 1; j <= order && i - j >= 0; j++) {
      r += analysis.lpcCoeffs[j] * preEmphasized[i - j];
    }
    residual[i] = r;
  }

  // Synthesize using QUANTIZED coefficients but true residual
  const reconstructed = lpcSynthesize(residual, quantizedLPC, 1, params.deEmphasis);

  return {
    snr: calculateSNR(signal, reconstructed),
    correlation: calculateCorrelation(signal, reconstructed),
  };
}

/**
 * Detailed excitation energy analysis
 */
function analyzeExcitationEnergy(signal: Float32Array, params: TestParams): void {
  const N = signal.length;
  const analysis = lpcAnalysis(signal, params.lpcOrder, params.preEmphasis, params.bwExpand);

  // Get true residual
  const preEmphasized = new Float32Array(N);
  preEmphasized[0] = signal[0];
  for (let i = 1; i < N; i++) {
    preEmphasized[i] = signal[i] - params.preEmphasis * signal[i - 1];
  }

  const residual = new Float32Array(N);
  const order = analysis.lpcCoeffs.length - 1;
  for (let i = 0; i < N; i++) {
    let r = preEmphasized[i];
    for (let j = 1; j <= order && i - j >= 0; j++) {
      r += analysis.lpcCoeffs[j] * preEmphasized[i - j];
    }
    residual[i] = r;
  }

  // Measure energies
  let signalEnergy = 0, residualEnergy = 0;
  for (let i = 0; i < N; i++) {
    signalEnergy += signal[i] * signal[i];
    residualEnergy += residual[i] * residual[i];
  }
  const signalRMS = Math.sqrt(signalEnergy / N);
  const residualRMS = Math.sqrt(residualEnergy / N);

  // Generate synthetic excitation
  let bestPitch = 0;
  let bestCorr = 0;
  let r0 = 0;
  for (let i = 0; i < N; i++) r0 += preEmphasized[i] * preEmphasized[i];

  for (let lag = 16; lag <= 120; lag++) {
    let corr = 0, e2 = 0;
    for (let i = 0; i < N - lag; i++) {
      corr += preEmphasized[i] * preEmphasized[i + lag];
      e2 += preEmphasized[i + lag] * preEmphasized[i + lag];
    }
    const normalizedCorr = corr / (Math.sqrt(r0 * e2) + 1e-10);
    if (normalizedCorr > bestCorr) {
      bestCorr = normalizedCorr;
      bestPitch = lag;
    }
  }

  const syntheticExc = new Float32Array(N);
  if (bestPitch > 0 && bestCorr > 0.3) {
    const pulseAmp = Math.sqrt(bestPitch);
    let phase = 0;
    for (let i = 0; i < N; i++) {
      const phaseNorm = phase / bestPitch;
      if (phaseNorm < 0.4) {
        syntheticExc[i] = Math.sin(phaseNorm * Math.PI / 0.4) * pulseAmp;
      } else if (phaseNorm < 0.5) {
        syntheticExc[i] = Math.cos((phaseNorm - 0.4) * Math.PI / 0.2) * pulseAmp;
      }
      phase++;
      if (phase >= bestPitch) phase = 0;
    }
  } else {
    for (let i = 0; i < N; i++) {
      syntheticExc[i] = Math.random() * 2 - 1;
    }
  }

  let syntheticEnergy = 0;
  for (let i = 0; i < N; i++) syntheticEnergy += syntheticExc[i] * syntheticExc[i];
  const syntheticRMS = Math.sqrt(syntheticEnergy / N);

  console.log(`  Signal RMS:        ${signalRMS.toFixed(2)}`);
  console.log(`  Residual RMS:      ${residualRMS.toFixed(2)}`);
  console.log(`  Analysis Gain:     ${analysis.gain.toFixed(2)} (should match residual RMS)`);
  console.log(`  Synthetic Exc RMS: ${syntheticRMS.toFixed(2)}`);
  console.log(`  Detected Pitch:    ${bestPitch} (corr: ${bestCorr.toFixed(3)})`);
  console.log(`  Gain/Residual:     ${(analysis.gain / residualRMS).toFixed(4)} (should be ~1.0)`);
  console.log('');
}

/**
 * Run all tests
 */
function runTests(): void {
  console.log('='.repeat(70));
  console.log('VOCODER SNR QUALITY TEST');
  console.log('='.repeat(70));
  console.log(`Sample rate: ${VOICE_SAMPLE_RATE} Hz`);
  console.log(`Frame size: ${VOICE_FRAME_SAMPLES} samples (${VOICE_FRAME_SAMPLES / VOICE_SAMPLE_RATE * 1000}ms)`);
  console.log(`Test config: codecBytes=${HQ_PARAMS.codecBytes}, lpcOrder=${HQ_PARAMS.lpcOrder}`);
  console.log('');

  // Test signals
  const numSamples = VOICE_FRAME_SAMPLES;

  const testSignals: { name: string; signal: Float32Array }[] = [
    { name: 'Sine 200Hz', signal: generateSineWave(200, 10000, numSamples) },
    { name: 'Sine 500Hz', signal: generateSineWave(500, 10000, numSamples) },
    { name: 'Sine 1000Hz', signal: generateSineWave(1000, 10000, numSamples) },
    { name: 'Vowel /a/ (F0=120Hz)', signal: generateVowelFormants(120, [730, 1090, 2440], 10000, numSamples) },
    { name: 'Vowel /i/ (F0=120Hz)', signal: generateVowelFormants(120, [270, 2290, 3010], 10000, numSamples) },
    { name: 'Vowel /u/ (F0=120Hz)', signal: generateVowelFormants(120, [300, 870, 2240], 10000, numSamples) },
    { name: 'Vowel /a/ (F0=200Hz)', signal: generateVowelFormants(200, [730, 1090, 2440], 10000, numSamples) },
    { name: 'White Noise', signal: generateNoise(8000, numSamples) },
  ];

  // Test 1: LPC analysis/synthesis with perfect excitation
  console.log('-'.repeat(70));
  console.log('TEST 1: LPC Analysis/Synthesis (perfect excitation, no quantization)');
  console.log('-'.repeat(70));
  console.log('This tests the LPC algorithm itself - should be near-perfect.');
  console.log('');
  console.log(`${'Signal'.padEnd(25)} ${'SNR (dB)'.padStart(10)} ${'Correlation'.padStart(12)}`);
  console.log('-'.repeat(50));

  for (const { name, signal } of testSignals) {
    const result = testLPCQuality(signal, HQ_PARAMS);
    console.log(`${name.padEnd(25)} ${result.snr.toFixed(1).padStart(10)} ${result.correlation.toFixed(4).padStart(12)}`);
  }

  // Test 2: Coefficient quantization impact
  console.log('');
  console.log('-'.repeat(70));
  console.log('TEST 2: Coefficient Quantization Impact');
  console.log('-'.repeat(70));
  console.log('Tests how much quality degrades due to coefficient quantization.');
  console.log('');

  const vowelSignal = generateVowelFormants(120, [730, 1090, 2440], 10000, numSamples);
  console.log('Signal: Vowel /a/ at 120Hz');
  console.log('');
  console.log(`${'Bits/Coeff'.padEnd(15)} ${'SNR (dB)'.padStart(10)} ${'Correlation'.padStart(12)} ${'Coeff RMS Err'.padStart(14)}`);
  console.log('-'.repeat(55));

  for (const bits of [4, 6, 8, 10, 12, 16]) {
    const result = testQuantizationImpact(vowelSignal, HQ_PARAMS, bits);
    console.log(`${String(bits).padEnd(15)} ${result.snr.toFixed(1).padStart(10)} ${result.correlation.toFixed(4).padStart(12)} ${result.coeffError.toFixed(6).padStart(14)}`);
  }

  // Test 3: Full pipeline
  console.log('');
  console.log('-'.repeat(70));
  console.log('TEST 3: Full Encode/Decode Pipeline');
  console.log('-'.repeat(70));
  console.log('Tests complete pipeline including synthetic excitation.');
  console.log('Lower SNR here vs Test 1 shows excitation modeling loss.');
  console.log('');
  console.log(`${'Signal'.padEnd(25)} ${'SNR (dB)'.padStart(10)} ${'Correlation'.padStart(12)} ${'Energy Ratio'.padStart(14)}`);
  console.log('-'.repeat(65));

  for (const { name, signal } of testSignals) {
    const result = testFullPipeline(signal, HQ_PARAMS);
    console.log(`${name.padEnd(25)} ${result.snr.toFixed(1).padStart(10)} ${result.correlation.toFixed(4).padStart(12)} ${result.energyRatio!.toFixed(3).padStart(14)}`);
  }

  // Test 4: True residual test
  console.log('');
  console.log('-'.repeat(70));
  console.log('TEST 4: True Residual with Quantized Coefficients');
  console.log('-'.repeat(70));
  console.log('This isolates coefficient quantization error from excitation modeling.');
  console.log('');
  console.log(`${'Signal'.padEnd(25)} ${'SNR (dB)'.padStart(10)} ${'Correlation'.padStart(12)}`);
  console.log('-'.repeat(50));
  for (const { name, signal } of testSignals) {
    const result = testWithTrueResidual(signal, HQ_PARAMS);
    console.log(`${name.padEnd(25)} ${result.snr.toFixed(1).padStart(10)} ${result.correlation.toFixed(4).padStart(12)}`);
  }

  // Test 5: Energy analysis
  console.log('');
  console.log('-'.repeat(70));
  console.log('TEST 5: Excitation Energy Analysis');
  console.log('-'.repeat(70));
  console.log('');
  console.log('Vowel /a/ at 120Hz:');
  analyzeExcitationEnergy(generateVowelFormants(120, [730, 1090, 2440], 10000, numSamples), HQ_PARAMS);
  console.log('Sine 200Hz:');
  analyzeExcitationEnergy(generateSineWave(200, 10000, numSamples), HQ_PARAMS);

  // Test 6: Codec bytes impact
  console.log('');
  console.log('-'.repeat(70));
  console.log('TEST 6: Codec Bytes Impact on Vowel /a/');
  console.log('-'.repeat(70));
  console.log('');
  console.log(`${'Bytes'.padEnd(8)} ${'kbps'.padEnd(10)} ${'Order'.padEnd(8)} ${'SNR (dB)'.padStart(10)} ${'Correlation'.padStart(12)}`);
  console.log('-'.repeat(55));

  for (const bytes of [16, 24, 32, 48, 64]) {
    const order = Math.min(20, bytes - 4);
    const testParams = { ...HQ_PARAMS, codecBytes: bytes, lpcOrder: order };
    const result = testFullPipeline(vowelSignal, testParams);
    const kbps = (bytes * 8 / 0.02 / 1000).toFixed(1);
    console.log(`${String(bytes).padEnd(8)} ${kbps.padEnd(10)} ${String(order).padEnd(8)} ${result.snr.toFixed(1).padStart(10)} ${result.correlation.toFixed(4).padStart(12)}`);
  }

  // Analysis
  console.log('');
  console.log('='.repeat(70));
  console.log('ANALYSIS');
  console.log('='.repeat(70));
  console.log('');
  console.log('Expected SNR benchmarks:');
  console.log('  - LPC with perfect excitation: >30 dB (good), >40 dB (excellent)');
  console.log('  - Full pipeline with synthetic excitation: >10 dB (intelligible)');
  console.log('  - Real vocoders typically achieve: 10-20 dB SNR');
  console.log('');
  console.log('If Test 1 SNR is low (<30 dB):');
  console.log('  → Problem is in LPC analysis algorithm');
  console.log('');
  console.log('If Test 1 is good but Test 2 is bad:');
  console.log('  → Need more bits for coefficient quantization');
  console.log('');
  console.log('If Test 1 & 2 are good but Test 3 is bad:');
  console.log('  → Problem is in excitation modeling (pitch, voicing)');
  console.log('');
}

// Run tests
runTests();
