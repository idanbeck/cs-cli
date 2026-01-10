#!/usr/bin/env node
/**
 * Smart native module builder
 *
 * Builds native modules, handling optional dependencies like codec2 gracefully.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const nativeDir = __dirname;

// Detect if codec2 is available on the system
function detectCodec2() {
  const platform = os.platform();

  if (platform === 'darwin') {
    // macOS - check homebrew
    const brewPaths = [
      '/opt/homebrew/opt/codec2',        // Apple Silicon
      '/usr/local/opt/codec2',           // Intel
    ];

    for (const p of brewPaths) {
      if (fs.existsSync(path.join(p, 'include/codec2/codec2.h'))) {
        return {
          available: true,
          includePath: path.join(p, 'include'),
          libPath: path.join(p, 'lib'),
        };
      }
    }

    // Check pkg-config
    try {
      const flags = execSync('pkg-config --cflags --libs codec2 2>/dev/null', { encoding: 'utf8' });
      if (flags.includes('-lcodec2')) {
        return { available: true, pkgConfig: true };
      }
    } catch {}
  } else if (platform === 'linux') {
    // Linux - check standard paths and pkg-config
    const standardPaths = [
      '/usr/include/codec2',
      '/usr/local/include/codec2',
    ];

    for (const p of standardPaths) {
      if (fs.existsSync(path.join(p, 'codec2.h'))) {
        return { available: true, systemInstall: true };
      }
    }

    // Check pkg-config
    try {
      const flags = execSync('pkg-config --cflags --libs codec2 2>/dev/null', { encoding: 'utf8' });
      if (flags.includes('-lcodec2')) {
        return { available: true, pkgConfig: true };
      }
    } catch {}
  }

  return { available: false };
}

// Generate binding.gyp with or without codec2
function generateBindingGyp(includeCodec2, codec2Info) {
  const targets = [
    {
      target_name: "keyboard",
      sources: ["keyboard_mac.c"],
      include_dirs: [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      defines: ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      conditions: [
        ["OS=='mac'", {
          xcode_settings: {
            GCC_ENABLE_CPP_EXCEPTIONS: "YES",
            CLANG_CXX_LIBRARY: "libc++",
            MACOSX_DEPLOYMENT_TARGET: "10.15"
          },
          link_settings: {
            libraries: [
              "-framework CoreGraphics",
              "-framework CoreFoundation",
              "-framework ApplicationServices"
            ]
          }
        }]
      ]
    },
    {
      target_name: "renderer",
      sources: ["renderer_simd.c"],
      include_dirs: [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      defines: ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      conditions: [
        ["OS=='mac'", {
          xcode_settings: {
            OTHER_CFLAGS: ["-O3", "-ffast-math", "-march=native", "-funroll-loops", "-ftree-vectorize", "-fno-strict-aliasing"],
            MACOSX_DEPLOYMENT_TARGET: "10.15",
            GCC_OPTIMIZATION_LEVEL: "3"
          }
        }],
        ["OS=='linux'", {
          cflags: ["-O3", "-ffast-math", "-march=native", "-funroll-loops", "-ftree-vectorize", "-fno-strict-aliasing", "-flto"]
        }]
      ]
    }
  ];

  if (includeCodec2 && codec2Info.available) {
    const codec2Target = {
      target_name: "codec2",
      sources: ["codec2_node.c"],
      include_dirs: [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      defines: ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      conditions: []
    };

    if (codec2Info.includePath) {
      codec2Target.include_dirs.push(codec2Info.includePath);
    }

    // Platform-specific settings
    const macCondition = ["OS=='mac'", {
      xcode_settings: {
        OTHER_CFLAGS: ["-O3"],
        MACOSX_DEPLOYMENT_TARGET: "10.15"
      },
      link_settings: {
        libraries: []
      }
    }];

    const linuxCondition = ["OS=='linux'", {
      cflags: ["-O3"],
      link_settings: {
        libraries: []
      }
    }];

    if (codec2Info.libPath) {
      macCondition[1].link_settings.libraries.push(`-L${codec2Info.libPath}`, "-lcodec2");
    } else {
      macCondition[1].link_settings.libraries.push("-lcodec2");
    }
    linuxCondition[1].link_settings.libraries.push("-lcodec2");

    codec2Target.conditions.push(macCondition, linuxCondition);
    targets.push(codec2Target);
  }

  return { targets };
}

// Main build process
async function main() {
  console.log('🔧 Building native modules...\n');

  // Detect codec2
  console.log('Checking for codec2 library...');
  const codec2Info = detectCodec2();

  if (codec2Info.available) {
    console.log('✓ codec2 found - will build native codec2 module');
    if (codec2Info.includePath) {
      console.log(`  Include: ${codec2Info.includePath}`);
      console.log(`  Lib: ${codec2Info.libPath}`);
    } else if (codec2Info.pkgConfig) {
      console.log('  Using pkg-config');
    } else if (codec2Info.systemInstall) {
      console.log('  Using system installation');
    }
  } else {
    console.log('○ codec2 not found - native codec2 module will not be built');
    console.log('  Voice chat will use JavaScript LPC fallback (lower quality)');
    console.log('');
    console.log('  To enable native codec2:');
    if (os.platform() === 'darwin') {
      console.log('    brew install codec2');
    } else {
      console.log('    sudo apt install libcodec2-dev  # Debian/Ubuntu');
      console.log('    sudo dnf install codec2-devel   # Fedora');
    }
    console.log('  Then run: npm rebuild');
  }
  console.log('');

  // Generate binding.gyp
  const bindingGyp = generateBindingGyp(true, codec2Info);
  const bindingPath = path.join(nativeDir, 'binding.gyp');
  fs.writeFileSync(bindingPath, JSON.stringify(bindingGyp, null, 2) + '\n');
  console.log('Generated binding.gyp');

  // Run node-gyp
  console.log('\nRunning node-gyp rebuild...\n');

  const result = spawnSync('npx', ['node-gyp', 'rebuild'], {
    cwd: nativeDir,
    stdio: 'inherit',
    shell: true,
  });

  if (result.status !== 0) {
    console.error('\n⚠ Native build had errors, but core modules may still work.');
    // Don't exit with error - allow npm install to continue
  } else {
    console.log('\n✓ Native modules built successfully!');

    // Check what was built
    const buildDir = path.join(nativeDir, 'build/Release');
    if (fs.existsSync(buildDir)) {
      const built = fs.readdirSync(buildDir).filter(f => f.endsWith('.node'));
      console.log('  Built:', built.join(', '));
    }
  }
}

main().catch(err => {
  console.error('Build error:', err.message);
  process.exit(0); // Don't fail npm install
});
