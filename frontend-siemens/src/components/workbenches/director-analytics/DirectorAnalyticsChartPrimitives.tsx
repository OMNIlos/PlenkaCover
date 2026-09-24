import { useLayoutEffect, useRef, type CSSProperties } from 'react';

import {
  directorChartMagnitudePercent,
  type DirectorChartScale,
  type DirectorChartUnit,
} from '../../../domain/runtime/directorAnalyticsPresentation';
import { formatNumber } from './directorAnalyticsFormatters';

type DirectorChartYAxisProps = {
  label: string;
  scale: DirectorChartScale;
  unit: DirectorChartUnit;
  side: 'left' | 'right';
};

export function DirectorChartYAxis({ label, scale, unit, side }: DirectorChartYAxisProps) {
  const tickAttribute = unit === 'kg' ? 'data-axis-tick-kg' : 'data-axis-tick-rolls';

  return (
    <div
      className={`director-analytics-y-axis is-${side}`}
      role="group"
      aria-label={label}
    >
      <strong>{unit === 'kg' ? 'кг' : 'шт.'}</strong>
      <div
        className={`director-analytics-y-axis-ticks${scale.maximum === 0 ? ' is-zero' : ''}`}
      >
        {scale.ticks.map((value, index) => (
          <span key={`${index}-${value}`} {...{ [tickAttribute]: value }}>
            {formatNumber(value)}
          </span>
        ))}
      </div>
    </div>
  );
}

type DirectorBarValueKind = 'kg' | 'rolls' | 'count';

export type DirectorBarPlotBar = {
  id: string;
  className: string;
  label: string;
  scale: DirectorChartScale;
  unit: DirectorChartUnit;
  value: number;
  valueKind: DirectorBarValueKind;
};

export type DirectorBarPlotGroup = {
  id: string;
  label: string;
  bars: DirectorBarPlotBar[];
};

type DirectorBarPlotProps = {
  ariaLabel: string;
  annotationMode?: 'maximum' | 'all';
  groups: DirectorBarPlotGroup[];
  variant?: 'default' | 'comparison';
};

function dataValueAttribute(kind: DirectorBarValueKind): string {
  if (kind === 'kg') return 'data-value-kg';
  if (kind === 'rolls') return 'data-value-rolls';
  return 'data-value-count';
}

function barAriaLabel(bar: DirectorBarPlotBar): string {
  const unit = bar.unit === 'kg' ? 'кг' : 'шт.';
  const state = bar.value < 0 ? '; отрицательное значение' : '';
  return `${bar.label}: ${formatNumber(bar.value)} ${unit}${state}`;
}

type DirectorMaxAnnotation = {
  groupId: string;
  groupIndex: number;
  bar: DirectorBarPlotBar;
  barIndex: number;
  barCount: number;
  magnitudePercent: number;
};

function directorAnnotations(groups: DirectorBarPlotGroup[]): DirectorMaxAnnotation[] {
  return groups.flatMap((group, groupIndex) =>
    group.bars.flatMap((bar, barIndex) => {
      if (!Number.isFinite(bar.value) || bar.value <= 0) return [];
      return [
        {
          groupId: group.id,
          groupIndex,
          bar,
          barIndex,
          barCount: group.bars.length,
          magnitudePercent: directorChartMagnitudePercent(bar.value, bar.scale),
        },
      ];
    }),
  );
}

function firstDirectorMaxAnnotation(
  annotations: DirectorMaxAnnotation[],
): DirectorMaxAnnotation | null {
  return annotations.reduce<DirectorMaxAnnotation | null>(
    (maximum, annotation) =>
      maximum === null || annotation.magnitudePercent > maximum.magnitudePercent
        ? annotation
        : maximum,
    null,
  );
}

function maxAnnotationStyle(annotation: DirectorMaxAnnotation): CSSProperties {
  const vertexTop = 150 - (annotation.magnitudePercent / 100) * 150;
  const labelTop = Math.max(2, vertexTop - 24);
  const leaderHeight = Math.max(6, vertexTop - labelTop - 13);
  const barCenterOffset = (annotation.barIndex - (annotation.barCount - 1) / 2) * 26;
  const style = {
    left: `clamp(20px, calc(50% + ${barCenterOffset}px), calc(100% - 20px))`,
    top: `${labelTop}px`,
    '--director-max-leader-height': `${leaderHeight}px`,
  } as CSSProperties;
  return style;
}

function maxAnnotationValue(bar: DirectorBarPlotBar): string {
  return `${formatNumber(bar.value)} ${bar.unit === 'kg' ? 'кг' : 'шт.'}`;
}

export function DirectorBarPlot({
  ariaLabel,
  annotationMode = 'maximum',
  groups,
  variant = 'default',
}: DirectorBarPlotProps) {
  const comparisonClass = variant === 'comparison' ? ' is-comparison' : '';
  const plotRef = useRef<HTMLDivElement>(null);
  const groupIdentity = JSON.stringify(groups.map(({ id }) => id));
  const positiveAnnotations = directorAnnotations(groups);
  const maximum = firstDirectorMaxAnnotation(positiveAnnotations);
  const annotations =
    annotationMode === 'all' ? positiveAnnotations : maximum === null ? [] : [maximum];

  useLayoutEffect(() => {
    const plot = plotRef.current;
    if (plot) plot.scrollLeft = Math.max(0, plot.scrollWidth - plot.clientWidth);
  }, [groupIdentity]);

  return (
    <div
      ref={plotRef}
      className={`director-analytics-chart${comparisonClass}`}
      role="img"
      aria-label={ariaLabel}
    >
      {groups.map((group, groupIndex) => (
        <div
          key={group.id}
          className={`director-analytics-bar-group${comparisonClass}`}
          data-chart-group-id={group.id}
        >
          <div className="director-analytics-bar-pair">
            {group.bars.map((bar) => {
              const isNegative = bar.value < 0;
              const valueAttribute = dataValueAttribute(bar.valueKind);
              return (
                <div
                  key={bar.id}
                  className={`director-analytics-bar ${bar.className}${
                    isNegative ? ' is-negative is-negative-pattern' : ''
                  }`}
                  style={{
                    height: `${directorChartMagnitudePercent(bar.value, bar.scale)}%`,
                  }}
                  aria-label={barAriaLabel(bar)}
                  data-series-id={bar.id}
                  {...{ [valueAttribute]: bar.value }}
                />
              );
            })}
          </div>
          {annotations
            .filter((annotation) => annotation.groupIndex === groupIndex)
            .map((annotation) => {
              const identity = `${annotation.groupId}:${annotation.bar.id}`;
              return (
                <span
                  key={identity}
                  className="director-analytics-max-annotation"
                  style={maxAnnotationStyle(annotation)}
                  data-bar-annotation={identity}
                  data-max-annotation={annotation === maximum ? identity : undefined}
                  aria-hidden="true"
                >
                  <strong>{maxAnnotationValue(annotation.bar)}</strong>
                  <i className="director-analytics-max-leader" />
                </span>
              );
            })}
          <span>{group.label}</span>
        </div>
      ))}
    </div>
  );
}
