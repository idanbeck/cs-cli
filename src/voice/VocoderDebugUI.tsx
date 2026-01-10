/**
 * VocoderDebugUI - TUI for vocoder debug/loopback testing
 *
 * Keyboard controls:
 * - Space: Start recording (auto-stops on silence)
 * - O: Play original recording
 * - P: Play processed (encoded/decoded) recording
 * - Esc/Q: Exit
 * - Up/Down: Navigate parameters
 * - Left/Right: Adjust selected parameter
 * - 1-6: Quick select excitation type (LPC mode)
 * - Tab: Cycle presets
 * - T: Toggle between Codec2 and LPC mode
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import {
  VocoderDebug,
  VocoderParams,
  DebugState,
  DEFAULT_VOCODER_PARAMS,
  VOCODER_PRESETS,
  initializeVocoderDebug,
  destroyVocoderDebug,
} from './VocoderDebug.js';
import { Codec2, Codec2ModeString } from './Codec2.js';

interface ParamDef {
  key: keyof VocoderParams;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number | string) => string;
}

// Helper to calculate bitrate
const calcBitrate = (bytes: number) => ((bytes * 8) / 0.02 / 1000).toFixed(1);

// Codec2 modes available
const CODEC2_MODES: Codec2ModeString[] = ['3200', '2400', '1600', '1400', '1300', '1200', '700C'];

// Codec2-specific post-processing parameters (effects applied after Codec2 decode)
const CODEC2_PARAM_DEFS: ParamDef[] = [
  // === Radio Effects (post-processing for Codec2) ===
  { key: 'highpassCutoff', label: 'Highpass Hz', min: 50, max: 500, step: 25, format: v => String(Math.round(v as number)) },
  { key: 'lowpassCutoff', label: 'Lowpass Hz', min: 2000, max: 4000, step: 100, format: v => String(Math.round(v as number)) },
  { key: 'noiseLevel', label: 'Static', min: 0, max: 0.15, step: 0.01, format: v => (v as number).toFixed(2) },
  { key: 'hardClip', label: 'Distortion', min: 0, max: 0.4, step: 0.05, format: v => (v as number).toFixed(2) },
  { key: 'bitCrush', label: 'Bit Crush', min: 10, max: 16, step: 1, format: v => String(v) + ' bit' },
  { key: 'outputGain', label: 'Output Gain', min: 0.5, max: 2.5, step: 0.1, format: v => (v as number).toFixed(1) + 'x' },
];

// LPC parameters - full set for custom LPC vocoder
const LPC_PARAM_DEFS: ParamDef[] = [
  // === CODEC (Most important for intelligibility!) ===
  { key: 'codecBytes', label: 'Codec Bytes', min: 16, max: 64, step: 4, format: v => `${v}B (${calcBitrate(v as number)}kbps)` },
  { key: 'lpcOrder', label: 'LPC Order', min: 4, max: 24, step: 2, format: v => String(v) },

  // === LPC Core ===
  { key: 'preEmphasis', label: 'Pre-emphasis', min: 0.9, max: 0.99, step: 0.01, format: v => (v as number).toFixed(2) },
  { key: 'bwExpand', label: 'BW Expand', min: 0.9, max: 1.0, step: 0.005, format: v => (v as number).toFixed(3) },
  { key: 'deEmphasis', label: 'De-emphasis', min: 0.9, max: 0.99, step: 0.01, format: v => (v as number).toFixed(2) },

  // === Filters ===
  { key: 'highpassCutoff', label: 'Highpass Hz', min: 50, max: 500, step: 25, format: v => String(Math.round(v as number)) },
  { key: 'lowpassCutoff', label: 'Lowpass Hz', min: 2000, max: 4000, step: 100, format: v => String(Math.round(v as number)) },
  { key: 'filterQ', label: 'Filter Q', min: 0.5, max: 3, step: 0.1, format: v => (v as number).toFixed(1) },

  // === Voice ===
  { key: 'voicingThreshold', label: 'Voice Thresh', min: 0.1, max: 0.6, step: 0.05, format: v => (v as number).toFixed(2) },
  { key: 'aspirationLevel', label: 'Aspiration', min: 0, max: 0.5, step: 0.05, format: v => (v as number).toFixed(2) },
  { key: 'pitchShift', label: 'Pitch Shift', min: 0.5, max: 2, step: 0.05, format: v => (v as number).toFixed(2) + 'x' },
  { key: 'formantShift', label: 'Formant Shift', min: 0.7, max: 1.5, step: 0.05, format: v => (v as number).toFixed(2) + 'x' },

  // === Radio Effects ===
  { key: 'noiseLevel', label: 'Static', min: 0, max: 0.2, step: 0.01, format: v => (v as number).toFixed(2) },
  { key: 'hardClip', label: 'Distortion', min: 0, max: 0.5, step: 0.05, format: v => (v as number).toFixed(2) },
  { key: 'bitCrush', label: 'Bit Crush', min: 8, max: 16, step: 1, format: v => String(v) + ' bit' },
  { key: 'sampleRateDiv', label: 'SR Decimate', min: 1, max: 4, step: 1, format: v => '÷' + String(v) },
  { key: 'ringModFreq', label: 'Ring Mod Hz', min: 0, max: 500, step: 25, format: v => String(Math.round(v as number)) },
  { key: 'ringModMix', label: 'Ring Mix', min: 0, max: 0.5, step: 0.05, format: v => (v as number).toFixed(2) },

  // === Output ===
  { key: 'outputGain', label: 'Output Gain', min: 0.5, max: 3, step: 0.1, format: v => (v as number).toFixed(1) + 'x' },
];

const EXCITATION_TYPES: VocoderParams['excitationType'][] = ['diff', 'sync', 'pulse', 'sawtooth', 'triangle', 'square', 'impulse', 'noise'];

// Separate presets by codec type - filter based on actual preset settings
const CODEC2_PRESET_NAMES = Object.keys(VOCODER_PRESETS).filter(name => {
  const preset = VOCODER_PRESETS[name];
  return preset.useNativeCodec2 === true;
});
const LPC_PRESET_NAMES = Object.keys(VOCODER_PRESETS).filter(name => {
  const preset = VOCODER_PRESETS[name];
  return preset.useNativeCodec2 !== true;
});

// Braille-based waveform display
// Each braille char is 2 dots wide x 4 dots tall
// Braille dot positions:
//   1   8
//   2  16
//   4  32
//  64 128
const BRAILLE_BASE = 0x2800;
const WAVE_COLS = 80;  // braille characters wide
const WAVE_ROWS = 3;   // braille characters tall (12 vertical dots)
const DOTS_PER_COL = WAVE_ROWS * 4; // 12 vertical dots

// Build a braille character from dot positions (0-7 for each column pair)
function brailleChar(leftDots: number[], rightDots: number[]): string {
  let code = 0;
  // Left column: positions 0,1,2,3 map to bits 0,1,2,6
  const leftBits = [1, 2, 4, 64];
  // Right column: positions 0,1,2,3 map to bits 3,4,5,7
  const rightBits = [8, 16, 32, 128];

  for (const d of leftDots) {
    if (d >= 0 && d < 4) code |= leftBits[d];
  }
  for (const d of rightDots) {
    if (d >= 0 && d < 4) code |= rightBits[d];
  }
  return String.fromCharCode(BRAILLE_BASE + code);
}

interface Props {
  onExit: () => void;
}

export const VocoderDebugUI: React.FC<Props> = ({ onExit }) => {
  const { exit } = useApp();
  const [debug, setDebug] = useState<VocoderDebug | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Combine frequently-updated values into single state to batch renders
  const [dynamicState, setDynamicState] = useState({
    status: 'Initializing...',
    currentState: 'idle' as DebugState,
    micLevel: 0,
    playbackPosition: 0,
  });
  const [waveform, setWaveform] = useState<number[]>([]);
  const [params, setParams] = useState<VocoderParams>(DEFAULT_VOCODER_PARAMS);
  const [selectedParam, setSelectedParam] = useState(0);
  const [selectedPreset, setSelectedPreset] = useState(0);

  // Codec2 native availability
  const [codec2Available] = useState(() => Codec2.isNativeAvailable());

  // Refs for batching updates
  const pendingDynamicUpdate = useRef<Partial<typeof dynamicState>>({});
  const updateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Batch dynamic state updates to prevent flicker
  const batchDynamicUpdate = useCallback((updates: Partial<typeof dynamicState>) => {
    Object.assign(pendingDynamicUpdate.current, updates);
    if (!updateTimer.current) {
      updateTimer.current = setTimeout(() => {
        updateTimer.current = null;
        const pending = pendingDynamicUpdate.current;
        pendingDynamicUpdate.current = {};
        if (Object.keys(pending).length > 0) {
          setDynamicState(prev => ({ ...prev, ...pending }));
        }
      }, 32); // ~30fps max update rate
    }
  }, []);

  // Destructure for easier access
  const { status, currentState, micLevel, playbackPosition } = dynamicState;

  // Get current param defs and preset names based on codec mode
  const isCodec2Mode = params.useNativeCodec2 && codec2Available;
  const currentParamDefs = isCodec2Mode ? CODEC2_PARAM_DEFS : LPC_PARAM_DEFS;
  const currentPresetNames = isCodec2Mode ? CODEC2_PRESET_NAMES : LPC_PRESET_NAMES;

  // Initialize
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        const d = await initializeVocoderDebug();
        if (!mounted) return;

        setDebug(d);

        d.setCallbacks(
          (state, info) => {
            if (mounted) {
              batchDynamicUpdate({ currentState: state, status: info });
            }
          },
          (level) => {
            if (mounted) batchDynamicUpdate({ micLevel: level });
          },
          (wf) => {
            if (mounted) setWaveform(wf);
          },
          (pos) => {
            if (mounted) batchDynamicUpdate({ playbackPosition: pos });
          }
        );
        batchDynamicUpdate({ status: 'Ready - Press SPACE to record' });
        setInitialized(true);
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to initialize');
        }
      }
    };

    init();

    return () => {
      mounted = false;
      if (updateTimer.current) {
        clearTimeout(updateTimer.current);
      }
      destroyVocoderDebug();
    };
  }, [batchDynamicUpdate]);

  // Update params in debug instance
  const updateParam = useCallback((key: keyof VocoderParams, value: number | string) => {
    setParams((prev) => {
      const newParams = { ...prev, [key]: value };
      debug?.updateParams({ [key]: value });
      return newParams;
    });
  }, [debug]);

  // Load a preset
  const loadPreset = useCallback((presetIdx: number) => {
    const presetNames = isCodec2Mode ? CODEC2_PRESET_NAMES : LPC_PRESET_NAMES;
    const presetName = presetNames[presetIdx];
    if (presetName && debug) {
      debug.loadPreset(presetName);
      setParams(debug.getParams());
      setSelectedPreset(presetIdx);
      setSelectedParam(0); // Reset param selection when loading preset
    }
  }, [debug, isCodec2Mode]);

  // Toggle between Codec2 and LPC modes
  const toggleCodecMode = useCallback(() => {
    if (!debug) return;
    if (!codec2Available && !params.useNativeCodec2) {
      // Can't switch to Codec2 if it's not available
      return;
    }
    const newUseCodec2 = !params.useNativeCodec2;
    debug.updateParams({ useNativeCodec2: newUseCodec2 });
    setParams(prev => ({ ...prev, useNativeCodec2: newUseCodec2 }));
    setSelectedParam(0);
    setSelectedPreset(0);
  }, [debug, codec2Available, params.useNativeCodec2]);

  // Cycle Codec2 mode
  const cycleCodec2Mode = useCallback((direction: 1 | -1) => {
    if (!debug || !isCodec2Mode) return;
    const currentIdx = CODEC2_MODES.indexOf(params.codec2Mode);
    const newIdx = (currentIdx + direction + CODEC2_MODES.length) % CODEC2_MODES.length;
    const newMode = CODEC2_MODES[newIdx];
    debug.updateParams({ codec2Mode: newMode });
    setParams(prev => ({ ...prev, codec2Mode: newMode }));
  }, [debug, isCodec2Mode, params.codec2Mode]);

  // Keyboard input
  useInput((input, key) => {
    if (!initialized || !debug) return;

    // Exit
    if (key.escape || input === 'q') {
      debug.cancel();
      onExit();
      return;
    }

    // Record - SPACE toggles recording on/off
    if (input === ' ') {
      if (currentState === 'idle') {
        setWaveform([]); // Clear waveform when starting new recording
        try {
          debug.startRecording();
        } catch (err) {
          batchDynamicUpdate({ status: `Error: ${err instanceof Error ? err.message : 'Unknown'}` });
        }
      } else if (currentState === 'recording') {
        debug.stopRecordingManual();
      }
      return;
    }

    // Play original
    if (input === 'o' || input === 'O') {
      if (currentState === 'idle' && debug.hasRecording()) {
        debug.playOriginal();
      }
      return;
    }

    // Play processed
    if (input === 'p' || input === 'P') {
      if (currentState === 'idle' && debug.hasRecording()) {
        debug.playProcessed();
      }
      return;
    }

    // Cancel playback
    if (input === 'c' || input === 'C') {
      debug.cancel();
      return;
    }

    // Navigate parameters and other controls (only when idle)
    if (currentState === 'idle') {
      // Toggle codec mode with T
      if (input === 't' || input === 'T') {
        toggleCodecMode();
        return;
      }

      // Codec2 mode cycling with M / Shift+M
      if (isCodec2Mode && (input === 'm' || input === 'M')) {
        cycleCodec2Mode(input === 'M' ? -1 : 1);
        return;
      }

      if (key.upArrow) {
        setSelectedParam((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedParam((prev) => Math.min(currentParamDefs.length - 1, prev + 1));
        return;
      }

      // Adjust selected parameter
      if (key.leftArrow || key.rightArrow) {
        const paramDef = currentParamDefs[selectedParam];
        if (paramDef) {
          const current = params[paramDef.key] as number;
          const delta = key.rightArrow ? paramDef.step : -paramDef.step;
          const newValue = Math.max(paramDef.min, Math.min(paramDef.max, current + delta));
          const rounded = Math.round(newValue * 1000) / 1000;
          updateParam(paramDef.key, rounded);
        }
        return;
      }

      // Quick excitation type select (1-8) - only in LPC mode
      if (!isCodec2Mode && input >= '1' && input <= '8') {
        const idx = parseInt(input) - 1;
        if (idx < EXCITATION_TYPES.length) {
          updateParam('excitationType', EXCITATION_TYPES[idx]);
        }
        return;
      }

      // Preset navigation with [ and ]
      if (input === '[') {
        loadPreset(Math.max(0, selectedPreset - 1));
        return;
      }
      if (input === ']') {
        loadPreset(Math.min(currentPresetNames.length - 1, selectedPreset + 1));
        return;
      }

      // Tab to cycle presets forward
      if (key.tab) {
        loadPreset((selectedPreset + 1) % currentPresetNames.length);
        return;
      }
    }
  });

  // Render mic level bar
  const levelBar = useMemo(() => {
    const width = 40;
    const filled = Math.round(micLevel * width);
    return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
  }, [micLevel]);

  // Calculate playback marker position in characters
  const playbackMarkerCol = useMemo(() => {
    if (playbackPosition <= 0) return -1;
    return Math.floor(playbackPosition * WAVE_COLS);
  }, [playbackPosition]);

  // Render waveform using braille for high resolution
  const waveformRows = useMemo(() => {
    const totalDotsWide = WAVE_COLS * 2;  // 2 dots per braille char
    const midY = Math.floor(DOTS_PER_COL / 2);

    // Create a 2D grid of dots
    const dots: boolean[][] = [];
    for (let y = 0; y < DOTS_PER_COL; y++) {
      dots.push(new Array(totalDotsWide).fill(false));
    }

    if (waveform.length === 0) {
      // Empty state - draw center line
      for (let x = 0; x < totalDotsWide; x++) {
        dots[midY][x] = true;
      }
    } else {
      // Resample waveform to pixel width
      const values: number[] = [];
      for (let x = 0; x < totalDotsWide; x++) {
        const srcIdx = (x / totalDotsWide) * waveform.length;
        const idx = Math.min(Math.floor(srcIdx), waveform.length - 1);
        values.push(waveform[idx]);
      }

      // Draw waveform - connect points with lines
      for (let x = 0; x < totalDotsWide; x++) {
        const amp = values[x];
        const height = Math.round(amp * midY);

        // Draw vertical bar from center extending up and down
        for (let dy = 0; dy <= height; dy++) {
          // Above center
          if (midY - dy >= 0) dots[midY - dy][x] = true;
          // Below center (mirror)
          if (midY + dy < DOTS_PER_COL) dots[midY + dy][x] = true;
        }

        // Connect to next point for smoother line
        if (x < totalDotsWide - 1) {
          const nextHeight = Math.round(values[x + 1] * midY);
          const minH = Math.min(height, nextHeight);
          const maxH = Math.max(height, nextHeight);
          // Fill in the gap at the top edge
          for (let h = minH; h <= maxH; h++) {
            if (midY - h >= 0) dots[midY - h][x] = true;
          }
        }
      }

      // Add some sparkle at peaks
      for (let x = 1; x < totalDotsWide - 1; x++) {
        if (values[x] > values[x-1] && values[x] > values[x+1] && values[x] > 0.5) {
          // This is a peak - add a dot above
          const peakY = midY - Math.round(values[x] * midY) - 1;
          if (peakY >= 0) dots[peakY][x] = true;
        }
      }
    }

    // Convert dot grid to braille characters
    const rows: string[] = [];
    for (let charRow = 0; charRow < WAVE_ROWS; charRow++) {
      let line = '';
      for (let charCol = 0; charCol < WAVE_COLS; charCol++) {
        const leftDots: number[] = [];
        const rightDots: number[] = [];

        // Check each dot position in this braille cell
        for (let dy = 0; dy < 4; dy++) {
          const y = charRow * 4 + dy;
          const xLeft = charCol * 2;
          const xRight = charCol * 2 + 1;

          if (y < DOTS_PER_COL) {
            if (dots[y][xLeft]) leftDots.push(dy);
            if (xRight < totalDotsWide && dots[y][xRight]) rightDots.push(dy);
          }
        }

        line += brailleChar(leftDots, rightDots);
      }
      rows.push(line);
    }

    return rows;
  }, [waveform]);

  // Render waveform row with playback marker overlay
  const renderWaveformRow = useCallback((row: string, rowIndex: number, baseColor: string) => {
    if (playbackMarkerCol < 0 || playbackMarkerCol >= WAVE_COLS) {
      return <Text color={baseColor}>{row}</Text>;
    }

    // Split the row at the marker position
    const before = row.slice(0, playbackMarkerCol);
    const marker = row[playbackMarkerCol] || '│';
    const after = row.slice(playbackMarkerCol + 1);

    return (
      <Text>
        <Text color={baseColor}>{before}</Text>
        <Text color="white" bold>{marker}</Text>
        <Text color={baseColor}>{after}</Text>
      </Text>
    );
  }, [playbackMarkerCol]);

  // Render small param bar
  const renderSmallBar = useCallback((percent: number, width: number): string => {
    const filled = Math.round((percent / 100) * width);
    return '\u2588'.repeat(filled) + '\u2500'.repeat(width - filled);
  }, []);

  // Status color based on state
  const statusColor = useMemo(() => {
    switch (currentState) {
      case 'recording': return 'green';
      case 'playing_original': return 'cyan';
      case 'playing_processed': return 'yellow';
      default: return 'white';
    }
  }, [currentState]);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press ESC to exit</Text>
      </Box>
    );
  }

  // Get row colors based on playback state
  const rowColors = useMemo(() => {
    const isPlaying = currentState === 'playing_original' || currentState === 'playing_processed';
    if (isPlaying) {
      return ['magenta', 'cyan', 'blue'] as const;
    }
    return ['magenta', 'cyan', 'blue'] as const;
  }, [currentState]);

  // Memoize the parameter rows to prevent flickering
  const paramRows = useMemo(() => {
    const halfLen = Math.ceil(currentParamDefs.length / 2);
    return {
      left: currentParamDefs.slice(0, halfLen),
      right: currentParamDefs.slice(halfLen),
      halfLen
    };
  }, [currentParamDefs]);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header with codec selector */}
      <Box marginBottom={1}>
        <Text bold color="cyan">Vocoder Debug</Text>
        <Text dimColor> │ </Text>
        <Text>Codec: </Text>
        <Text color={isCodec2Mode ? 'green' : 'gray'} bold={isCodec2Mode}>
          [Codec2]
        </Text>
        <Text> </Text>
        <Text color={!isCodec2Mode ? 'yellow' : 'gray'} bold={!isCodec2Mode}>
          [LPC]
        </Text>
        {codec2Available ? (
          <Text dimColor> (T to toggle)</Text>
        ) : (
          <Text dimColor color="red"> (Codec2 not installed)</Text>
        )}
      </Box>

      {/* Codec2 mode selector (only when in Codec2 mode) */}
      {isCodec2Mode && (
        <Box marginBottom={1}>
          <Text>Bitrate: </Text>
          {CODEC2_MODES.map((mode) => (
            <Box key={mode} marginRight={1}>
              <Text color={params.codec2Mode === mode ? 'green' : 'gray'} bold={params.codec2Mode === mode}>
                {mode}
              </Text>
            </Box>
          ))}
          <Text dimColor> (M/Shift+M to cycle)</Text>
        </Box>
      )}

      {/* Presets */}
      <Box marginBottom={1}>
        <Text>Preset: </Text>
        {currentPresetNames.map((name, i) => (
          <Box key={name} marginRight={1}>
            <Text color={i === selectedPreset ? 'green' : 'gray'} bold={i === selectedPreset}>
              {name}
            </Text>
          </Box>
        ))}
        <Text dimColor> (Tab/[/])</Text>
      </Box>

      {/* Status */}
      <Box marginBottom={1}>
        <Text>Status: </Text>
        <Text color={statusColor}>{status}</Text>
      </Box>

      {/* Mic Level */}
      <Box marginBottom={1}>
        <Text>Mic:  </Text>
        <Text color={micLevel > 0.5 ? 'green' : micLevel > 0.1 ? 'yellow' : 'gray'}>
          {levelBar}
        </Text>
        <Text> {(micLevel * 100).toFixed(0).padStart(3)}%</Text>
      </Box>

      {/* Waveform with playback marker */}
      <Box marginBottom={1} flexDirection="column">
        <Box>
          <Text dimColor>Waveform</Text>
          {waveform.length > 0 && <Text dimColor> ({waveform.length} pts)</Text>}
          {playbackPosition > 0 && (
            <Text color="yellow"> [{(playbackPosition * 100).toFixed(0)}%]</Text>
          )}
          <Text dimColor>:</Text>
        </Box>
        <Box flexDirection="column">
          {waveformRows.map((row, i) => (
            <Box key={`wf-${i}`}>{renderWaveformRow(row, i, rowColors[i])}</Box>
          ))}
        </Box>
      </Box>

      {/* Excitation Type - only show in LPC mode */}
      {!isCodec2Mode && (
        <Box marginBottom={1}>
          <Text>Excitation: </Text>
          {EXCITATION_TYPES.map((type, i) => (
            <Box key={type} marginRight={1}>
              <Text color={params.excitationType === type ? 'green' : 'gray'}>
                [{i + 1}]{type}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Parameters - show in two columns */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold dimColor>
          {isCodec2Mode ? 'Post-Processing' : 'Parameters'} (↑↓ select, ←→ adjust):
        </Text>
        <Box flexDirection="row">
          {/* Left column */}
          <Box flexDirection="column" marginRight={2}>
            {paramRows.left.map((def, i) => {
              const value = params[def.key];
              const isSelected = i === selectedParam;
              const percentage = typeof value === 'number'
                ? ((value - def.min) / (def.max - def.min)) * 100
                : 0;

              return (
                <Box key={`param-l-${def.key}`}>
                  <Text color={isSelected ? 'cyan' : 'white'}>
                    {isSelected ? '>' : ' '} {def.label.padEnd(14)}
                  </Text>
                  <Text color={isSelected ? 'green' : 'gray'}>
                    {def.format(value).padStart(8)}
                  </Text>
                  <Text dimColor> [{renderSmallBar(percentage, 8)}]</Text>
                </Box>
              );
            })}
          </Box>
          {/* Right column */}
          <Box flexDirection="column">
            {paramRows.right.map((def, idx) => {
              const i = idx + paramRows.halfLen;
              const value = params[def.key];
              const isSelected = i === selectedParam;
              const percentage = typeof value === 'number'
                ? ((value - def.min) / (def.max - def.min)) * 100
                : 0;

              return (
                <Box key={`param-r-${def.key}`}>
                  <Text color={isSelected ? 'cyan' : 'white'}>
                    {isSelected ? '>' : ' '} {def.label.padEnd(14)}
                  </Text>
                  <Text color={isSelected ? 'green' : 'gray'}>
                    {def.format(value).padStart(8)}
                  </Text>
                  <Text dimColor> [{renderSmallBar(percentage, 8)}]</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      </Box>

      {/* Help */}
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>SPACE: Record | O: Play Original | P: Play Processed | C: Cancel | Q: Exit</Text>
        <Text dimColor>
          {isCodec2Mode
            ? 'T: Switch to LPC | M: Cycle bitrate | Tab/[/]: Presets | ↑↓←→: Adjust'
            : 'T: Switch to Codec2 | 1-8: Excitation | Tab/[/]: Presets | ↑↓←→: Adjust'}
        </Text>
      </Box>
    </Box>
  );
};

export default VocoderDebugUI;
