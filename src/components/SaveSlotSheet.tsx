import { useState } from "react";

import { useStore } from "../state/store";

/**
 * 存档槽管理面板。
 *
 * 支持创建、切换、复制、删除多个存档。
 */
export default function SaveSlotSheet({ onClose }: { onClose: () => void }) {
  const activeSlot = useStore((s) => s.activeSlot);
  const slots = useStore((s) => s.slots);
  const switchSlot = useStore((s) => s.switchSlot);
  const copySlotTo = useStore((s) => s.copySlotTo);
  const deleteSlot = useStore((s) => s.deleteSlot);
  const notify = useStore((s) => s.notify);

  const [newSlotName, setNewSlotName] = useState("");

  const handleCreate = () => {
    const name = newSlotName.trim();
    if (!name) {
      notify("error", "请输入存档名称。");
      return;
    }
    if (slots.includes(name)) {
      notify("error", "该名称已存在。");
      return;
    }
    copySlotTo(name);
    setNewSlotName("");
    notify("info", `已创建存档「${name}」。`);
  };

  const handleSwitch = (slot: string) => {
    if (slot === activeSlot) return;
    switchSlot(slot);
    notify("info", `已切换到存档「${slot}」。`);
    onClose();
  };

  const handleDelete = (slot: string) => {
    if (slot === "default") {
      notify("error", "默认存档不可删除。");
      return;
    }
    deleteSlot(slot);
    notify("info", `已删除存档「${slot}」。`);
  };

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="存档管理"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet">
        <h2>存档管理</h2>
        <p>你可以创建多个独立的地图存档，在不同研究方向上切换。</p>

        {/* 创建新存档 */}
        <div className="settings-section">
          <label className="settings-label" htmlFor="new-slot-name">
            创建新存档
          </label>
          <div className="slot-create-row">
            <input
              id="new-slot-name"
              type="text"
              className="settings-input"
              placeholder="输入存档名称…"
              value={newSlotName}
              onChange={(e) => setNewSlotName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button type="button" onClick={handleCreate}>
              创建
            </button>
          </div>
          <span className="settings-hint">
            新存档会复制当前存档的内容作为起点。
          </span>
        </div>

        {/* 存档列表 */}
        <div className="settings-section">
          <label className="settings-label">已存在的存档</label>
          <ul className="slot-list">
            {slots.map((slot) => (
              <li
                key={slot}
                className={`slot-item${slot === activeSlot ? " slot-active" : ""}`}
              >
                <div className="slot-info">
                  <span className="slot-name">{slot}</span>
                  {slot === activeSlot && (
                    <span className="slot-current">当前</span>
                  )}
                </div>
                <div className="slot-actions">
                  {slot !== activeSlot && (
                    <button
                      type="button"
                      className="slot-switch-btn"
                      onClick={() => handleSwitch(slot)}
                    >
                      切换
                    </button>
                  )}
                  {slot !== "default" && (
                    <button
                      type="button"
                      className="slot-delete-btn"
                      onClick={() => handleDelete(slot)}
                    >
                      删除
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="sheet-actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}