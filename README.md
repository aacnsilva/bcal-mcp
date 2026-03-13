# Business Central AL MCP

Local MCP server and VS Code bridge for Business Central AL development workflows.

## Components

- `server/`: `stdio` MCP server with local project inspection, ALTool build orchestration, and VS Code bridge integration.
- `vscode-bridge/`: companion VS Code extension that exposes selected workspace and AL-extension-backed capabilities over a local JSON-RPC socket.

## Current capabilities

- Project manifest and launch profile inspection
- AL object catalog generation from local source files
- Structured diagnostics, symbol, reference, and publish requests through the bridge
- ALTool-backed build/package orchestration
- MCP resources for workspace manifest, launch profiles, and object catalog

## Notes

- The project is Bun-first. Use `bun run start`, `bun test`, and `bun run build`.
