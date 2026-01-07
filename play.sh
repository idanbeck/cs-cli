#!/bin/bash
# Launch CS-CLI with stderr redirected to suppress audio library warnings
exec npx tsx src/index.tsx 2>/dev/null
