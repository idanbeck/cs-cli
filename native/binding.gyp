{
  "targets": [
    {
      "target_name": "keyboard",
      "sources": ["keyboard_mac.c"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "10.15"
          },
          "link_settings": {
            "libraries": [
              "-framework CoreGraphics",
              "-framework CoreFoundation",
              "-framework ApplicationServices"
            ]
          }
        }]
      ]
    },
    {
      "target_name": "renderer",
      "sources": ["renderer_simd.c"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "OTHER_CFLAGS": [
              "-O3",
              "-ffast-math",
              "-march=native",
              "-funroll-loops",
              "-ftree-vectorize",
              "-fno-strict-aliasing"
            ],
            "MACOSX_DEPLOYMENT_TARGET": "10.15",
            "GCC_OPTIMIZATION_LEVEL": "3"
          }
        }],
        ["OS=='linux'", {
          "cflags": [
            "-O3",
            "-ffast-math",
            "-march=native",
            "-funroll-loops",
            "-ftree-vectorize",
            "-fno-strict-aliasing",
            "-flto"
          ]
        }]
      ]
    }
  ]
}
