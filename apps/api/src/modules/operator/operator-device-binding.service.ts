import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  PostDeviceReadinessService,
  type PhysicalWorkflow,
} from '../../common/device-readiness/post-device-readiness.service';

type DeviceKind = 'scale' | 'printer' | 'scanner';
type DeviceBindingClient = Pick<Prisma.TransactionClient, 'post'>;

const WORKFLOW_BY_KIND: Record<DeviceKind, PhysicalWorkflow> = {
  scale: 'operator.weight.capture',
  printer: 'operator.roll-label.print',
  scanner: 'operator.qr.verify',
};

@Injectable()
export class OperatorDeviceBindingService {
  constructor(private readonly readiness: PostDeviceReadinessService) {}

  async resolve(postId: string, kind: DeviceKind, client?: DeviceBindingClient) {
    const result = await this.readiness.require(postId, WORKFLOW_BY_KIND[kind], client);
    return result.devices.find((device) => device.kind === kind)!;
  }
}
