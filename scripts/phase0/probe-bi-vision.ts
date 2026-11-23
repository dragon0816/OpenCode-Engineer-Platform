import { gatewayAliases, gatewaySettings, startGateway } from '../../apps/adapter/src/opencode/gateway.ts';
import { ModelSeat } from '../../apps/adapter/src/opencode/model-seat.ts';
import { ocrVision, visionModel } from '../../apps/adapter/src/opencode/ocr-vision.ts';

// The probe sends only the same synthetic image as the runtime's capability check.
if (process.env.OEP_LIVE_GATEWAY === '1') {
  const alias = process.env.OEP_MODEL_ALIAS ?? gatewayAliases[0];
  try {
    if (!visionModel(alias)) throw new Error('Unsupported model family');
    const relay = await startGateway({ ...gatewaySettings(), alias, web: true, trace: () => {} });
    try {
      const result = await ocrVision(relay, new ModelSeat(), [alias], () => alias).probeSupport(alias, AbortSignal.timeout(40_000));
      if (result === 'unavailable') process.exitCode = 2;
      else process.stdout.write(`${result} ${alias}\n`);
    } finally { await relay.close(); }
  } catch { process.exitCode = 2; }
}
