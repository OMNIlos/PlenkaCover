import type { CommercialPerformanceSection } from '../../api/commercialPerformance';
import {
  BUSINESS_PERFORMANCE_SECTIONS,
  BusinessPerformanceWorkspace,
  type BusinessControlRange,
} from '../business-performance/BusinessPerformanceWorkspace';

export const COMMERCIAL_PERFORMANCE_SECTIONS = BUSINESS_PERFORMANCE_SECTIONS;
export type CommercialControlRange = BusinessControlRange;

export function CommercialPerformanceWorkspace({
  section,
}: {
  section: CommercialPerformanceSection;
}) {
  return <BusinessPerformanceWorkspace section={section} role="commercial" />;
}
