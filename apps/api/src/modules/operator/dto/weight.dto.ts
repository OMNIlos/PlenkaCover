import { OperatorOperationDto } from './operation.dto';

/**
 * A standard capture accepts no physical value or device selector. The server binds the active
 * post to its scale; big-bag weighing remains the separate audited manual exception.
 */
export class WeightCaptureDto extends OperatorOperationDto {}
