import type { AgentConfig } from '../config';
import { MassaKProtocol100Scale } from './massa-k/massa-k-scale';
import { SerialProtocol100Exchange } from './massa-k/serial-protocol-100-exchange';
import { SerialScale, SimulatedScale, type ScaleDevice } from './scale';

export function buildScale(config: AgentConfig): ScaleDevice {
  if (config.scaleMode === 'massa-k-protocol-100') {
    const exchange = new SerialProtocol100Exchange({
      path: config.scaleSerialPort!,
      baudRate: config.scaleSerialBaud,
      parity: config.scaleSerialParity,
    });
    return new MassaKProtocol100Scale(exchange, config.scaleReadTimeoutMs);
  }
  if (config.scaleMode === 'serial') {
    return new SerialScale({
      path: config.scaleSerialPort!,
      baudRate: config.scaleSerialBaud,
      pollCommand: config.scalePollCommand,
      readTimeoutMs: config.scaleReadTimeoutMs,
      assumeStable: config.scaleAssumeStable,
    });
  }
  return new SimulatedScale(config.scaleSimulatedOffline);
}
