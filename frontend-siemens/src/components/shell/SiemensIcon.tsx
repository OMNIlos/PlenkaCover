type SiemensIconSize = '12' | '16' | '24' | '32';

export function SiemensIcon({ name, size = '16' }: { name: string; size?: SiemensIconSize }) {
  return <ix-icon name={name} size={size} />;
}
