import { brandMarkAlt, brandMarkPath, brandName } from '../../brand';

type BrandMarkProps = {
  label?: 'hidden' | 'wordmark';
};

export function BrandMark({ label = 'hidden' }: BrandMarkProps) {
  return (
    <span className={`brand-mark brand-mark-${label}`} aria-label={label === 'hidden' ? brandName : undefined}>
      <img src={brandMarkPath} alt="" aria-hidden="true" />
      <span className="sr-only">{brandMarkAlt}</span>
    </span>
  );
}
