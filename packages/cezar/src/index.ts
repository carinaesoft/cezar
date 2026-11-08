#!/usr/bin/env node
// The bin entry; the CLI itself is main.ts. `cez mcp` (spec 2026-11-08-cez-mcp) is routed first so
// its client gets an answer without the cockpit's module graph loading; its stdout is JSON-RPC only.
if (process.argv[2] === 'mcp') {
  console.log = console.error;
  const { runMcpCommand } = await import('./mcp/mcp-cli.ts');
  process.exitCode = await runMcpCommand(process.argv.slice(3));
} else {
  await import('./main.ts');
}
export {};
