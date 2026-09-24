import * as path from 'node:path';
import { GatewayAgent } from './agent';
import { GatewayApiClient } from './api-client';
import { runConfigCheck } from './check-config';
import type { AgentDevices } from './commands';
import { loadConfig, type AgentConfig } from './config';
import {
  CupsZplPrinter,
  SimulatedPrinter,
  Tcp9100Printer,
  WindowsCommandPrinter,
  type PrinterDevice,
} from './devices/printer';
import { buildScale } from './devices/scale-factory';
import { HidScanner } from './devices/scanner';
import { log } from './logger';
import { OfflineBuffer } from './offline-buffer';
import { ResultOutbox } from './result-outbox';

function buildPrinter(cfg: AgentConfig): PrinterDevice {
  const profile = { dpi: cfg.printerDpi, maxWidthDots: cfg.printerMaxWidthDots };
  if (cfg.printerMode === 'tcp9100') {
    return new Tcp9100Printer(cfg.printerTcpHost!, cfg.printerTcpPort, profile);
  }
  if (cfg.printerMode === 'windows-command') {
    return new WindowsCommandPrinter(
      cfg.printerWindowsCommand!,
      path.join(cfg.bufferDir, 'labels'),
      profile,
    );
  }
  if (cfg.printerMode === 'cups-zpl') {
    return new CupsZplPrinter(
      {
        primary: cfg.printerCupsQueue!,
        warehouse: cfg.printerWarehouseCupsQueue,
      },
      path.join(cfg.bufferDir, 'labels'),
      profile,
    );
  }
  return new SimulatedPrinter(profile, cfg.printerSimulatedFail);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const devices: AgentDevices = {
    scale: buildScale(cfg),
    scaleDeviceId: cfg.scaleDeviceId,
    printer: buildPrinter(cfg),
    printerDeviceId: cfg.printerDeviceId,
    printerMode: cfg.printerMode,
    scanner: new HidScanner(cfg.scannerHidPath),
    scannerDeviceId: cfg.scannerDeviceId,
  };
  const buffer = new OfflineBuffer(path.join(cfg.bufferDir, 'events.jsonl'));
  buffer.load();
  const results = new ResultOutbox(path.join(cfg.bufferDir, 'command-results.jsonl'));
  results.load();
  const api = new GatewayApiClient(cfg.apiUrl, cfg.agentToken);
  const agent = new GatewayAgent(cfg, api, devices, buffer, results);
  await agent.start();

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    void agent.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--check-config') {
  process.exitCode = runConfigCheck();
} else if (args.length > 0) {
  log.error('unsupported gateway command');
  process.exitCode = 2;
} else {
  main().catch((err) => {
    log.error('gateway agent failed to start', { error: String(err) });
    process.exit(1);
  });
}
