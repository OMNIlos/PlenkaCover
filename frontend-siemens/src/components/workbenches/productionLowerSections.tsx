import type { Fact, OrderRollGroup, ProblemCase } from '../../domain/types';

export type ProductionContextSection = {
  key: string;
  eyebrow: string;
  title: string;
  tone?: 'info' | 'warning' | 'critical';
  facts: Fact[];
};

export function ProductionRollMatrix({
  rollGroups,
  selectedGroup,
  onSelectGroup,
}: {
  rollGroups: OrderRollGroup[];
  selectedGroup?: OrderRollGroup;
  onSelectGroup: (groupId: string) => void;
}) {
  if (rollGroups.length === 0) return null;

  return (
    <section className="production-roll-matrix" aria-label="Рулоны по характеристикам">
      <div className="production-roll-matrix-head">
        <div>
          <span className="eyebrow">Рулоны по характеристикам</span>
          <h4>Заказ разбит на группы и конкретные рулоны</h4>
        </div>
        <span>{rollGroups.reduce((sum, group) => sum + group.plannedRolls, 0)} рулона</span>
      </div>
      <div className="production-roll-card-grid" aria-label="Группы рулонов">
        {rollGroups.map((group) => (
          <button
            key={group.id}
            type="button"
            className={`production-roll-card ${selectedGroup?.id === group.id ? 'is-selected' : ''} ${group.blocker ? 'has-blocker' : ''}`}
            onClick={() => onSelectGroup(group.id)}
            aria-pressed={selectedGroup?.id === group.id}
          >
            <span className="production-roll-card-head">
              <strong>{group.title}</strong>
              <em>{group.blocker ?? group.status}</em>
            </span>
            <span className="production-roll-mobile-summary">
              {group.filmType} · {group.micron} · {group.plannedRolls} шт. · {group.plannedNetKg} кг
            </span>
            <small className="production-roll-ids">{group.rollIds.join(', ')}</small>
            <dl>
              <div><dt>Параметры</dt><dd>{group.filmType} · {group.micron} · {group.sizeMeters}</dd></div>
              <div><dt>Рецепт</dt><dd>{group.recipeVersion} · {group.recipe}</dd></div>
              <div><dt>План</dt><dd>{group.plannedRolls} шт. · {group.plannedNetKg} кг · ±{group.tolerancePercent}%</dd></div>
              <div><dt>Линия</dt><dd>{group.appliesFromRollSequence ? `с рулона ${group.appliesFromRollSequence}` : group.machine}</dd></div>
            </dl>
          </button>
        ))}
      </div>
      {selectedGroup && <ProductionRollHandoff selectedGroup={selectedGroup} />}
    </section>
  );
}

function ProductionRollHandoff({ selectedGroup }: { selectedGroup: OrderRollGroup }) {
  return (
    <div className={`production-roll-handoff ${selectedGroup.blocker ? 'severity-warning' : 'severity-info'}`}>
      <p className="production-roll-handoff-summary">
        <strong>{selectedGroup.title}</strong>
        <span>{selectedGroup.filmType}, {selectedGroup.micron}, {selectedGroup.sizeMeters}, {selectedGroup.plannedNetKg} кг · QR на каждый рулон · {selectedGroup.blocker ?? 'блокеров нет'}</span>
      </p>
      <div>
        <span>Выбрано</span>
        <strong>{selectedGroup.title}: {selectedGroup.rollIds.join(', ')}</strong>
      </div>
      <div>
        <span>Что уйдет оператору</span>
        <strong>{selectedGroup.filmType}, {selectedGroup.micron}, {selectedGroup.sizeMeters}, {selectedGroup.plannedNetKg} кг</strong>
      </div>
      <div>
        <span>QR и склад</span>
        <strong>Каждый рулон получает свой QR и отдельный статус приемки</strong>
      </div>
      <div>
        <span>Блокер</span>
        <strong>{selectedGroup.blocker ?? 'Нет'}</strong>
      </div>
    </div>
  );
}

export function ProductionContextMap({
  sections,
  primaryProblem,
}: {
  sections: ProductionContextSection[];
  primaryProblem?: ProblemCase;
}) {
  return (
    <section className="production-context-map" aria-label="Контекст передачи заказ-наряда">
      {sections.map((section) => (
        <article key={section.key} className={`production-context-section production-context-${section.key} ${section.tone ? `severity-${section.tone}` : ''}`}>
          <div className="production-context-section-head">
            <span className="eyebrow">{section.eyebrow}</span>
            <h4>{section.title}</h4>
          </div>
          <p className="production-context-mobile-summary">{productionContextSummary(section)}</p>
          <dl className="production-context-list">
            {section.facts.map((fact) => (
              <div key={`${section.key}-${fact.label}`}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </article>
      ))}
      {primaryProblem && (
        <div className={`production-inline-problem severity-${primaryProblem.severity}`}>
          <strong>{primaryProblem.title}</strong>
          <span>{primaryProblem.reason}</span>
          <small>{primaryProblem.recovery}</small>
        </div>
      )}
    </section>
  );
}

function productionContextSummary(section: ProductionContextSection) {
  return section.facts.slice(0, 2).map((fact) => `${fact.label}: ${fact.value}`).join(' · ');
}
