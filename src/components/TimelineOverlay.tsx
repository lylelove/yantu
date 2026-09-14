import { useCallback, useEffect, useMemo, useState } from "react";

import { useStore } from "../state/store";

/**
 * 阅读轨迹回放控件。
 *
 * 显示在底图右下角（地图控制按钮上方），提供时间轴滑块。
 * 拖动滑块时，地图只显示截止到该时间点已点亮的论文。
 */
export default function TimelineOverlay() {
  const world = useStore((s) => s.world);
  const playbackTime = useStore((s) => s.playbackTime);
  const setPlaybackTime = useStore((s) => s.setPlaybackTime);

  const [playing, setPlaying] = useState(false);

  // 收集所有 litAt 时间戳
  const timestamps = useMemo(() => {
    const times = new Set<string>();
    for (const p of world.papers) {
      const pr = world.progress[p.id];
      if (pr?.litAt) times.add(pr.litAt);
    }
    return Array.from(times).sort();
  }, [world.papers, world.progress]);

  const hasHistory = timestamps.length > 0;

  // 当前滑块位置在 timestamps 中的索引
  const currentIndex = playbackTime ? timestamps.indexOf(playbackTime) : timestamps.length - 1;
  const sliderMax = Math.max(0, timestamps.length - 1);

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const idx = parseInt(e.target.value, 10);
      setPlaybackTime(timestamps[idx] ?? null);
    },
    [timestamps, setPlaybackTime],
  );

  // 播放 / 暂停
  useEffect(() => {
    if (!playing || timestamps.length === 0) return;
    const idx = playbackTime ? timestamps.indexOf(playbackTime) : -1;
    if (idx >= timestamps.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      const nextIdx = idx + 1;
      if (nextIdx < timestamps.length) {
        setPlaybackTime(timestamps[nextIdx]);
      } else {
        setPlaying(false);
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [playing, playbackTime, timestamps, setPlaybackTime]);

  const togglePlay = () => {
    if (!hasHistory) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    // 如果已经播完了，从头开始
    if (playbackTime && currentIndex >= timestamps.length - 1) {
      setPlaybackTime(timestamps[0] ?? null);
    } else if (!playbackTime && timestamps.length > 0) {
      setPlaybackTime(timestamps[0] ?? null);
    }
    setPlaying(true);
  };

  const resetTimeline = () => {
    setPlaying(false);
    setPlaybackTime(null);
  };

  if (!hasHistory) return null;

  const litCount = playbackTime
    ? world.papers.filter((p) => {
        const pr = world.progress[p.id];
        return pr?.litAt && pr.litAt <= playbackTime;
      }).length
    : world.stats.lit;

  return (
    <div className={`timeline-overlay${playbackTime ? " active" : ""}`}>
      <div className="timeline-header">
        <span className="timeline-label">
          {playbackTime ? `回放到 ${playbackTime.slice(0, 10)}` : "完整地图"}
        </span>
        <span className="timeline-count">{litCount} 篇已点亮</span>
      </div>
      <div className="timeline-controls">
        <button
          type="button"
          className="timeline-btn"
          onClick={togglePlay}
          title={playing ? "暂停" : "播放轨迹"}
          aria-label={playing ? "暂停回放" : "开始回放"}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <input
          type="range"
          className="timeline-slider"
          min={0}
          max={sliderMax}
          value={currentIndex >= 0 ? currentIndex : sliderMax}
          onChange={handleSliderChange}
          aria-label="回放时间轴"
        />
        <button
          type="button"
          className="timeline-btn"
          onClick={resetTimeline}
          title="回到完整地图"
          aria-label="回到完整地图"
        >
          ⤢
        </button>
      </div>
    </div>
  );
}