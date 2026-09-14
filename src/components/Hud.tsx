import { useStore } from "../state/store";

/**
 * The status readout.
 *
 * Numbers here describe the *map*, not the player. There is no level, no score,
 * no streak — those would reward opening the app rather than understanding
 * something. "Vision radius" and "regions entered" are honest measures of how
 * far the user can currently see, and they can go down as well as up when new
 * territory arrives, which is exactly right.
 */
export default function Hud() {
  const stats = useStore((s) => s.world.stats);

  const percent = Math.round(stats.coverage * 100);

  return (
    <dl className="hud" aria-label="探索状态">
      <div className="hud-item">
        <dt>已点亮</dt>
        <dd className="hud-lit">
          {stats.lit}
          <span className="hud-sub">/ {stats.known}</span>
        </dd>
      </div>

      <div className="hud-item">
        <dt>灯塔</dt>
        <dd className="hud-beacon">{stats.beacons}</dd>
      </div>

      <div className="hud-item">
        <dt>视野边缘</dt>
        <dd className="hud-frontier">{stats.frontier}</dd>
      </div>

      <div className="hud-item">
        <dt>已踏入区域</dt>
        <dd>
          {stats.regionsEntered}
          <span className="hud-sub">/ {stats.regionsKnown}</span>
        </dd>
      </div>

      <div className="hud-item hud-wide">
        <dt>可见范围覆盖</dt>
        <dd>
          <span className="hud-progress" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </span>
          <span className="hud-sub">{percent}%</span>
        </dd>
      </div>
    </dl>
  );
}
