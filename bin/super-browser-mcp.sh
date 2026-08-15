#!/bin/bash
# Wrapper: super-browser-mcp — usa o node do user, evita path drift nos configs
exec /Users/augustosilva/.opencode/bin/node /Volumes/disco1tb/tools/super-browser-mcp/src/index.js "$@"
