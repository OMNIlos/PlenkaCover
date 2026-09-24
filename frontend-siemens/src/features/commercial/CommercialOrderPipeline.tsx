import type {
  CommercialPipelineProjection,
  CommercialPipelineStep,
} from './commercialPipeline';

export function CommercialOrderPipeline({
  projection,
  onAction,
  feedback,
}: {
  projection: CommercialPipelineProjection;
  onAction?: () => void;
  feedback?: {
    status: 'loading' | 'success' | 'error';
    message: string;
  };
}) {
  const currentIndex = projection.steps.findIndex(({ state }) =>
    ['current', 'blocked', 'issue'].includes(state),
  );

  return (
    <section className="commercial-pipeline" aria-label="Путь заказа">
      <ol aria-label="Этапы заказа">
        {projection.steps.map((step, index) => (
          <PipelineStep
            key={step.id}
            step={step}
            index={index}
            current={index === currentIndex}
          />
        ))}
      </ol>
      {projection.focus.mode === 'action' && projection.focus.actionLabel && onAction && (
        <div className="commercial-pipeline-command">
          <button type="button" disabled={feedback?.status === 'loading'} onClick={onAction}>
            {feedback?.status === 'loading' ? feedback.message : projection.focus.actionLabel}
          </button>
        </div>
      )}
      {feedback && (
        <p
          className={`commercial-pipeline-feedback is-${feedback.status}`}
          role={feedback.status === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      )}
    </section>
  );
}

function PipelineStep({
  step,
  index,
  current,
}: {
  step: CommercialPipelineStep;
  index: number;
  current: boolean;
}) {
  return (
    <li
      className={`commercial-pipeline-step is-${step.state}`}
      aria-current={current ? 'step' : undefined}
    >
      <span className="commercial-pipeline-marker" aria-hidden="true">
        {step.state === 'done' ? '✓' : index + 1}
      </span>
      <span>
        <strong>{step.title}</strong>
        {step.note && <small>{step.note}</small>}
      </span>
    </li>
  );
}
