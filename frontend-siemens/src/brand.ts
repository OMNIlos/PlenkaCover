export const brandName = 'Плёнки Контур';
export const brandMarkPath = '/brand/logo-plenki.svg';
export const brandMarkAlt = 'Знак Плёнки Контур';

export const brandDirections = [
  {
    id: 'process-contour',
    name: 'Контур процесса',
    status: 'reference',
    description: 'Замкнутая линия управления с рулоном и точкой контроля; оставить как более системный, но менее визуально чистый вариант.',
  },
  {
    id: 'material-flow',
    name: 'Поток материала',
    status: 'selected',
    description: 'Рулон пленки переходит в спокойную производственную ленту; основной Industrial Calm знак для shell и favicon.',
  },
  {
    id: 'trace-line',
    name: 'Trace line',
    status: 'reference',
    description: 'Акцент на QR, событиях и прослеживаемости; оставить как вариант для audit/traceability артефактов.',
  },
] as const;
