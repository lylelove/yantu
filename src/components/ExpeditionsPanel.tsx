import { useStore } from "../state/store";

/**
 * Expeditions — the derived objectives.
 *
 * Deliberately framed as invitations rather than tasks: no counters ticking
 * toward a reward, no streak to protect. They are read off the map's current
 * shape, so they change as the map does and vanish once the situation they
 * described is gone. Nothing here can be farmed, because there is nothing to
 * farm — the only "reward" is a wider map.
 */

const KIND_LABELS: Record<string, string> = {
  "enter-region": "开辟",
  "trace-citations": "回溯",
  "read-foundational": "奠基",
  "cross-bridge": "架桥",
  "close-gap": "补全",
};

export default function ExpeditionsPanel() {
  const world = useStore((s) => s.world);
  const select = useStore((s) => s.select);
  const hover = useStore((s) => s.hover);

  if (world.quests.length === 0) {
    return (
      <div className="panel-empty">
        <p>暂时没有值得推荐的探索方向。</p>
        <p>读完几篇、或者联网扩展一下，新的方向就会浮现。</p>
      </div>
    );
  }

  return (
    <ul className="quest-list">
      {world.quests.map((quest) => (
        <li key={quest.id} className="quest">
          <span className="quest-kind">{KIND_LABELS[quest.kind] ?? "探索"}</span>
          <h3>{quest.title}</h3>
          <p>{quest.detail}</p>

          {quest.goal > 1 && (
            <p className="quest-progress">
              目标 {quest.goal} 篇 · 可选 {quest.targets.length} 篇
            </p>
          )}

          <ul className="quest-targets">
            {quest.targets.slice(0, 4).map((id) => {
              const paper = world.papers.find((p) => p.id === id);
              if (!paper) return null;
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="link"
                    onClick={() => select(id)}
                    onMouseEnter={() => hover(id)}
                    onMouseLeave={() => hover(null)}
                  >
                    {paper.title}
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
