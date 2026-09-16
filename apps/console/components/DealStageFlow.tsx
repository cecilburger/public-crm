import { t } from '@/lib/copy';
import type { DealDetail, Stage } from '@/lib/api';

type FlowState = 'done' | 'current' | 'upcoming';

/**
 * A side card next to the deal sheet, same slot Aktivitas takes on the
 * Pelanggan page — the pipeline's own stages read top to bottom, everything
 * already passed filled in and the live one highlighted, so a deal's
 * progress reads as one glance instead of a table of log rows. Lost deals
 * get a red marker of their own instead of pretending the deal is still
 * moving toward Won.
 */
export function DealStageFlow({ stages, deal }: { stages: Stage[]; deal: DealDetail }) {
  const pipelineStages = stages.filter((s) => s.pipeline_id === deal.pipelineId);
  const open = pipelineStages.filter((s) => !s.is_won && !s.is_lost).sort((a, b) => a.position - b.position);
  const won = pipelineStages.find((s) => s.is_won) ?? null;
  const lost = pipelineStages.find((s) => s.is_lost) ?? null;
  const ordered = won ? [...open, won] : open;
  const currentPosition = pipelineStages.find((s) => s.id === deal.stageId)?.position ?? -1;

  const stateOf = (stage: Stage): FlowState => {
    if (stage.is_won) return deal.isWon ? 'current' : 'upcoming';
    if (deal.isLost) return stage.position <= currentPosition ? 'done' : 'upcoming';
    if (stage.id === deal.stageId) return 'current';
    return stage.position < currentPosition ? 'done' : 'upcoming';
  };

  return (
    <div className="activity-panel">
      <h3>{t.dealDetail.stageFlow}</h3>
      <div className="stage-flow-v">
        {ordered.map((stage, i) => {
          const state = stateOf(stage);
          return (
            <div className={`stage-flow-step ${state}`} key={stage.id}>
              <span className="stage-flow-dot">{state === 'done' ? '✓' : i + 1}</span>
              <span className="stage-flow-label">{stage.name}</span>
            </div>
          );
        })}

        {deal.isLost && lost ? (
          <div className="stage-flow-step lost">
            <span className="stage-flow-dot">✕</span>
            <span className="stage-flow-label">
              {lost.name}{deal.lostReason ? ` — ${deal.lostReason}` : ''}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
